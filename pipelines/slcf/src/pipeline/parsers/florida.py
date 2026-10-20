"""
parsers/florida.py — Parse Florida campaign finance data.

Raw files consumed (data/Florida/raw/):
  fl_committee_details.csv    — scraped ComDetail.asp pages, all committees
  fl_committees_active.txt    — bulk active-committee download (structured address + county)
  fl_committee_links.csv      — A-Z search results: account_id, name, type, status
  fl_candidates_{slug}.txt    — tab-delimited bulk per election cycle (primary candidate source)
  fl_candidate_details.csv    — scraped CanDetail.asp pages (date_filed, method, email)
  fl_contributions_{year}.txt — contributions by year, all committees
  fl_expenditures_{year}.txt  — expenditures by year (parsed when present)
  fl_transfers_{year}.txt     — fund transfers (routed to contributions, type=Transfer)
  fl_other_{year}.txt         — other distributions (routed to expenditures, type=Other Distribution)

Output (data/Florida/cleaned/):
  contributions.csv.gz, expenditures.csv.gz, candidates.csv.gz,
  committees.csv.gz, loans_debts.csv.gz

Notes:
  - Committees: fl_committee_details.csv is primary; fl_committees_active.txt
    provides county and clean structured address; fl_committee_links.csv provides
    authoritative status (Active/Closed). Purpose/affiliates from detail pages may
    be blank due to scraper parsing — handled gracefully.
  - Candidates: bulk files are authoritative for name/office/party/district.
    fl_candidate_details.csv enriches with date_filed, date_qualified, and method.
    Circuit/Group numbers from detail pages are unreliable (parsing artifact) — we
    use Juris1num/Juris2num from bulk files for district.
  - Candidate IDs are per-registration (id_model="committee"): the same person
    running in 2022 and 2026 gets two different AcctNums.
  - Zip codes in bulk candidate files have trailing zeros: "342210000" → "34221".
  - Contribution "City State Zip" is a single combined column: "MIAMI, FL 33101".
  - Contribution "Candidate/Committee" includes type suffix: "Name (PAC)" — stripped.
  - Typ=LOA (loan) rows are routed to loans_debts; all others stay in contributions.
  - Transfers (fl_transfers_{year}.txt) are written to contributions with
    transaction_type="Transfer".
  - Other distributions (fl_other_{year}.txt) are written to expenditures with
    transaction_type="Other Distribution".
"""

import csv
import gzip
import hashlib
import re
import sys
from datetime import date, datetime
from pathlib import Path

from tqdm import tqdm
from tqdm.contrib.logging import logging_redirect_tqdm

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "src" / "pipeline"))
from src.reporting.logger import get_logger
import columns as C
import utils
from contributor_type_nb import classify_contributor_type

csv.field_size_limit(sys.maxsize)

# =============================== paths ================================
RAW_DIR   = PROJECT_ROOT / "data" / "Florida" / "raw"
CLEAN_DIR = PROJECT_ROOT / "data" / "Florida" / "cleaned"
CLEAN_DIR.mkdir(parents=True, exist_ok=True)

STATE = "FL"

# ============================= constants ==============================

# Contribution Typ code → canonical transaction_type
TYP_MAP = {
    "CHE": "Check",
    "CAS": "Cash",
    "INK": "In-Kind",
    "INT": "Interest",
    "REF": "Refund",
    "LOA": "Loan",
    "DUE": "Dues",
    "MON": "Money Order",
    "CRE": "Credit Card",
    "ELE": "Electronic Transfer",
    "X":   "Other",
}

# Committee type code → canonical label (from bulk download TypeDesc)
CMTE_TYPE_MAP = {
    "CCE": "Committee of Continuous Existence",
    "PAC": "Political Committee",
    "PTY": "Party Executive Committee",
    "ECO": "Electioneering Communications Organization",
    "IXO": "Independent Expenditure Organization",
    "PAP": "Affiliated Party Committee",
    "ECI": "Electioneering Communication Individual",
}

# Florida's transaction exports are tab-separated text, not CSV: a quote is a
# literal character. csv's default quoting took an unbalanced one (an
# occupation cut at 30 characters, '"BANKER, BUSINESS OWNER, INVES') for the
# start of a quoted field and swallowed the next 363 lines into it
# (fl_contributions_2025.txt, 2026-10-15; 79 of Byron Donalds's
# contributions among them). Every line holds exactly its header's field
# count, so QUOTE_NONE reads one row per line, and _unquote strips the quotes
# a filer's software put around a whole field ('"TMA DIRECT, INC."'), as csv
# did.
TXN_QUOTING = csv.QUOTE_NONE

# ========================== shared helpers ============================

def _unquote(row: dict) -> dict:
    """A transaction row with whole-field quotes removed (see TXN_QUOTING)."""
    for k, v in row.items():
        s = (v or "").strip()
        if len(s) > 1 and s[0] == s[-1] == '"':
            row[k] = s[1:-1].replace('""', '"')
    return row


def clean(val) -> str:
    """Strip whitespace, collapse internal runs, remove non-breaking spaces."""
    return re.sub(r"\s+", " ", (val or "").replace("\xa0", " ")).strip()


def parse_amount(val: str) -> str:
    v = clean(val).replace("$", "").replace(",", "")
    if not v:
        return ""
    try:
        float(v)
        return v
    except ValueError:
        return ""


def parse_date(val: str) -> str:
    v = clean(val)
    if not v:
        return ""
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y"):
        try:
            d = datetime.strptime(v, fmt)
            if d.year < 1990 or d.year > date.today().year + 2:
                return ""
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def normalize_zip(raw: str) -> str:
    """Trim trailing zeros from Florida's 9-digit zip format: 342210000 → 34221."""
    z = clean(raw).replace("-", "")
    if len(z) == 9 and z.endswith("0000"):
        return z[:5]
    if len(z) > 5:
        return z[:5]
    return z


def split_city_state_zip(combined: str) -> tuple[str, str, str]:
    """Parse 'CITY, ST 33101' into (city, state, zip).

    Handles cities with spaces (e.g. 'MIAMI BEACH, FL 33139') and
    missing/malformed values gracefully.
    Aggregate contributions with no real address come through as ', 00000'
    or ', FL 00000' — these are treated as blank.
    """
    v = clean(combined)
    if not v:
        return "", "", ""
    # Match: anything before last comma = city, then 2-letter state, then zip
    m = re.match(r"^(.+),\s*([A-Z]{2})\s+(\S+)$", v)
    if m:
        city = m.group(1).strip()
        zip_ = m.group(3).strip()
        # Discard placeholder zip '00000' — used for aggregate/bulk contributions
        if zip_ == "00000":
            return "", "", ""
        return city, m.group(2), zip_
    # Fallback: try without zip
    m2 = re.match(r"^(.+),\s*([A-Z]{2})$", v)
    if m2:
        return m2.group(1).strip(), m2.group(2), ""
    return "", "", ""


def strip_committee_type(raw_name: str) -> tuple[str, str]:
    """Strip trailing type/party/office suffixes from a contribution committee name.

    Returns (committee_name, candidate_name).

    Candidate committees: 'Smith, John (REP)(STR)' → two paren groups.
      committee_name = 'Smith, John'
      candidate_name = 'Smith, John'  (same — the candidate IS the committee)

    PACs / non-candidate committees: 'Florida Medical Assoc (PAC)' → one paren group.
      committee_name = 'Florida Medical Assoc'
      candidate_name = ''
    """
    v = clean(raw_name)
    # Count how many trailing (XX…X) groups the name has
    trailing = re.findall(r"\([A-Z]{2,5}\)", v)
    stripped  = re.sub(r"(\s*\([A-Z]{2,5}\))+\s*$", "", v).strip()

    # Two or more groups → candidate committee; candidate name = stripped name
    candidate_name = stripped if len(trailing) >= 2 else ""
    return stripped, candidate_name


def election_year_from_id(elec_id: str) -> str:
    """Extract 4-digit year from ElectionID like '19961105-GEN' → '1996'."""
    m = re.match(r"(\d{4})", clean(elec_id))
    return m.group(1) if m else ""


def open_writer(filename: str, fieldnames: list):
    fh = gzip.open(CLEAN_DIR / filename, "wt", encoding="utf-8", newline="")
    w  = csv.DictWriter(fh, fieldnames=fieldnames,
                        extrasaction="ignore", restval="")
    w.writeheader()
    return fh, w


def raw_files(pattern: str) -> list[Path]:
    return sorted(
        (f for f in RAW_DIR.glob(pattern) if f.stat().st_size > 0),
        key=lambda p: p.name,
    )


# ===================== committee accounts =============================

def _name_keys(last: str, first: str, middle: str) -> list[str]:
    """'LAST, FIRST' and 'LAST, FIRST MIDDLE' -- the forms a candidate
    committee's name takes in the transaction files' Candidate/Committee
    column (see parse_committees' pass 2)."""
    keys = []
    base = utils.clean_name(f"{last}, {first}" if last else first)
    if base:
        keys.append(base)
    if last and middle:
        keys.append(utils.clean_name(f"{last}, {first} {middle}"))
    return keys


def _candidate_accounts() -> tuple[dict, dict]:
    """fl_candidates_*.txt -> ({(norm_name, office_code): (AcctNum, elec_year,
    ElectionID)}, {norm_name: same}); the name-only map is the fallback when
    a transaction row carries no usable office code. Newest ElectionID wins
    in both (see parse_committees' pass 2 for why)."""
    by_office: dict[tuple[str, str], tuple[str, str, str]] = {}
    by_name: dict[str, tuple[str, str, str]] = {}

    def _keep_newest(d, key, val):
        cur = d.get(key)
        if cur is None or val[2] > cur[2]:
            d[key] = val

    for cand_path in raw_files("fl_candidates_*.txt"):
        with open(cand_path, newline="", encoding="utf-8", errors="replace") as f:
            # QUOTE_NONE (see TXN_QUOTING): a nickname is NameMiddle
            # '"Skeeter"' here and 'Abbott, Matthew "Skeeter"' in the
            # transaction files, and csv's quoting stripped it, so the two
            # never met (2026-10: 18 candidates' rows had no account). Keys
            # come from the names both as written and unquoted.
            for row in csv.DictReader(f, delimiter="\t", quoting=TXN_QUOTING):
                acct    = clean(row.get("AcctNum", ""))
                elec_id = clean(row.get("ElectionID", ""))
                office  = clean(row.get("OfficeCode", "")).upper()
                if not acct:
                    continue
                val = (acct, election_year_from_id(elec_id), elec_id)
                keys = {}
                for r in (row, _unquote(dict(row))):
                    keys.update(dict.fromkeys(_name_keys(
                        clean(r.get("NameLast", "")), clean(r.get("NameFirst", "")),
                        clean(r.get("NameMiddle", "")))))
                for norm in keys:
                    if office:
                        _keep_newest(by_office, (norm, office), val)
                    _keep_newest(by_name, norm, val)
    return by_office, by_name


class _FilerIds:
    """Candidate/Committee column -> the filing committee's account number,
    the transaction rows' state_filer_id for state-politics-tracker's loader
    (columns.py, TRANSACTION_IDS).

    Florida's transaction exports carry no account number, only the
    committee's name, so it is looked up the way the committees table gets
    its ids: a candidate committee ("Donalds, Byron (REP)(GOV)") by name and
    office code in the candidate bulk files (newest registration), any other
    committee ("Florida Medical Assoc (PAC)") by name in
    fl_committee_details.csv. Blank when the files don't resolve it (no
    bulk files, an unregistered name, or a name two committees share) --
    never the committees table's name-hash fallback, which no source knows.
    """

    def __init__(self):
        self.by_office, self.by_name = _candidate_accounts()
        self.committees: dict[str, str] = {}
        ambiguous: set[str] = set()
        path = RAW_DIR / "fl_committee_details.csv"
        if path.exists():
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row in csv.DictReader(f):
                    acct = clean(row.get("account_id", ""))
                    norm = utils.clean_name(row.get("name", ""))
                    if not acct or not norm:
                        continue
                    if self.committees.get(norm, acct) != acct:
                        ambiguous.add(norm)
                    self.committees[norm] = acct
        for norm in ambiguous:
            del self.committees[norm]
        self._cache: dict[str, str] = {}

    def __call__(self, committee_raw: str) -> str:
        if committee_raw in self._cache:
            return self._cache[committee_raw]
        cmte_name, cand_name = strip_committee_type(committee_raw)
        norm = utils.clean_name(cmte_name)
        if cand_name:
            trailing = re.findall(r"\(([A-Z]{2,5})\)", committee_raw)
            office = trailing[-1] if len(trailing) >= 2 else ""
            hit = (self.by_office.get((norm, office)) if office else None) \
                  or self.by_name.get(norm)
            acct = hit[0] if hit else ""
        else:
            acct = self.committees.get(norm, "")
        self._cache[committee_raw] = acct
        return acct


# ========================== committees ================================

def _load_committee_links() -> dict[str, dict]:
    """Load fl_committee_links.csv → {account_id: {name, type, status}}."""
    result: dict[str, dict] = {}
    path = RAW_DIR / "fl_committee_links.csv"
    if not path.exists():
        return result
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            result[row["account_id"]] = {
                "name":   clean(row.get("name", "")),
                "type":   clean(row.get("type", "")),
                "status": clean(row.get("status", "")),
            }
    return result


def _load_active_committees() -> dict[str, dict]:
    """Load fl_committees_active.txt → {AcctNum: row} for county + clean address."""
    result: dict[str, dict] = {}
    path = RAW_DIR / "fl_committees_active.txt"
    if not path.exists():
        return result
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            acct = clean(row.get("AcctNum", ""))
            if acct:
                result[acct] = row
    return result


def parse_committees(log) -> int:
    """Parse fl_committee_details.csv into committees.csv.gz.

    Primary source: fl_committee_details.csv (richest detail — PACs, political
    committees, CCEs registered through the committee system).
    Supplements: fl_committees_active.txt (county, structured address).
    Status: from fl_committee_links.csv (authoritative active/closed flag).

    Second pass: candidate campaign committees do not appear in
    fl_committee_details.csv — they are only referenced by name in the
    transaction files. After writing the detail-based rows we scan all
    contribution and expenditure files and synthesize one committee row per
    unique committee name not already written.
    """
    links  = _load_committee_links()
    active = _load_active_committees()

    path = RAW_DIR / "fl_committee_details.csv"
    if not path.exists():
        log.warning("  [!] fl_committee_details.csv not found — skipping committees")
        return 0

    written = 0
    # Track normalised names written from detail file to avoid duplicates in pass 2
    written_names: set[str] = set()
    cmte_fh, cmte_w = open_writer("committees.csv.gz", C.COMMITTEES)

    try:
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            for row_num, row in enumerate(reader, start=2):
                acct = clean(row.get("account_id", ""))
                if not acct:
                    continue

                # Status from links file is authoritative (scraper detail parser
                # may have inherited stale status from HTML structure)
                link_info = links.get(acct, {})
                status    = clean(link_info.get("status") or row.get("status", ""))

                # Committee type: prefer full TypeDesc from active download
                act_row   = active.get(acct, {})
                cmte_type = clean(act_row.get("TypeDesc") or
                                  CMTE_TYPE_MAP.get(clean(row.get("type", "")), "") or
                                  row.get("type", ""))

                # Address: prefer structured fields from active download
                if act_row:
                    addr1  = clean(act_row.get("Addr1", ""))
                    city   = clean(act_row.get("City", ""))
                    county = clean(act_row.get("County", ""))
                    zip_   = normalize_zip(act_row.get("Zip", ""))
                else:
                    # Fall back to combined address from detail page
                    addr1  = clean(row.get("address", ""))
                    county = ""
                    # Try to extract city/zip from combined address string
                    m = re.search(
                        r",\s+([A-Za-z\s]+),\s+FL\s+(\d{5})", addr1
                    )
                    city = m.group(1).strip() if m else ""
                    zip_ = m.group(2) if m else ""

                # Purpose and affiliates: scraper may have returned next-label
                # text when the field was empty — filter out known artifacts
                ARTIFACTS = {
                    "affiliates:", "campaign documents", "affiliates",
                    "", None,
                }
                purpose    = clean(row.get("purpose", ""))
                affiliates = clean(row.get("affiliates", ""))
                if purpose.lower().rstrip(":") in {a for a in ARTIFACTS if a}:
                    purpose = ""
                if affiliates.lower() in {a for a in ARTIFACTS if a}:
                    affiliates = ""

                # Treasurer: use name from detail page
                treas_name = clean(row.get("treasurer_name", ""))
                if not treas_name and act_row:
                    treas_last  = clean(act_row.get("TrsNameLast", ""))
                    treas_first = clean(act_row.get("TrsNameFirst", ""))
                    treas_name  = " ".join(filter(None, [treas_first, treas_last]))

                norm_name = utils.clean_name(row.get("name", ""))
                cmte_w.writerow({
                    "state":          STATE,
                    "committee_name": norm_name,
                    "committee_type": cmte_type,
                    "treasurer_name": treas_name,
                    "chairperson_name": clean(row.get("chairperson_name", "")),
                    "city":           city,
                    "zip":            zip_,
                    "active":         1 if status.lower() == "active" else 0,
                    "state_filer_id": acct,
                    "raw_file":       "fl_committee_details.csv",
                    "row_num":        row_num,
                })
                written_names.add(norm_name.lower())
                written += 1

        # ── Pass 2: synthesize candidate committees from transaction files ──
        # Candidate campaign committees only appear as the "Candidate/Committee"
        # column in contribution/expenditure files. strip_committee_type identifies
        # them by the two trailing paren groups (e.g. "Smith, John (REP)(GOV)").
        #
        # Build candidate_name → (AcctNum, election_year) from fl_candidates_*.txt
        # so synthesized rows get the real state_filer_id and election_year.
        # Keys are uppercased stripped committee names (lblCandName in TRACER), which
        # match what appears in the Candidate/Committee column of transaction files.
        # 2026-09-27: keyed by (name, OfficeCode), not name alone, and the
        # NEWEST registration wins instead of the first file read. Before
        # this, a candidate who had ever filed for another office (or for
        # the same office in an earlier cycle) collapsed onto one
        # synthesized committee carrying whichever AcctNum sorted first --
        # fl_candidates_2024_* reads before fl_candidates_2026_* -- so e.g.
        # Blaise Ingoglia's 2026 CFO account ("Ingoglia, Blaise (REP)(CFO)",
        # AcctNum 89394) was stamped with his 2024 State Senate AcctNum
        # 83632 / election_year 2024. The Supabase transform tracks
        # committees by the current cycle's candidate AcctNums, so his
        # entire CFO account was silently dropped ($0 on the site). The
        # office code is the second trailing paren group in the
        # transaction files' Candidate/Committee column, and matches the
        # bulk candidate files' OfficeCode column (CFO, ATG, STR, STS ...).
        #
        # Names are also indexed both as "LAST, FIRST" and "LAST, FIRST
        # MIDDLE": transaction files sometimes include the middle name
        # ("Rodriguez, Jose Javier (DEM)(ATG)") while the bulk file splits
        # it into NameMiddle, which left Jose Javier Rodriguez's AG account
        # with a hashed fallback id and no link to his candidate row.
        # (2026-10: the lookup moved to _candidate_accounts(), shared with
        # the transaction rows' state_filer_id -- see _FilerIds.)
        cand_by_office, cand_by_name = _candidate_accounts()

        # (norm_name, office_code) -> (cand_name, acct, elec_year)
        synthetic: dict[tuple[str, str], tuple[str, str, str]] = {}
        for pattern in ("fl_contributions_*.txt", "fl_expenditures_*.txt"):
            for tx_path in raw_files(pattern):
                with open(tx_path, newline="", encoding="utf-8",
                          errors="replace") as f:
                    for row in csv.DictReader(f, delimiter="\t", quoting=TXN_QUOTING):
                        raw = clean(row.get("Candidate/Committee", ""))
                        if not raw:
                            continue
                        cmte_name, cand_name = strip_committee_type(raw)
                        norm = utils.clean_name(cmte_name)
                        if not norm or norm.lower() in written_names:
                            continue
                        trailing = re.findall(r"\(([A-Z]{2,5})\)", raw)
                        office = trailing[-1] if cand_name and len(trailing) >= 2 else ""
                        key = (norm, office)
                        if key not in synthetic:
                            hit = (cand_by_office.get((norm, office)) if office else None) \
                                  or cand_by_name.get(norm)
                            acct, elec_year = (hit[0], hit[1]) if hit else ("", "")
                            synthetic[key] = (cand_name, acct, elec_year)

        synth_row_num = written + 2
        n_synth = 0
        seen_accts: set[str] = set()
        for (norm_name, office), (cand_name, acct, elec_year) in synthetic.items():
            # Fall back to name-hash only when no AcctNum was found
            if not acct:
                key  = f"{STATE}|{norm_name}|{office}".encode() if office \
                       else f"{STATE}|{norm_name}".encode()
                acct = str(int(hashlib.md5(key).hexdigest(), 16) % 1_000_000_000_000)
            # Two office codes can resolve to the same registration only via
            # the name-only fallback -- never emit a duplicate state_filer_id
            # (Supabase's committees table is unique on it).
            if acct in seen_accts:
                continue
            seen_accts.add(acct)
            cmte_w.writerow({
                "state":          STATE,
                "committee_name": norm_name,
                "committee_type": "Candidate Committee" if cand_name else "",
                "election_year":  elec_year,
                "candidate_name": utils.clean_name(cand_name),
                "state_filer_id": acct,
                "raw_file":       "fl_contributions/expenditures (synthesized)",
                "row_num":        synth_row_num,
            })
            written       += 1
            n_synth       += 1
            synth_row_num += 1

        log.info(f"  committees: {written - n_synth:,} from details + "
                 f"{n_synth:,} synthesized from transactions")

    finally:
        cmte_fh.close()

    log.file_parsed("fl_committee_details.csv", "committees", written,
                    bytes=path.stat().st_size)
    return written


# ========================== candidates ================================

def parse_candidates(log) -> int:
    """Parse fl_candidates_*.txt bulk files into candidates.csv.gz.

    Bulk files are the sole source — they provide everything needed for
    campaign finance analysis. AcctNums are deduplicated across files.
    """
    seen: set[str] = set()
    written = 0

    cand_fh, cand_w = open_writer("candidates.csv.gz", C.CANDIDATES)

    paths = raw_files("fl_candidates_*.txt")
    if not paths:
        log.warning("  [!] No candidate bulk files found — skipping candidates")
        cand_fh.close()
        return 0

    try:
        for path in paths:
            ft = __import__("time").perf_counter()
            row_count = 0

            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                reader = csv.DictReader(f, delimiter="\t")
                for row_num, row in enumerate(reader, start=2):
                    acct = clean(row.get("AcctNum", ""))
                    if not acct or acct in seen:
                        continue
                    seen.add(acct)

                    # Name from bulk (NameLast, NameFirst, NameMiddle)
                    last   = clean(row.get("NameLast",   ""))
                    first  = clean(row.get("NameFirst",  ""))
                    middle = clean(row.get("NameMiddle", ""))
                    full_name = utils.clean_name(
                        " ".join(filter(None, [first, middle, last]))
                    )

                    # District: Juris1num (district/circuit), Juris2num (group/seat)
                    juris1 = clean(row.get("Juris1num", "")).lstrip("0")
                    juris2 = clean(row.get("Juris2num", "")).lstrip("0")
                    district = juris1
                    if juris2:
                        district = f"{juris1} Group {juris2}" if juris1 else f"Group {juris2}"

                    elec_id   = clean(row.get("ElectionID", ""))
                    elec_year = election_year_from_id(elec_id)

                    cand_w.writerow({
                        "state":           STATE,
                        "candidate_name":  full_name,
                        "candidate_first": clean(first),
                        "candidate_last":  clean(last),
                        "office":          clean(row.get("OfficeDesc", "")),
                        "district":        district,
                        "party":           clean(row.get("PartyDesc",  "")),
                        "election_year":   elec_year,
                        "state_filer_id":  acct,
                        "raw_file":        path.name,
                        "row_num":         row_num,
                    })
                    row_count += 1
                    written   += 1

            log.file_parsed(path.name, "candidates", row_count,
                            duration_s=round(__import__("time").perf_counter() - ft, 2),
                            bytes=path.stat().st_size)
    finally:
        cand_fh.close()

    return written


# ========================= contributions ==============================

def _invert_name(name: str) -> str:
    """Convert 'Last, First' → 'FIRST LAST' to match the candidates table.
    FL transaction files store candidate names in committee format (Last, First);
    candidates.csv stores them as 'First Last' from the bulk file fields."""
    norm = utils.clean_name(name)
    if not norm:
        return ""
    if "," in norm:
        last, first = norm.split(",", 1)
        return f"{first.strip()} {last.strip()}".strip()
    return norm


# The organisation test of state-politics-tracker's old Florida importer
# (scripts/data-import/pilot/import_pilot_finance.py, ENTITY_PAT), verbatim.
_PILOT_ENTITY = re.compile(
    r"\b(INC|LLC|LLP|L\.L\.C|PAC|COMMITTEE|PARTY|CORP|CORPORATION|ASSN|"
    r"ASSOCIATION|COMPANY|FUND|GROUP|TRUST|BANK|ENTERPRISES|PARTNERS|"
    r"HOLDINGS|FLORIDA|AMERICA|USA|PA|PLLC|FARMS|SERVICES|CONSULTING|"
    r"REALTY|PROPERTIES|CLUB|COALITION|ALLIANCE|FEDERATION|UNION|CHAMBER)\b",
    re.I,
)


# Organisation markers the old importer's list missed, which put "FRIENDS OF
# COREY SIMON", "SHARP ENERGY", "ABC MERIT SHOP PC" and "GRIMES GALVANO PL"
# among candidates' top individual donors, split as people ("Of Corey Simon
# Friends"); checked against 2025-26 Florida contributions on 2026-10-20.
# Only words AFTER the first count: Florida writes a person surname first,
# and LAW, CHURCH, HOMES are surnames too ("LAW HEATHER BEAUCHAMP").
_ORG_WORDS = re.compile(
    r"\b(OF|FOR|THE|AND|P\.?\s?A|P\.?L|P\.?C|PLC|LLLP|LTD|CO|INCORPORATED|LIMITED|"
    r"STRATEGIES|STRATEGY|SPECIALISTS|HOSPITALS?|COOPERATIVE|CO-OP|FOUNDATION|INSTITUTE|"
    r"SOCIETY|COUNCIL|DEMOCRATS|REPUBLICANS|DEMOCRATIC|REPUBLICAN|DEC|REC|PBA|IAFF|LOCAL|"
    r"ASSOCIATES|SOLUTIONS|MANAGEMENT|DEVELOPMENT|DEVELOPERS|CONSTRUCTION|CONTRACTORS|"
    r"INDUSTRIES|INTERNATIONAL|NATIONAL|AMERICAN|SYSTEMS|TECHNOLOGIES|TECHNOLOGY|NETWORK|"
    r"MEDIA|MARKETING|INSURANCE|AGENCY|TITLE|LAW|ADVISORS|ADVISORY|CAPITAL|INVESTMENTS|"
    r"INVESTORS|VENTURES|EQUITY|FINANCIAL|HEALTHCARE|HEALTH|MEDICAL|CLINIC|CENTERS?|"
    r"PHARMACY|LABS|LABORATORIES|ACADEMY|SCHOOLS?|UNIVERSITY|COLLEGE|CHURCH|MINISTRIES|"
    r"RANCH|NURSERY|NURSERIES|GROVES|DAIRY|ENERGY|ELECTRIC|UTILITIES|GAS|OIL|POWER|MOTORS|"
    r"AUTO|AUTOMOTIVE|DEALERSHIP|HOMES|HOMEBUILDERS|BUILDERS|ENGINEERING|ARCHITECTS|"
    r"PRODUCTS|SUPPLY|DISTRIBUTORS|DISTRIBUTING|BEVERAGES?|FOODS|RESTAURANTS|HOTELS?|"
    r"RESORTS?|CASINO|GAMING|ENTERTAINMENT|AUTHORITY|DISTRICT|COUNTY|CITY|CAUCUS|VOTERS|"
    r"ACTION|VICTORY|MAJORITY|LEADERSHIP|PROSPERITY|TRIBE|PARTNERSHIP|ENTERPRISE|LOGISTICS|"
    r"TRANSPORT|TRANSPORTATION|AVIATION|MARINE|FARM|PLAZA|VILLAGE|VILLAS|APARTMENTS|"
    r"COMMUNITIES|LIVING|CARE|SERVICE|CORPS|BROTHERHOOD|WORKERS|EMPLOYEES|EDUCATORS|"
    r"TEACHERS|FIREFIGHTERS|OFFICERS|PROFESSIONALS|PHYSICIANS|DENTAL|DENTISTS|CHIROPRACTIC|"
    r"ORTHOPAEDIC|ORTHOPEDIC|SURGERY|SURGICAL|ANESTHESIA|RADIOLOGY|IMAGING|REHAB|"
    r"REHABILITATION|THERAPY|HOSPICE|NURSING|PHARMACEUTICALS)\b|[&@/]|\d",
    re.I,
)
# An occupation only an organisation files ("FRIENDS OF ..." gifts say
# POLITICAL ORGANIZATION; a law firm, LAW FIRM).
_ORG_OCCUPATION = re.compile(
    r"^(POLITICAL (COMMITTEE|ORGANIZATION|PARTY|ACTION COMMITTEE)|PAC|LAW FIRM|CPA FIRM|"
    r"CORPORATION|TRADE ASSOCIATION)$", re.I)
_NAME_SUFFIX = {"JR", "JR.", "SR", "SR.", "II", "III", "IV", "V"}


def is_florida_org(name: str, occupation: str = "") -> bool:
    """Whether a Florida contributor name is an organisation: the old
    importer's entity words, a single word, an organisation word after the
    first, or an organisation-only occupation."""
    name = clean(name)
    if not name:
        return False
    if _PILOT_ENTITY.search(name) or " " not in name:
        return True
    if _ORG_WORDS.search(name.split(None, 1)[1]):
        return True
    return bool(_ORG_OCCUPATION.match(clean(occupation)))


def contributor_name_parts(name: str, occupation: str = "") -> tuple[str, str]:
    """(first, last) for the loader-only contributor_first / contributor_last
    (columns.py, TRANSACTION_IDS), as state-politics-tracker has always
    stored Florida donors. Florida writes a person "LAST FIRST MIDDLE" with
    no separator, so the split is the old importer's: the first word is the
    surname, the rest the first name, both title-cased ("BLOOM JOHN" ->
    "John", "Bloom"); a suffix stays with the surname ("MANUEL III CLIFFORD
    E." -> "Clifford E.", "Manuel III", not "Iii Clifford E. Manuel"). An
    organisation (is_florida_org) stays whole in last, as written, with no
    first. The contributor_type column keeps SLCF's own classifier."""
    name = clean(name)
    if not name or is_florida_org(name, occupation):
        return "", name
    words = name.split()
    last = [words[0]]
    rest = []
    for w in words[1:]:
        (last if w.upper().strip(",") in _NAME_SUFFIX else rest).append(w.strip(","))
    if not rest:
        return "", name
    return " ".join(rest).title(), " ".join(
        w.upper() if w.upper().strip(".") in {"II", "III", "IV", "V"} else w.title() for w in last)


def _parse_contrib_row(row: dict, raw_file: str, row_num: int,
                       filer_ids=None) -> tuple[dict | None, dict | None]:
    """Map a raw contribution row to (contrib_out, loan_out).

    Returns (contrib, None) for normal contributions,
            (None, loan)   for Typ=LOA rows,
            (None, None)   for rows that should be skipped.
    """
    amount = parse_amount(row.get("Amount", ""))
    if not amount:
        return None, None

    # Drop rows where the contributor name is implausibly long — these are
    # malformed source rows where newlines weren't escaped and multiple records
    # got concatenated into a single field by the CSV parser.
    if len(row.get("Contributor Name", "") or "") > 200:
        return None, None

    date_  = parse_date(row.get("Date", ""))
    typ    = clean(row.get("Typ", ""))
    txn_type = TYP_MAP.get(typ, typ or "Other")

    committee_raw            = clean(row.get("Candidate/Committee", ""))
    committee, candidate_name = strip_committee_type(committee_raw)

    city, st, zip_ = split_city_state_zip(row.get("City State Zip", ""))

    base = {
        "state":             STATE,
        "committee_name":    committee,
        "amount":            amount,
        "date":              date_,
        "contributor_name":  clean(row.get("Contributor Name", "")),
        "contributor_type":  classify_contributor_type(clean(row.get("Contributor Name", ""))),
        "contributor_city":  city,
        "contributor_state": st,
        "contributor_zip":   zip_,
        "occupation":        clean(row.get("Occupation", "")),
        # Candidate name in the raw file is "Last, First" (the committee name
        # format). Invert to "FIRST LAST" to match the candidates table, which
        # builds names from separate NameFirst/NameLast fields in the bulk files.
        "candidate_name":    _invert_name(candidate_name),
        # Loader-only (columns.py, TRANSACTION_IDS): the committee's account
        # number. Florida's export has no transaction id and no amendment
        # flag, so txn_id and superseded stay blank and the loader hashes
        # the row.
        "state_filer_id":    filer_ids(committee_raw) if filer_ids else "",
        "raw_file":          raw_file,
        "row_num":           row_num,
    }

    if typ == "LOA":
        return None, {
            **base,
            "original_amount":     amount,
            "record_type":         "Loan",
            "counterparty_name":   base["contributor_name"],
            "counterparty_city":   city,
            "counterparty_state":  st,
            "counterparty_zip":    zip_,
        }

    first, last = contributor_name_parts(base["contributor_name"], base["occupation"])
    return {**base, "transaction_type": txn_type,
            "contributor_first": first, "contributor_last": last}, None


def parse_contributions(log) -> tuple[int, int]:
    """Parse fl_contributions_{year}.txt files into contributions.csv.gz.

    Also reads fl_transfers_{year}.txt (routed here with type=Transfer).
    Loan rows (Typ=LOA) are diverted to loans_debts.
    Returns (contributions_written, loans_written).
    """
    cont_fh, cont_w = open_writer("contributions.csv.gz", C.CONTRIBUTIONS)
    loan_fh, loan_w = open_writer("loans_debts.csv.gz",   C.LOANS_DEBTS)

    total_cont = total_loan = 0
    filer_ids  = _FilerIds()

    # Contribution files + transfer files (transfers = inter-committee contributions)
    file_groups = [
        ("fl_contributions_*.txt", "contributions"),
        ("fl_transfers_*.txt",     "transfers"),
    ]

    try:
        for pattern, kind in file_groups:
            paths = raw_files(pattern)
            if not paths:
                continue

            for path in paths:
                ft        = __import__("time").perf_counter()
                file_cont = file_loan = 0

                with open(path, newline="", encoding="utf-8",
                          errors="replace") as f:
                    reader = csv.DictReader(f, delimiter="\t", quoting=TXN_QUOTING)

                    with logging_redirect_tqdm(loggers=[log._log]):
                        for row_num, row in enumerate(
                            tqdm(reader, desc=f"  {path.name}",
                                 unit="row", dynamic_ncols=True),
                            start=2,
                        ):
                            contrib, loan = _parse_contrib_row(
                                _unquote(row), path.name, row_num, filer_ids
                            )
                            if contrib:
                                if kind == "transfers":
                                    contrib["transaction_type"] = "Transfer"
                                cont_w.writerow(contrib)
                                file_cont += 1
                            elif loan:
                                loan_w.writerow(loan)
                                file_loan += 1

                total_cont += file_cont
                total_loan += file_loan
                log.file_parsed(
                    path.name, kind, file_cont + file_loan,
                    duration_s=round(__import__("time").perf_counter() - ft, 2),
                    bytes=path.stat().st_size,
                )
    finally:
        cont_fh.close()
        loan_fh.close()

    return total_cont, total_loan


# ========================= expenditures ==============================

def _parse_expend_row(row: dict, raw_file: str,
                      row_num: int, txn_type: str = "",
                      filer_ids=None) -> dict | None:
    """Map a raw expenditure/other-distribution row to an expenditure output row."""
    amount = parse_amount(row.get("Amount", ""))
    if not amount:
        return None

    date_ = parse_date(row.get("Date", ""))

    committee_raw  = clean(row.get("Candidate/Committee", ""))
    committee, _   = strip_committee_type(committee_raw)

    # Payee name: expenditures use "Payee Name", other distributions
    # "Distributed To" (2026-10; "Recipient Name" never appears, so every
    # other distribution's payee was blank)
    payee = clean(
        row.get("Payee Name") or row.get("Distributed To") or
        row.get("Recipient Name") or row.get("Transferred To") or ""
    )

    city, st, zip_ = split_city_state_zip(row.get("City State Zip", ""))

    purpose = clean(row.get("Purpose", "") or row.get("Purpose of Expenditure", ""))

    if not txn_type:
        txn_type = clean(row.get("Typ", "") or row.get("Type", ""))

    return {
        "state":          STATE,
        "committee_name": committee,
        "amount":         amount,
        "date":           date_,
        "transaction_type": txn_type,
        "payee_name":     payee,
        "purpose":        purpose,
        "payee_city":     city,
        "payee_state":    st,
        "payee_zip":      zip_,
        # Loader-only, as on contributions (see _parse_contrib_row).
        "state_filer_id": filer_ids(committee_raw) if filer_ids else "",
        "raw_file":       raw_file,
        "row_num":        row_num,
    }


def parse_expenditures(log) -> int:
    """Parse fl_expenditures_{year}.txt and fl_other_{year}.txt into expenditures.csv.gz.

    Other distributions (fl_other_*.txt) are routed here with
    transaction_type='Other Distribution'.
    """
    expend_fh, expend_w = open_writer("expenditures.csv.gz", C.EXPENDITURES)
    total = 0
    filer_ids = _FilerIds()

    file_groups = [
        ("fl_expenditures_*.txt", ""),                    # type from raw Typ field
        ("fl_other_*.txt",        "Other Distribution"),  # fixed type
    ]

    try:
        for pattern, forced_type in file_groups:
            paths = raw_files(pattern)
            if not paths:
                continue

            for path in paths:
                ft        = __import__("time").perf_counter()
                file_rows = 0

                with open(path, newline="", encoding="utf-8",
                          errors="replace") as f:
                    reader = csv.DictReader(f, delimiter="\t", quoting=TXN_QUOTING)

                    with logging_redirect_tqdm(loggers=[log._log]):
                        for row_num, row in enumerate(
                            tqdm(reader, desc=f"  {path.name}",
                                 unit="row", dynamic_ncols=True),
                            start=2,
                        ):
                            out = _parse_expend_row(
                                _unquote(row), path.name, row_num, forced_type, filer_ids
                            )
                            if out:
                                expend_w.writerow(out)
                                file_rows += 1

                total += file_rows
                log.file_parsed(
                    path.name, "expenditures", file_rows,
                    duration_s=round(__import__("time").perf_counter() - ft, 2),
                    bytes=path.stat().st_size,
                )
    finally:
        expend_fh.close()

    return total


# ============================= run ====================================

def run():
    import time

    log = get_logger("florida", "parse")
    t0  = time.perf_counter()
    log._emit("parse_started")

    total_committees    = 0
    total_candidates    = 0
    total_contributions = 0
    total_loans         = 0
    total_expenditures  = 0
    file_handles        = []

    try:
        log.info("Parsing Florida committees...")
        total_committees = parse_committees(log)

        log.info("Parsing Florida candidates...")
        total_candidates = parse_candidates(log)

        log.info("Parsing Florida contributions + transfers...")
        total_contributions, total_loans = parse_contributions(log)

        log.info("Parsing Florida expenditures + other distributions...")
        total_expenditures = parse_expenditures(log)

        # Assign person IDs — must happen after all file handles are closed.
        # id_model="committee": same candidate across cycles gets person_id=min(state_filer_id)
        log.info("Assigning person IDs...")
        utils.assign_person_ids(CLEAN_DIR / "candidates.csv.gz",
                                id_model="committee")
        utils.assign_committee_person_ids(CLEAN_DIR / "committees.csv.gz",
                                          CLEAN_DIR / "candidates.csv.gz")

        def _bytes(name: str) -> int:
            p = CLEAN_DIR / name
            return p.stat().st_size if p.exists() else 0

        log.file_parsed("contributions.csv.gz", "contributions",
                        total_contributions, role="output",
                        bytes=_bytes("contributions.csv.gz"))
        log.file_parsed("expenditures.csv.gz", "expenditures",
                        total_expenditures, role="output",
                        bytes=_bytes("expenditures.csv.gz"))
        log.file_parsed("candidates.csv.gz", "candidates",
                        total_candidates, role="output",
                        bytes=_bytes("candidates.csv.gz"))
        log.file_parsed("committees.csv.gz", "committees",
                        total_committees, role="output",
                        bytes=_bytes("committees.csv.gz"))
        log.file_parsed("loans_debts.csv.gz", "loans_debts",
                        total_loans, role="output",
                        bytes=_bytes("loans_debts.csv.gz"))

        duration = round(time.perf_counter() - t0, 1)
        log._emit("parse_completed", status="completed", duration_s=duration,
                  contributions=total_contributions,
                  expenditures=total_expenditures,
                  committees=total_committees,
                  candidates=total_candidates)

    except KeyboardInterrupt:
        log._emit("parse_completed", status="interrupted",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions,
                  expenditures=total_expenditures,
                  committees=total_committees,
                  candidates=total_candidates)
        raise

    except Exception as e:
        log._emit("parse_completed", status="error",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions,
                  expenditures=total_expenditures,
                  committees=total_committees,
                  candidates=total_candidates,
                  error_type=type(e).__name__, error=str(e))
        raise

    finally:
        for fh in file_handles:
            try:
                fh.close()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
