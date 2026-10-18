"""
Alaska.py — Parse Alaska APOC raw exports into canonical cleaned CSVs.

Raw files (all in data/Alaska/raw/):
  CDIncome_YYYY.csv      — contributions received
  CDExpense_YYYY.csv     — expenditures made
  CDCandidates_all.csv   — candidate registry
  GRForms_YYYY.csv       — group/committee registrations (bulk export)
  CRForms_YYYY.csv       — candidate registrations (bulk export, added 2026-09-23)
  DOECandidates_<YY><prim|genr>_p<N>.html
                         — Division of Elections candidate list pages; the
                           source of district, party and incumbency for
                           House and Senate candidates

Output (data/Alaska/cleaned/):
  contributions.csv.gz, expenditures.csv.gz, committees.csv.gz,
  candidates.csv.gz, loans_debts.csv.gz
"""

import csv
import gzip
import re
import sys
import time
import unicodedata
from pathlib import Path
from datetime import datetime, date

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from src.reporting.logger import get_logger
from src.aliases import canonical_party, expand_nickname

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import columns as C
import utils

csv.field_size_limit(sys.maxsize)

# =============================== Paths ================================
PROJECT_ROOT = Path(__file__).resolve().parents[3]
RAW_DIR      = PROJECT_ROOT / "data" / "Alaska" / "raw"
CLEAN_DIR    = PROJECT_ROOT / "data" / "Alaska" / "cleaned"
CLEAN_DIR.mkdir(parents=True, exist_ok=True)

STATE          = "AK"
MAX_VALID_YEAR = date.today().year + 2


# ============================== Helpers ===============================
def clean(val) -> str:
    """Strip whitespace and coerce None to empty string."""
    return (val or "").strip()


def committee_key(name: str) -> str:
    """Normalize a committee name to a lowercase, punctuation-free key for dedup/matching."""
    name = clean(name).lower()

    # normalize punctuation/spacing
    name = re.sub(r"[^\w\s]", "", name)
    name = re.sub(r"\s+", " ", name)

    return name.strip()


def parse_amount(val: str) -> str:
    """Parse a dollar amount string to a plain numeric string; parentheses become negative. Returns '' on failure."""
    v = (val or "").strip().replace("$", "").replace(",", "")
    if not v:
        return ""
    if v.startswith("(") and v.endswith(")"):
        v = "-" + v[1:-1]
    try:
        float(v)
        return v
    except ValueError:
        return ""


def parse_date(val: str) -> str:
    """MM/DD/YYYY or YYYY-MM-DD → YYYY-MM-DD. Returns '' on failure or out-of-range year."""
    v = (val or "").strip()
    if not v:
        return ""
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            d = datetime.strptime(v, fmt)
            if d.year < 1970 or d.year > MAX_VALID_YEAR:
                return ""
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def build_name(last: str, first: str) -> str:
    """Combine last/first into 'First Last'. Treats 'N/A' first names as absent (Alaska org placeholder)."""
    last  = (last  or "").strip()
    first = (first or "").strip()
    if first.upper() in ("N/A", "NA", "N.A."):
        first = ""
    if first and last:
        return f"{first} {last}"
    return first or last


def contributor_type_from_first_name(first: str) -> str:
    """'Individual' if a real first name is present, 'Non-Individual'
    otherwise -- same convention/literal strings as ohio.py and
    michigan.py use for this identical raw-data shape (a separate First
    Name column distinct from Last/Business Name).

    2026-09-24: contributions.csv's contributor_type used to be a direct
    copy of the raw CDIncome file's "Filer Type" column -- but that
    column describes the RECEIVING committee's own registration type
    ("Candidate" vs "Group" vs "Entity"), not the actual contributor's
    nature. Every donor to any AK candidate committee was showing up as
    contributor_type="Candidate" (a PAC or an individual, indistinguishably)
    and every donor to a PAC/ballot-measure committee as "Group" --
    silently breaking the Individual vs. Non-Individual donor split
    everywhere downstream (materialized_views.sql's
    candidate_contribution_top/latest_individual_donors, which filter on
    contributor_type = 'Individual' exactly). Confirmed live 2026-09-24:
    real named individual donors to Jonathan Kreiss-Tomkins's campaign
    (Anthropic researchers Drake Thomas, Daniel Ziegler, Jan Leike among
    them) were all mislabeled "Candidate" instead of "Individual".

    Verified against AK's own raw data before relying on this: of
    141,165 raw CDIncome rows, 139,086 have a populated First Name and
    2,079 don't; every no-first-name row sampled was a real PAC/org name
    ("Alaska Laborers Local 341 PAC", "Alaska AFL-CIO Gaming Account",
    etc.), not a misformatted person. Same first/last-name-column shape
    Ohio and Michigan already classify this way (and whose correctly-
    labeled output is itself part of what trained
    contributor_type_nb.py's model) -- that NB classifier is for a state
    like Florida whose raw export has no separated name field at all to
    check; AK doesn't need it. Reuses build_name()'s own N/A-placeholder
    handling (Alaska's org placeholder in the First Name column) so a
    First Name of "N/A"/"NA"/"N.A." doesn't get misread as a real name."""
    first = (first or "").strip()
    if first.upper() in ("N/A", "NA", "N.A."):
        first = ""
    return "Individual" if first else "Non-Individual"


def strip_html_br(val: str) -> str:
    """Some AK IE Expenditures exports concatenate the filer's officer
    name onto the group name with a literal HTML tag -- e.g. 'Alaska
    Republican Party<br/>Strutz, Christy Patrice' -- confirmed present in
    12,543/41,871 (~30%) of IEExpenditures Filer Name values (2012-era
    rows especially), confined to that one column (Recipient, Candidate/
    Proposition, and IEContributions' Filer/Filer Name/Contributor are all
    clean). Keep only the group/committee name that precedes the tag.
    """
    return re.split(r"<br\s*/?>", val or "", maxsplit=1, flags=re.IGNORECASE)[0].strip()


def normalize_candidate(val: str) -> str:
    """Strip whitespace from a raw candidate string."""
    return (val or "").strip()


def year_from_filename(path: Path) -> str:
    """Extract the first 4-digit year from a filename, e.g. CDIncome_2022.csv → '2022'."""
    m = re.search(r"(\d{4})", path.name)
    return m.group(1) if m else ""


def raw_files(pattern: str) -> list[Path]:
    """Return non-empty raw files matching a glob pattern, sorted by name."""
    return sorted(
        (f for f in RAW_DIR.glob(pattern) if f.stat().st_size > 0),
        key=lambda p: p.name,
    )


def open_writer(filename: str, fieldnames: list):
    """Open a gzipped CSV writer in CLEAN_DIR; extra fields are dropped, missing fields default to ''."""
    fh = gzip.open(CLEAN_DIR / filename, "wt", encoding="utf-8", newline="")
    w  = csv.DictWriter(fh, fieldnames=fieldnames,
                        extrasaction="ignore", restval="")
    w.writeheader()
    return fh, w


# ========================= CR forms bulk registry ======================
def load_cr_forms_registry() -> dict[str, dict]:
    """
    Candidate registrations from the CRForms_YYYY.csv bulk exports.

    Returns a dict keyed by committee_key(first + " " + last), and also by
    committee_key(committee name) when that column is populated, so
    "Andy Josephson for State House" can match. Most recent Submitted
    date wins per key.
    """
    registry: dict[str, dict] = {}

    def _update(key: str, row: dict) -> None:
        existing = registry.get(key)
        if existing is None:
            registry[key] = row
            return
        try:
            new_date = datetime.strptime(row["submission_date"],      "%m/%d/%Y")
            old_date = datetime.strptime(existing["submission_date"], "%m/%d/%Y")
            if new_date > old_date:
                registry[key] = row
        except (ValueError, KeyError):
            pass

    for path in raw_files("CRForms_*.csv"):
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            for row_num, row in enumerate(csv.DictReader(f), start=2):
                first = clean(row.get("First Name", ""))
                last  = clean(row.get("Last Name",  ""))
                if not (first or last):
                    continue

                entry = {
                    "candidate_display_name": clean(row.get("Display Name",   "")),
                    "treasurer_name":         clean(row.get("Treasurer Name", "")),
                    "city":                   clean(row.get("City", "")),
                    "zip":                    clean(row.get("Zip",  "")),
                    "submission_date":        clean(row.get("Submitted", "")),
                    "_raw_file":              path.name,
                    "_row_num":               row_num,
                }

                _update(committee_key(first + " " + last), entry)

                cmte = clean(row.get("Committee", ""))
                if cmte:
                    _update(committee_key(cmte), entry)

    return registry


# ================= Division of Elections candidate list =================
# APOC's exports name no legislative district and leave party blank for
# House and Senate candidates. The Division of Elections candidate list
# (saved by scrapers/alaska.py) groups candidates under district headings
# and packs party, incumbency and status into the name cell. Each office is
# a <section class="candidates-table"> with an <h4> heading ('SENATE
# DISTRICT A' on the general list, 'STATE HOUSE DISTRICT 01' on the
# primary) and a table whose first column is the name cell:
#     Stedman, Bert (Registered Republican) (Certified)  *Incumbent*
#     Smith, Ann (Nonpartisan) (Denied)
# Sections for other offices (governor, U.S. House and Senate, courts)
# come before and after the legislative ones.
#
# Matching to APOC requires election year, chamber and surname to agree:
#   exact  the given names are equal
#   high   the given names are nickname-equivalent (src/aliases/nicknames.csv),
#          or the campaign addresses agree (same PO Box or house number).
#          A compound surname also matches on its last part here, for
#          'Musgrove-Short' on APOC and 'Short' on the list.
# The address check covers names the two systems spell differently
# ('Hezekiah' / 'Ky', 'Stephan' / 'Steve') without loosening the name rule.
# A match is used only when every list entry it hits names the same
# district; two districts for one name is left blank rather than guessed. Senate districts
# are letters A-T and are written as 1-20, the convention the serving
# repo's OpenStates and ballot loaders use for the same seats.

DOE_PAGE_RE     = re.compile(r"^DOECandidates_(\d{2})(prim|genr)_p(\d+)\.html$")
_DOE_HEADING_RE = re.compile(r"\b(SENATE|HOUSE)\s+DISTRICT\s+([0-9]+|[A-Z])\b", re.IGNORECASE)
_DOE_PAREN_RE   = re.compile(r"\(([^)]*)\)")
_DOE_QUOTED_RE  = re.compile(r"[\"“”]([^\"“”]+)[\"“”]")
# A parenthesised value is a party only in these shapes; anything else
# ('Certified', 'Denied', 'POFD was not on file by the deadline') is a
# filing status.
_DOE_PARTY_RE   = re.compile(r"^(?:registered\s+(.+)|(nonpartisan|undeclared))$", re.IGNORECASE)
_DOE_PREFIX_RE  = re.compile(r"^(?:withdrawn|certified\s+write-in|write-in)\b[:\s]*", re.IGNORECASE)
_NAME_SUFFIXES  = {"JR", "SR", "II", "III", "IV", "V"}
DOE_PARTY_SOURCE = "ak_doe_candidates"


def doe_district(chamber: str, raw: str) -> str:
    """'HOUSE', '01' -> '1'; 'SENATE', 'C' -> '3'. '' for anything else."""
    raw = (raw or "").strip().upper()
    if raw.isdigit():
        return str(int(raw))
    if chamber == "SENATE" and len(raw) == 1 and "A" <= raw <= "T":
        return str(ord(raw) - ord("A") + 1)
    return ""


def _fold(text: str) -> str:
    """Uppercase with accents removed: 'Aimeé' -> 'AIMEE'."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).upper()


def _name_tokens(text: str) -> list[str]:
    """Uppercase alphanumeric tokens with name suffixes dropped."""
    toks = re.sub(r"[^A-Z0-9 ]", " ", _fold(text)).split()
    return [t for t in toks if t not in _NAME_SUFFIXES]


def address_key(address: str) -> str:
    """'PO Box 33 Hope' / 'Box 33' -> 'BOX 33'; '4500S. Doubletree Rd' ->
    'NUM 4500'. '' when the address has neither."""
    a = _fold(address)
    m = re.search(r"\bBOX\s*#?\s*(\d+)", a)
    if m:
        return f"BOX {int(m.group(1))}"
    m = re.match(r"\s*(\d+)", a)
    return f"NUM {int(m.group(1))}" if m else ""


def split_person_name(raw: str) -> tuple[str, str, str]:
    """'Last, First M. "Nick"' -> (last_key, first_key, nickname_key).

    last_key is the whole surname with punctuation and spaces removed, so
    'St. Clair' and 'St.Clair' compare equal across sources. first_key is
    the first given name. A quoted nickname is returned separately."""
    s = " ".join((raw or "").replace("\xa0", " ").split())
    nick = ""
    m = _DOE_QUOTED_RE.search(s)
    if m:
        nick_toks = _name_tokens(m.group(1))
        nick = nick_toks[0] if nick_toks else ""
        s = _DOE_QUOTED_RE.sub(" ", s)
    if "," in s:
        last, _, first = s.partition(",")
    else:
        parts = s.split()
        last, first = (parts[-1], " ".join(parts[:-1])) if parts else ("", "")
    last_key  = "".join(_name_tokens(last))
    first_tok = _name_tokens(first)
    return last_key, (first_tok[0] if first_tok else ""), nick


def surname_tail(raw: str) -> str:
    """Last part of a compound surname: 'Musgrove-Short, Sarah' -> 'SHORT',
    'Goodwin Johnson, DeLena' -> 'JOHNSON'."""
    s = _DOE_QUOTED_RE.sub(" ", " ".join((raw or "").split()))
    last = s.partition(",")[0] if "," in s else (s.split() or [""])[-1]
    toks = _name_tokens(last.replace("-", " "))
    return toks[-1] if toks else ""


def parse_doe_name_cell(text: str) -> dict | None:
    """One candidate cell -> {name, party, incumbent, withdrawn}, or None
    when the cell is not a candidate (a column header or a blank row)."""
    s = " ".join((text or "").replace("\xa0", " ").split())
    if not s or s.lower().startswith("candidate name"):
        return None
    withdrawn = bool(re.match(r"^withdrawn\b", s, re.IGNORECASE))
    s = _DOE_PREFIX_RE.sub("", s)
    incumbent = bool(re.search(r"\bincumbent\b", s, re.IGNORECASE))
    s = re.sub(r"\*?\bincumbent\b\*?", "", s, flags=re.IGNORECASE)

    party = ""
    had_paren = False
    for m in _DOE_PAREN_RE.finditer(s):
        had_paren = True
        val = " ".join(m.group(1).split())
        pm = _DOE_PARTY_RE.match(val)
        if pm:
            party = party or (pm.group(1) or pm.group(2)).strip()
        elif val.upper() == "WITHDRAWN":
            withdrawn = True
    name = " ".join(_DOE_PAREN_RE.sub(" ", s).replace("*", " ").split()).strip(" ,")
    # A candidate cell is 'Last, First' and usually carries a party; text
    # with neither is not a candidate row.
    if not name or ("," not in name and not had_paren):
        return None
    return {"name": name, "party": party, "incumbent": incumbent, "withdrawn": withdrawn}


_HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"]


def _doe_row_entry(tr) -> dict | None:
    """The candidate in one table row, or None. A <tr> wrapping a nested
    table is skipped; its inner rows are visited on their own."""
    cells = tr.find_all("td", recursive=False)
    if not cells and not tr.find("table"):
        cells = tr.find_all("td")
    if not cells or cells[0].find("table"):
        return None
    entry = parse_doe_name_cell(cells[0].get_text(" ", strip=True))
    if entry:
        entry["address"] = cells[1].get_text(" ", strip=True) if len(cells) > 1 else ""
    return entry


def parse_doe_pages(pages: list[tuple[str, str]]) -> list[dict]:
    """Candidate entries for House and Senate districts from one
    election's list pages.

    `pages` is [(page_label, html)] in page order. Each office is a
    section.candidates-table with its own heading; a section whose heading
    is not a House or Senate district ends the current district, so the
    governor, congressional and court sections around the legislative ones
    are not filed under a district. A section with no heading continues
    the previous district, which covers a page that opens partway through
    one. Pages without those sections fall back to walking headings and
    rows in document order."""
    from bs4 import BeautifulSoup

    out: list[dict] = []
    chamber = district = ""

    def set_heading(text: str) -> None:
        nonlocal chamber, district
        m = _DOE_HEADING_RE.search(text)
        if m:
            chamber = m.group(1).upper()
            district = doe_district(chamber, m.group(2))
        else:
            chamber = district = ""

    def add(tr) -> None:
        if chamber and district:
            entry = _doe_row_entry(tr)
            if entry:
                entry.update(chamber=chamber, district=district)
                out.append(entry)

    for _label, html in pages:
        soup = BeautifulSoup(html, "html.parser")
        sections = soup.find_all("section", class_="candidates-table")
        if sections:
            for sec in sections:
                heading = sec.find(_HEADING_TAGS)
                if heading:
                    set_heading(heading.get_text(" ", strip=True))
                for tr in sec.find_all("tr"):
                    add(tr)
            continue
        for node in soup.find_all(_HEADING_TAGS + ["tr"]):
            text = node.get_text(" ", strip=True)
            if node.name != "tr":
                set_heading(text)
            elif _DOE_HEADING_RE.search(text) and "(" not in text:
                set_heading(text)
            else:
                add(node)
    return out


def load_doe_candidates(raw_dir: Path) -> list[dict]:
    """Every saved Division of Elections list page in raw_dir, parsed.
    Each entry carries election_year ('2026') and election ('prim'/'genr')."""
    groups: dict[tuple[str, str], list[tuple[int, Path]]] = {}
    for path in raw_dir.glob("DOECandidates_*.html"):
        m = DOE_PAGE_RE.match(path.name)
        if m:
            groups.setdefault((m.group(1), m.group(2)), []).append((int(m.group(3)), path))
    entries: list[dict] = []
    for (yy, election), files in sorted(groups.items()):
        files.sort()
        pages = [(p.name, p.read_text(encoding="utf-8", errors="replace")) for _, p in files]
        for e in parse_doe_pages(pages):
            e.update(election_year=f"20{yy}", election=election)
            entries.append(e)
    return entries


def _first_name_match(apoc_first: str, doe_first: str, doe_nick: str) -> str | None:
    """'exact' when the given names are equal, 'high' when one is a known
    nickname of the other (or of the list's quoted nickname), else None."""
    if not apoc_first or not doe_first:
        return None
    if apoc_first == doe_first:
        return "exact"
    if doe_nick and apoc_first == doe_nick:
        return "high"
    for a, b in ((apoc_first, doe_first), (doe_first, apoc_first)):
        if b in expand_nickname(a):
            return "high"
    if doe_nick and doe_first in expand_nickname(apoc_first):
        return "high"
    return None


class DoeIndex:
    """Division of Elections list entries keyed for lookup by APOC
    candidate rows."""

    def __init__(self, entries: list[dict]):
        self.by_key:  dict[tuple[str, str, str], list[dict]] = {}
        self.by_tail: dict[tuple[str, str, str], list[dict]] = {}
        self.years: set[str] = set()
        for e in entries:
            last, first, nick = split_person_name(e["name"])
            if not last:
                continue
            e = {**e, "last_key": last, "first_key": first, "nick_key": nick,
                 "address_key": address_key(e.get("address", ""))}
            year, chamber = e["election_year"], e["chamber"]
            self.by_key.setdefault((year, chamber, last), []).append(e)
            self.by_tail.setdefault((year, chamber, surname_tail(e["name"])), []).append(e)
            self.years.add(year)

    @staticmethod
    def _score(e: dict, first: str, addr: str, *, allow_exact: bool) -> str | None:
        name = _first_name_match(first, e["first_key"], e["nick_key"])
        if name == "exact" and allow_exact:
            return "exact"
        if name or (addr and addr == e["address_key"]):
            return "high"
        return None

    def _hits(self, year: str, chamber: str, raw_name: str, address: str) -> tuple[list[dict], str]:
        last, first, _ = split_person_name(raw_name)
        addr = address_key(address)
        scored = [(e, self._score(e, first, addr, allow_exact=True))
                  for e in self.by_key.get((year, chamber, last), [])]
        for level in ("exact", "high"):
            hits = [e for e, c in scored if c == level]
            if hits:
                return hits, level
        tail = surname_tail(raw_name)
        hits = [e for e in self.by_tail.get((year, chamber, tail), [])
                if e["last_key"] != last
                and self._score(e, first, addr, allow_exact=False)]
        return hits, "high"

    def lookup(self, year: str, chamber: str, raw_name: str,
               address: str = "") -> tuple[dict | None, str]:
        """(fill, outcome) for one APOC row. fill is None unless outcome is
        'exact' or 'high'; other outcomes are 'ambiguous' (two districts),
        'other_chamber' (the name is listed only for the other chamber) and
        'unmatched'."""
        hits, confidence = self._hits(year, chamber, raw_name, address)
        if not hits:
            other = "SENATE" if chamber == "HOUSE" else "HOUSE"
            if self._hits(year, other, raw_name, address)[0]:
                return None, "other_chamber"
            return None, "unmatched"
        if len({e["district"] for e in hits}) != 1:
            return None, "ambiguous"
        # The general list is the later record, so its party wins over the
        # primary's when they differ.
        general = [e for e in hits if e["election"] == "genr"]
        best = (general or hits)[0]
        return {
            "district":         hits[0]["district"],
            "party":            best["party"],
            "incumbent":        any(e["incumbent"] for e in hits),
            "match_confidence": confidence,
        }, confidence


# ================================ Main ================================
def run():
    log = get_logger("alaska", "parse")
    t0  = time.perf_counter()
    log.info("Starting Alaska parser")
    log._emit("parse_started")

    total_contributions = 0
    total_expenditures  = 0
    committees: dict[str, dict] = {}
    cand_count = 0

    file_handles = []

    try:
        cand_fh, cand_w = open_writer("candidates.csv.gz",    C.CANDIDATES)
        cmte_fh, cmte_w = open_writer("committees.csv.gz",    [c for c in C.COMMITTEES if c != "active"])
        cont_fh, cont_w = open_writer("contributions.csv.gz", C.CONTRIBUTIONS)
        expn_fh, expn_w = open_writer("expenditures.csv.gz",  C.EXPENDITURES)
        loan_fh, loan_w = open_writer("loans_debts.csv.gz",   C.LOANS_DEBTS)
        file_handles = [cand_fh, cmte_fh, cont_fh, expn_fh, loan_fh]

        def register_committee(name: str, ctype: str):
            key = committee_key(name)
            if key not in committees:
                committees[key] = {
                    "state":          STATE,
                    # The filer name is the ID: APOC exposes no stable
                    # numeric filer ID, and the name is what joins a
                    # committee to its contributions.
                    "state_filer_id": name,
                    "committee_name": name,
                    "committee_type": ctype,
                    "candidate_name": "",
                    "treasurer_name": "",
                    "city":           "",
                    "zip":            "",
                }

        # Division of Elections list: district, party and incumbency for
        # House and Senate candidates.
        ft = time.perf_counter()
        doe_entries = load_doe_candidates(RAW_DIR)
        doe_index   = DoeIndex(doe_entries)
        if doe_entries:
            log.registry_loaded("DOECandidates_*.html", len(doe_entries),
                                relation="doe_candidates")
        else:
            log.info("  No Division of Elections candidate pages in raw/: "
                     "House and Senate rows keep a blank district")
        doe_outcomes: dict[str, int] = {}
        doe_misses: list[str] = []

        # Candidates
        cand_path = RAW_DIR / "CDCandidates_all.csv"
        ft = time.perf_counter()
        if cand_path.exists() and cand_path.stat().st_size > 0:
            with open(cand_path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    name = normalize_candidate(row.get("Candidate", ""))
                    if not name:
                        continue
                    if "," in name:
                        last, _, first = name.partition(",")
                        last, first = last.strip(), first.strip()
                    else:
                        last, first = name, ""
                    clean_first = utils.clean_name(first)
                    clean_last  = utils.clean_name(last)
                    full_name   = f"{clean_first} {clean_last}".strip() if clean_first else clean_last

                    # AK governor/lt.-governor joint-ticket rows list BOTH
                    # running mates in one raw row, e.g. raw "Candidate"
                    # "Kreiss-Tomkins / Johnson, Jonathan / Zachary" ->
                    # clean_first="Jonathan / Zachary", clean_last=
                    # "Kreiss-Tomkins / Johnson". cloud/supabase/transform/
                    # matching.py's _last_name_of() naively takes the LAST
                    # whitespace token as a surname, which for a smashed
                    # joint string like this always lands on the RUNNING
                    # MATE's surname ("Johnson"), never the top-of-ticket
                    # candidate's own ("Kreiss-Tomkins") -- breaking both
                    # display and last-name matching for every joint-ticket
                    # row (confirmed live 2026-09-24: Jonathan Kreiss-Tomkins,
                    # a real, well-funded 2026 Governor candidate, showed up
                    # on the dashboard only as the unrecognizable "Jonathan /
                    # Zachary Kreiss-Tomkins / Johnson", $0 raised, because
                    # of this). state_filer_id stays the FULL joint string
                    # (still a unique, stable per-registration key, and
                    # that's what any committee_candidate_map.csv curation
                    # for this participant must keep using) -- only
                    # candidate_name/first/last are narrowed to the top-of-
                    # ticket person so display and last-name matching both
                    # resolve to the actual candidate instead of their
                    # running mate.
                    display_first, display_last, display_name = clean_first, clean_last, full_name
                    # Delimiter is inconsistent in the raw source -- real
                    # examples seen: "Kreiss-Tomkins / Johnson, Jonathan /
                    # Zachary" (slash, spaced), "Begich/Hnilicka, Thomas/
                    # Julia" (slash, unspaced), "Taylor/ English,
                    # Tregarrick/ Candice" (slash, inconsistently spaced),
                    # "Heilala \ Sumner, Matt \ Jesse" (backslash) -- so
                    # split on either slash with optional surrounding
                    # whitespace rather than a single literal separator.
                    joint_re = re.compile(r"\s*[/\\]\s*")
                    if joint_re.search(clean_first) and joint_re.search(clean_last):
                        first_parts = [p.strip() for p in joint_re.split(clean_first) if p.strip()]
                        last_parts  = [p.strip() for p in joint_re.split(clean_last) if p.strip()]
                        if (len(first_parts) == len(last_parts) and len(first_parts) >= 2
                                and first_parts[0] and last_parts[0]):
                            display_first = first_parts[0]
                            display_last  = last_parts[0]
                            display_name  = f"{display_first} {display_last}".strip()

                    office        = utils.clean_name(row.get("Office", ""))
                    election_year = clean(row.get("Year", ""))
                    party         = utils.clean_name(row.get("Party", ""))
                    district = incumbent = party_source = match_confidence = ""
                    if office in ("HOUSE", "SENATE") and election_year in doe_index.years:
                        fill, outcome = doe_index.lookup(election_year, office, name,
                                                         row.get("Address", ""))
                        doe_outcomes[outcome] = doe_outcomes.get(outcome, 0) + 1
                        if fill:
                            district  = fill["district"]
                            incumbent = "1" if fill["incumbent"] else "0"
                            if not party and fill["party"]:
                                party            = canonical_party(fill["party"])
                                party_source     = DOE_PARTY_SOURCE
                                match_confidence = fill["match_confidence"]
                        else:
                            doe_misses.append(f"{name} ({office.title()}, {election_year}): {outcome}")

                    cand_w.writerow({
                        "state":            STATE,
                        "state_filer_id":   full_name,
                        "candidate_name":   display_name,
                        "candidate_first":  display_first,
                        "candidate_last":   display_last,
                        "office":           office,
                        "district":         district,
                        "jurisdiction":     utils.clean_name(row.get("Election", "")),
                        "party":            party,
                        "party_source":     party_source,
                        "match_confidence": match_confidence,
                        "election_year":    election_year,
                        "incumbent":        incumbent,
                        "raw_file":         cand_path.name,
                        "row_num":          row_num,
                    })
                    cand_count += 1
        if doe_outcomes:
            summary = ", ".join(f"{k} {v}" for k, v in sorted(doe_outcomes.items()))
            log.info(f"  Division of Elections match for House/Senate rows: {summary}")
            for miss in doe_misses:
                log.info(f"    no district: {miss}")
        log.file_parsed("CDCandidates_all.csv", "candidates", cand_count,
                        duration_s=time.perf_counter() - ft,
                        bytes=cand_path.stat().st_size if cand_path.exists() else 0)

        # Contributions (CDIncome)
        # Dedup per file on (contributor, amount, date, committee), keeping the
        # row with the highest Result number (most recent amendment).
        for path in raw_files("CDIncome_*.csv"):
            ft   = time.perf_counter()
            seen: dict[tuple, dict] = {}
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    amount = parse_amount(row.get("Amount", ""))
                    if not amount:
                        continue
                    filer      = clean(row.get("Name", ""))
                    filer_type = clean(row.get("Filer Type", ""))
                    register_committee(filer, filer_type)
                    contributor = build_name(
                        row.get("Last/Business Name", ""),
                        row.get("First Name", ""),
                    )
                    date_val = parse_date(row.get("Date", ""))
                    result   = clean(row.get("Result", ""))
                    key = (contributor, amount, date_val, filer)
                    prev = seen.get(key)
                    if prev is None or (result.isdigit() and
                            (not prev["filing_id"].isdigit() or
                             int(result) > int(prev["filing_id"]))):
                        seen[key] = {
                            "state":             STATE,
                            "committee_name":    utils.clean_name(filer),
                            "contributor_name":  utils.clean_name(contributor),
                            "amount":            amount,
                            "date":              date_val,
                            "transaction_type":  clean(row.get("Transaction Type", "")),
                            "contributor_type":  contributor_type_from_first_name(row.get("First Name", "")),
                            "contributor_city":  clean(row.get("City", "")),
                            "contributor_state": clean(row.get("State", "")),
                            "contributor_zip":   clean(row.get("Zip", "")),
                            "employer":          clean(row.get("Employer", "")),
                            "occupation":        clean(row.get("Occupation", "")),
                            "candidate_name":    utils.clean_name(filer) if filer_type == "Candidate" else "",
                            "office":            utils.clean_name(row.get("Office", "")),
                            "election_year":     clean(row.get("Report Year", year_from_filename(path))),
                            "filing_id":         result,
                            "amended":           "",
                            "raw_file":          path.name,
                            "row_num":           row_num,
                        }
            for out_row in seen.values():
                cont_w.writerow(out_row)
            count = len(seen)
            log.file_parsed(path.name, "contributions", count,
                            duration_s=time.perf_counter() - ft,
                            bytes=path.stat().st_size)
            total_contributions += count

        # Expenditures (CDExpense)
        for path in raw_files("CDExpense_*.csv"):
            ft   = time.perf_counter()
            seen: dict[tuple, dict] = {}
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    amount = parse_amount(row.get("Amount", ""))
                    if not amount:
                        continue
                    filer      = clean(row.get("Name", ""))
                    filer_type = clean(row.get("Filer Type", ""))
                    register_committee(filer, filer_type)
                    payee    = build_name(
                        row.get("Last/Business Name", ""),
                        row.get("First Name", ""),
                    )
                    date_val = parse_date(row.get("Date", ""))
                    result   = clean(row.get("Result", ""))
                    key = (payee, amount, date_val, filer)
                    prev = seen.get(key)
                    if prev is None or (result.isdigit() and
                            (not prev["filing_id"].isdigit() or
                             int(result) > int(prev["filing_id"]))):
                        seen[key] = {
                            "state":            STATE,
                            "committee_name":   utils.clean_name(filer),
                            "payee_name":       utils.clean_name(payee),
                            "amount":           amount,
                            "date":             date_val,
                            "transaction_type": clean(row.get("Transaction Type", "")),
                            "purpose":          clean(row.get("Purpose of Expenditure", "")),
                            "category":         clean(row.get("Payment Type", "")),
                            "payee_city":       clean(row.get("City", "")),
                            "payee_state":      clean(row.get("State", "")),
                            "payee_zip":        clean(row.get("Zip", "")),
                            "candidate_name":   utils.clean_name(filer) if filer_type == "Candidate" else "",
                            "office":           utils.clean_name(row.get("Office", "")),
                            "election_year":    clean(row.get("Report Year", year_from_filename(path))),
                            "filing_id":        result,
                            "amended":          "",
                            "raw_file":         path.name,
                            "row_num":          row_num,
                        }
            for out_row in seen.values():
                expn_w.writerow(out_row)
            count = len(seen)
            log.file_parsed(path.name, "expenditures", count,
                            duration_s=time.perf_counter() - ft,
                            bytes=path.stat().st_size)
            total_expenditures += count

        # Committees: enrich from GRForms bulk exports
        # Fills fields still blank after the transaction pass, and adds groups
        # that registered but have no transactions (those get their APOC
        # abbreviation as state_filer_id).
        for path in raw_files("GRForms_*.csv"):
            ft         = time.perf_counter()
            file_count = 0
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row in csv.DictReader(f):
                    name = clean(row.get("Name", ""))
                    if not name:
                        continue

                    key = committee_key(name)
                    entry = committees.get(key) or {
                        "state": STATE,
                        "state_filer_id": "",
                        "committee_name": name,
                        "candidate_name": "",
                    }


                    # Only overwrite fields that are still blank
                    if not entry.get("committee_type"):
                        entry["committee_type"] = (
                            " — ".join(filter(None, [
                                clean(row.get("Type", "")),
                                clean(row.get("Subtype", "")),
                            ]))
                        )
                    elif entry["committee_type"] == "Group" and clean(row.get("Type", "")):
                        # "Group" is the transaction exports' generic filer
                        # type; the registration names the specific one
                        # (PAC, Political Party, Ballot Proposition, ...).
                        entry["committee_type"] = clean(row.get("Type", ""))
                    if not entry.get("treasurer_name"):
                        entry["treasurer_name"] = clean(row.get("Treasurer Name", ""))
                    if not entry.get("city"):
                        entry["city"] = clean(row.get("City", ""))
                    if not entry.get("zip"):
                        entry["zip"]  = clean(row.get("Zip", ""))
                    if not entry.get("state_filer_id"):
                        entry["state_filer_id"] = clean(row.get("Abbreviation", ""))
                    committees[key] = entry
                    file_count += 1
            log.registry_loaded(path.name, entries=file_count, relation="committees",
                               bytes=path.stat().st_size)

        # Committees: enrich Candidate-type entries from CRForms bulk exports.
        # Only fills committees that already exist from transaction activity;
        # a bare registration with no transactions does not create a row.
        cr_forms_registry = load_cr_forms_registry()
        cr_forms_matched  = 0
        for key, entry in committees.items():
            if entry.get("committee_type") != "Candidate":
                continue

            detail = cr_forms_registry.get(key)

            # Fallback: drop middle tokens -- "pete b higgins" -> "pete higgins"
            if detail is None:
                parts = entry.get("committee_name", "").split()
                if len(parts) >= 3:
                    alt_key = committee_key(parts[0] + " " + parts[-1])
                    detail = cr_forms_registry.get(alt_key)

            if detail is None:
                continue

            entry["candidate_name"] = clean(detail.get("candidate_display_name", "")) or entry.get("candidate_name", "")
            entry["city"]           = utils.clean_name(clean(detail.get("city", "")) or entry.get("city", ""))
            entry["zip"]            = clean(detail.get("zip",            "")) or entry.get("zip",            "")
            entry["treasurer_name"] = clean(detail.get("treasurer_name", "")) or entry.get("treasurer_name", "")
            cr_forms_matched += 1

        if cr_forms_registry:
            log.registry_loaded("CRForms_*.csv", entries=len(cr_forms_registry),
                               relation="committees", bytes=0)
            log.enrichment_summary(
                cr_forms_matched=cr_forms_matched,
                total_committees=len(committees),
            )

        # Independent Expenditures (Form 15-6) -- IEExpenditures_<year>.csv /
        # IEContributions_<year>.csv, bulk-exported by scrapers/alaska.py the
        # same Select-Year/Status/Search/Export way as CDIncome/CDExpense
        # above (confirmed live 2026-09-24 -- an earlier version of this
        # scraper swept per-filing detail pages instead; that was replaced
        # once the bulk grids turned out to export every filing directly,
        # same as every other AK relation). A third, separate disclosure
        # track from the regular CDIncome/CDExpense filings (confirmed
        # empirically non-redundant -- zero overlap spot-checked against the
        # existing contributions dataset), so it's folded into the existing
        # contributions.csv.gz/expenditures.csv.gz outputs here rather than
        # given its own tables -- IE money is still ordinary contribution/
        # expenditure money, just tagged with which candidate/measure it
        # supports or opposes (affiliated_candidate_name/support_oppose,
        # same convention Georgia's ie_stance_code() established).
        #
        # Column-name quirk confirmed live: the two exports don't name the
        # committee the same way. IEExpenditures.csv has only "Filer Name"
        # (which IS the committee name, e.g. "2026 - Repeal Now"), while
        # IEContributions.csv has BOTH "Filer Name" (the group's registered
        # contact person, e.g. "Rappoport, Ann Gayle") and "Filer" (the
        # actual committee name, e.g. "2026 - Alaska March On") -- use
        # "Filer" for contributions, "Filer Name" for expenditures. Same
        # amendment-dedup (highest "Result" wins) pattern as CDIncome/
        # CDExpense, since these exports repeat a row per amendment too
        # (confirmed live: an original "Filed *" row and its "Filed **"
        # amendment share date/amount/recipient but differ in Result).
        def _ie_stance(position: str) -> str:
            position = position.strip().lower()
            if position.startswith("support"):
                return "S"
            if position.startswith("oppos"):
                return "O"
            return ""

        # AK's IE "Candidate/Proposition" column mixes two different kinds
        # of target in one field: a YEAR-REGISTERED candidate entry (e.g.
        # "2026 - Jonathan Kreiss-Tomkins (JKT) / Zac Johnson" for a joint
        # Governor/Lt. Governor ticket) or a ballot measure/proposition
        # (e.g. "Prop 1 & 2", "Retention of judges", "2025-18 / Ballot Prop
        # 1"). Confirmed live 2026-09-24: candidate entries are
        # consistently "YYYY - Name" (literal 4-digit year, space, hyphen,
        # space) -- 957/958 values matching that exact shape are real
        # candidate names (the one exception, "Rocky MacDonald for Borough
        # Assembly", still IS a candidate); propositions never use that
        # shape ("2025-18 / ..." has no spaces around its hyphen, so it
        # correctly falls through untouched). Only candidate entries get
        # cleaned here -- dropping the year prefix, any parenthetical
        # nickname, and -- the actual bug this exists to fix -- everything
        # after a joint-ticket "/" or "\" delimiter. Without this, the
        # RUNNING MATE's surname is left as the last whitespace token, and
        # transform/matching.py's _last_name_of() (used to attribute IE
        # expenditures to a candidate_id) naively takes that last token --
        # the exact same failure mode already fixed for candidates.csv's
        # own joint-ticket rows above in this file's CDCandidates block
        # (see that block's comment for the delimiter-variant reasoning,
        # mirrored here). Confirmed live: without this fix, IE spending
        # supporting/opposing Jonathan Kreiss-Tomkins (a real, well-funded
        # 2026 Governor candidate) was silently un-attributed to him.
        def clean_ie_target_name(val: str) -> str:
            m = re.match(r"^\d{4} - (.+)$", val or "")
            if not m:
                return val
            name = m.group(1)
            name = re.sub(r"\s*\([^)]*\)", "", name)             # drop parenthetical nickname
            name = re.split(r"\s*[/\\]\s*", name, maxsplit=1)[0]  # keep top-of-ticket only
            return name.strip()

        for path in raw_files("IEExpenditures_*.csv"):
            ft   = time.perf_counter()
            seen: dict[tuple, dict] = {}
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    amount = parse_amount(row.get("Amount", ""))
                    if not amount:
                        continue
                    filer      = strip_html_br(clean(row.get("Filer Name", "")))
                    filer_type = clean(row.get("Filer Type", ""))
                    if not filer:
                        continue
                    register_committee(filer, filer_type)
                    recipient = clean(row.get("Recipient", ""))
                    date_val  = parse_date(row.get("Date", ""))
                    result    = clean(row.get("Result", ""))
                    key = (recipient, amount, date_val, filer)
                    prev = seen.get(key)
                    if prev is None or (result.isdigit() and
                            (not prev["filing_id"].isdigit() or
                             int(result) > int(prev["filing_id"]))):
                        seen[key] = {
                            "state":                      STATE,
                            "committee_name":             utils.clean_name(filer),
                            "amount":                     amount,
                            "date":                       date_val,
                            "transaction_type":           "Independent Expenditure",
                            "payee_name":                 utils.clean_name(recipient),
                            "purpose":                    clean(row.get("Payment Detail", "")),
                            "category":                   clean(row.get("Payment Type", "")),
                            "payee_city":                 utils.clean_name(clean(row.get("Recipient City", ""))),
                            "payee_state":                clean(row.get("Recipient State", "")),
                            "payee_zip":                  clean(row.get("Recipient Zip", "")),
                            "candidate_name":             utils.clean_name(filer) if filer_type == "Candidate" else "",
                            "office":                     "",
                            "election_year":              clean(row.get("Election Year", "")) or clean(row.get("Report Year", "")),
                            "affiliated_candidate_name":  utils.clean_name(clean_ie_target_name(clean(row.get("Candidate/Proposition", "")))),
                            "support_oppose":             _ie_stance(clean(row.get("Position", ""))),
                            "amended":                    "",
                            "filing_id":                  result,
                            "raw_file":                   path.name,
                            "row_num":                    row_num,
                        }
            for out_row in seen.values():
                expn_w.writerow(out_row)
            count = len(seen)
            log.file_parsed(path.name, "expenditures", count,
                            duration_s=time.perf_counter() - ft,
                            bytes=path.stat().st_size)
            total_expenditures += count

        for path in raw_files("IEContributions_*.csv"):
            ft   = time.perf_counter()
            seen: dict[tuple, dict] = {}
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    amount = parse_amount(row.get("Amount", ""))
                    if not amount:
                        continue
                    filer      = clean(row.get("Filer", ""))
                    filer_type = clean(row.get("Filer Type", ""))
                    if not filer:
                        continue
                    register_committee(filer, filer_type)
                    contributor = clean(row.get("Contributor", ""))
                    date_val    = parse_date(row.get("Date", ""))
                    result      = clean(row.get("Result", ""))
                    key = (contributor, amount, date_val, filer)
                    prev = seen.get(key)
                    if prev is None or (result.isdigit() and
                            (not prev["filing_id"].isdigit() or
                             int(result) > int(prev["filing_id"]))):
                        seen[key] = {
                            "state":             STATE,
                            "committee_name":    utils.clean_name(filer),
                            "amount":            amount,
                            "date":              date_val,
                            # This exact sentinel (not a more readable
                            # label) is required -- candidate_ie_contributors
                            # in materialized_views.sql joins contributions
                            # to a candidate's IE-active committees via
                            # 'contribution_type = FEC_NONFEDERAL_IE_RECEIPT'
                            # (contribution_type is contributions.csv.gz's
                            # transaction_type, renamed on push -- see
                            # cloud/supabase/transform/entities.py). Same
                            # convention ohio.py already established for its
                            # own FEC nonfederal-IE committee receipts: a
                            # receipt into an IE committee's account isn't
                            # earmarked to one candidate (the money is
                            # fungible across whatever that committee spends
                            # on), so it can't carry a candidate_id of its
                            # own -- this is the general flag the matview
                            # layer already uses to surface "who funds this
                            # committee" without inventing a per-dollar link
                            # the source data doesn't support. Confirmed
                            # live 2026-09-24: without this, candidate_ie_
                            # contributors silently returned 0 rows for AK
                            # even though candidate_ie_expenditures worked.
                            "transaction_type":  "FEC_NONFEDERAL_IE_RECEIPT",
                            "contributor_name":  utils.clean_name(contributor),
                            # The page's own "Type" column states the donor's
                            # type explicitly (Individual/Registered Group/
                            # Other) -- more reliable than the first-name
                            # heuristic CDIncome needs, so it's passed
                            # through as-is (same convention Delaware/
                            # Maryland/Minnesota/Kentucky use for their own
                            # explicit type columns). Downstream SQL only
                            # distinguishes 'Individual' from everything
                            # else, so any exact-text non-Individual value
                            # still filters correctly.
                            "contributor_type":  clean(row.get("Type", "")),
                            "contributor_city":  utils.clean_name(clean(row.get("Contributor City", ""))),
                            "contributor_state": clean(row.get("Contributor State", "")),
                            "contributor_zip":   clean(row.get("Contributor Zip", "")),
                            "employer":          clean(row.get("Employer", "")),
                            "occupation":        clean(row.get("Occupation", "")),
                            "candidate_name":    utils.clean_name(filer) if filer_type == "Candidate" else "",
                            "office":            "",
                            "election_year":     clean(row.get("Report Year", "")),
                            "amended":           "",
                            "filing_id":         result,
                            "raw_file":          path.name,
                            "row_num":           row_num,
                        }
            for out_row in seen.values():
                cont_w.writerow(out_row)
            count = len(seen)
            log.file_parsed(path.name, "contributions", count,
                            duration_s=time.perf_counter() - ft,
                            bytes=path.stat().st_size)
            total_contributions += count

        # Flush committees
        for row in committees.values():
            row["committee_name"] = utils.clean_name(row.get("committee_name", ""))
            row["candidate_name"] = utils.clean_name(row.get("candidate_name", ""))
            row["treasurer_name"] = utils.clean_name(row.get("treasurer_name", ""))
            row["city"]           = utils.clean_name(row.get("city", ""))
            cmte_w.writerow(row)

        # Close handles before person-ID assignment
        for fh in file_handles:
            fh.close()
        file_handles = []

        utils.assign_person_ids(CLEAN_DIR / "candidates.csv.gz", id_model="name_hash")
        utils.assign_committee_person_ids(CLEAN_DIR / "committees.csv.gz",
                                          CLEAN_DIR / "candidates.csv.gz")

        def _out_bytes(name):
            p = CLEAN_DIR / name
            return p.stat().st_size if p.exists() else 0

        log.file_parsed("contributions.csv.gz", "contributions", total_contributions, role="output",
                        bytes=_out_bytes("contributions.csv.gz"))
        log.file_parsed("expenditures.csv.gz",  "expenditures",  total_expenditures,  role="output",
                        bytes=_out_bytes("expenditures.csv.gz"))
        log.file_parsed("loans_debts.csv.gz",   "loans_debts",   0,                   role="output",
                        bytes=_out_bytes("loans_debts.csv.gz"))
        log.file_parsed("committees.csv.gz",    "committees",    len(committees),      role="output",
                        bytes=_out_bytes("committees.csv.gz"))
        log.file_parsed("candidates.csv.gz",    "candidates",    cand_count,           role="output",
                        bytes=_out_bytes("candidates.csv.gz"))

        duration = round(time.perf_counter() - t0, 1)
        log.info(f"Done in {duration}s")
        log._emit("parse_completed", status="completed", duration_s=duration,
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=len(committees), candidates=cand_count)

    except KeyboardInterrupt:
        log._emit("parse_completed", status="interrupted",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=len(committees), candidates=cand_count)
        raise

    except Exception as e:
        log._emit("parse_completed", status="error",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=len(committees), candidates=cand_count,
                  error_type=type(e).__name__, error=str(e))
        raise

    finally:
        for fh in file_handles:
            try:
                fh.close()
            except Exception:
                pass

# ====== CLI ==================================
if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
