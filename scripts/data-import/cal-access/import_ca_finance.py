#!/usr/bin/env python3
"""
CAL-ACCESS → Supabase importer for CA Governor 2026 campaign finance.

Moved here from ca-gov-polling in Oct 2026, unchanged apart from where it
writes: the shared tracker project's ca_* staging tables
(supabase/migrations/20261018160000_california_staging.sql). The nightly
publish_california_to_cf() then copies the settled rows into cf_*, which
the site reads. See docs/plan.md, "California joins the hub".

Downloads the SOS CAL-ACCESS bulk dump, filters to the candidates in
`ca_candidates` (a view: cf_candidates' California rows joined to their
CAL-ACCESS filer ids in ca_candidate_filers), and upserts:
  - ca_filings
  - ca_contributions (RCPT_CD filtered to our committees)
  - ca_expenditures (EXPN_CD filtered to our committees)
  - ca_ie_committees + ca_independent_expenditures
    (F496/F461 filings where CAND_ID matches our candidate filer IDs)
  - ca_ie_contributions (RCPT_CD receipts into those IE committees, cycle-scoped)
  - ca_summaries (SMRY_CD cover-page totals; backs total_raised's unitemized line)
  - ca_loans (LOAN_CD Schedule B loans received by our committees)

Env vars (required):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage:
  pip install -r requirements.txt
  python import_ca_finance.py                 # full pipeline
  python import_ca_finance.py --skip-download # reuse /tmp/calaccess
  python import_ca_finance.py --only filings  # one stage
"""

import argparse
import csv
import logging
import os
import re
import sys
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional
from urllib.request import Request, urlopen

from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("ca-finance")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CAL_ACCESS_URL = "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip"
WORK_DIR = Path(os.environ.get("CAL_ACCESS_WORK_DIR", "/tmp/calaccess"))
ZIP_PATH = WORK_DIR / "dbwebexport.zip"
DATA_DIR = WORK_DIR / "CalAccess" / "DATA"

PRIMARY_DATE = date(2026, 6, 2)
GENERAL_DATE = date(2026, 11, 3)
# Earliest allowed transaction date for the 2026 cycle. Anything earlier is
# from a prior campaign (e.g. Porter's 2024 Senate run, Villaraigosa's 2018
# governor bid) and should be excluded even though the candidate name matches.
CYCLE_START = date(2025, 1, 1)

TSV_FILES = [
    "CVR_CAMPAIGN_DISCLOSURE_CD.TSV",
    "FILERNAME_CD.TSV",
    "RCPT_CD.TSV",
    "EXPN_CD.TSV",
    "S496_CD.TSV",
    "S497_CD.TSV",
    "SMRY_CD.TSV",
    "LOAN_CD.TSV",
]

BATCH_SIZE = 500

# Extra IE committees that the F496/F461 crawl misses — typically ballot-measure
# or party-aligned vehicles that don't file IE reports against a specific
# candidate but materially fund the race (e.g. Brin's $48M to "Building A
# Better California"). Values are fallback display names if FILERNAME_CD
# lacks the filer; real names are pulled from that file when available.
ALLOWLISTED_IE_FILER_IDS: Dict[int, str] = {
    1486767: "BUILDING A BETTER CALIFORNIA",
    # Supports Becerra. The name includes "BECERRA" and "GOVERNOR", but only the
    # candidate's last name — the committee-name regex requires first+last
    # adjacent ("XAVIER BECERRA"), so it never matched. Allowlisting force-adds
    # it to ca_ie_committees so its donors are captured even before it files IE
    # reports; ca_ie_committee_targets pins the Becerra attribution.
    1490885: "WORKING FAMILIES FOR HEALTHY COMMUNITIES SUPPORTING BECERRA FOR GOVERNOR 2026",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_calaccess_date(raw: str) -> Optional[str]:
    """CAL-ACCESS date format: 'M/D/YYYY 12:00:00 AM'. Return ISO YYYY-MM-DD or None."""
    if not raw or not raw.strip():
        return None
    raw = raw.strip().split(" ")[0]
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def classify_cycle(iso_date: Optional[str]) -> str:
    if not iso_date:
        return "unknown"
    try:
        d = date.fromisoformat(iso_date)
    except ValueError:
        return "unknown"
    # Reject dates before the 2026 cycle started so prior-campaign rows
    # (Porter 2024 Senate, Villaraigosa 2018 governor, Steyer 2020 POTUS)
    # don't aggregate into 2026 totals downstream.
    if d < CYCLE_START:
        return "pre-cycle"
    if d <= PRIMARY_DATE:
        return "primary-2026"
    if d <= GENERAL_DATE:
        return "general-2026"
    return "post-2026"


def to_decimal(raw: str) -> Optional[float]:
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def to_int(raw: str) -> Optional[int]:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def stream_tsv(path: Path) -> Iterator[dict]:
    """Stream rows from a CAL-ACCESS TSV, skipping lines with field-count mismatch.

    CAL-ACCESS TSVs do not quote fields and occasionally have embedded newlines
    and NUL bytes (0x00) in text fields, which produces ragged rows or breaks
    csv parsing. We strip NUL bytes and skip ragged rows rather than fail.
    """

    def denulled(fh):
        for line in fh:
            if "\x00" in line:
                yield line.replace("\x00", "")
            else:
                yield line

    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.reader(denulled(fh), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)
        n = len(header)
        skipped = 0
        for row in reader:
            if len(row) != n:
                skipped += 1
                continue
            yield dict(zip(header, row))
        if skipped:
            logger.warning("skipped %d malformed rows in %s", skipped, path.name)


def upsert_batch(sb, table: str, rows: list, on_conflict: str):
    """Upsert rows to Supabase, deduping on the conflict key so Postgres doesn't
    reject the batch with 'ON CONFLICT DO UPDATE cannot affect row a second time'."""
    if not rows:
        return 0
    keys = [k.strip() for k in on_conflict.split(",")]
    seen: dict = {}
    for r in rows:
        key = tuple(r.get(k) for k in keys)
        seen[key] = r  # last write wins within the batch
    deduped = list(seen.values())
    sb.table(table).upsert(deduped, on_conflict=on_conflict).execute()
    return len(deduped)


# ---------------------------------------------------------------------------
# Download + extract
# ---------------------------------------------------------------------------


def download_bulk():
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    if ZIP_PATH.exists() and ZIP_PATH.stat().st_size > 1_000_000_000:
        logger.info("zip already downloaded: %s", ZIP_PATH)
        return
    logger.info("downloading CAL-ACCESS bulk zip (~1.5 GB)...")
    req = Request(CAL_ACCESS_URL, headers={"User-Agent": "state-politics-tracker-ingest/1.0"})
    with urlopen(req, timeout=600) as resp, ZIP_PATH.open("wb") as out:
        chunk = 1 << 20
        total = 0
        while True:
            data = resp.read(chunk)
            if not data:
                break
            out.write(data)
            total += len(data)
            if total % (100 * chunk) == 0:
                logger.info("  ... %.0f MB", total / 1_000_000)
    logger.info("downloaded %.1f GB", ZIP_PATH.stat().st_size / 1_000_000_000)


def extract_tsvs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ZIP_PATH) as zf:
        for name in TSV_FILES:
            target = DATA_DIR / name
            if target.exists() and target.stat().st_size > 0:
                logger.info("already extracted: %s (%.1f MB)", name, target.stat().st_size / 1_000_000)
                continue
            member = f"CalAccess/DATA/{name}"
            logger.info("extracting %s ...", name)
            with zf.open(member) as src, target.open("wb") as out:
                while True:
                    data = src.read(1 << 20)
                    if not data:
                        break
                    out.write(data)
            logger.info("  wrote %.1f MB", target.stat().st_size / 1_000_000)


def match_committees_by_name(
    sb,
    by_candidate: Dict[int, "SeedCandidate"],
    by_committee: Dict[int, "SeedCandidate"],
) -> Dict[int, tuple]:
    """Identify IE committees primarily formed for one of our 24 candidates.
    Builds the filer_id → (SeedCandidate, support/oppose) map from three
    sources, in priority order:

      1. ca_ie_committee_targets — manually curated (filer_id, candidate,
         support_oppose) rows. Highest priority; never overridden.
      2. ca_ie_committees — apply the committee-name regex to names already
         in our DB (including names loaded via earlier POWERSEARCH ingest
         that aren't in FILERNAME_CD).
      3. FILERNAME_CD — auto-discover newly-registered PACs.

    The regex (used by passes 2 and 3) matches either the candidate's
    first+last name paired with a "GOVERNOR" signal, OR the surname directly
    followed by "FOR GOVERNOR". FPPC §84107 requires "primarily formed"
    committees to identify both the candidate and the office in the committee
    name, so PACs like "CALIFORNIA BACK TO BASICS SUPPORTING MATT MAHAN FOR
    GOVERNOR 2026" show "MATT MAHAN" + "GOVERNOR", while last-name-only names
    like "...SUPPORTING BECERRA FOR GOVERNOR 2026" are caught by the
    "BECERRA FOR GOVERNOR" form. Both keep precision high.

    Returns: filer_id -> (SeedCandidate, support_oppose code)
      where 'O' is inferred from words like OPPOSING/AGAINST/STOP/DEFEAT
      in the name (regex passes only), otherwise 'S'.
    """
    governor_re = re.compile(r"\bGOVERNOR\b")
    oppose_words = ("OPPOSING", "OPPOSE", "AGAINST", "STOP", "DEFEAT", "NO ON")
    candidate_patterns = []
    for c in by_candidate.values():
        parts = c.name.split()
        if len(parts) < 2:
            continue
        first = re.escape(parts[0].upper())
        last = re.escape(parts[-1].upper())
        # Three accepted forms:
        #   "FIRST LAST"          — "XAVIER BECERRA"
        #   "LAST, FIRST"         — "BECERRA, XAVIER"
        #   "LAST FOR GOVERNOR"   — "BECERRA FOR GOVERNOR" (last-name-only)
        # The first two pair with the separate GOVERNOR guard below. The third
        # is self-guarding: requiring the surname immediately before "FOR
        # GOVERNOR" keeps precision high (only an actual gubernatorial bid
        # phrases it that way), so we still catch committees that brand with the
        # last name only — e.g. "...SUPPORTING BECERRA FOR GOVERNOR 2026", which
        # the first+last requirement used to miss.
        full_pat = re.compile(
            rf"\b{first}\s+{last}\b"
            rf"|\b{last}\s*,\s*{first}\b"
            rf"|\b{last}\s+FOR\s+GOVERNOR\b"
        )
        candidate_patterns.append((c, full_pat))

    name_to_target: Dict[int, tuple] = {}
    seen: set = set()
    by_candidate_id: Dict[str, "SeedCandidate"] = {c.id: c for c in by_candidate.values()}

    def _try_match(fid: int, name: str) -> None:
        """Apply the regex to a single (filer_id, name) pair."""
        if not fid or fid in seen or fid in by_committee:
            return
        seen.add(fid)
        name_upper = (name or "").upper()
        if not name_upper or not governor_re.search(name_upper):
            return
        for cand, full_pat in candidate_patterns:
            if full_pat.search(name_upper):
                sup_opp = "O" if any(w in name_upper for w in oppose_words) else "S"
                name_to_target[fid] = (cand, sup_opp)
                return

    # Pass 0: explicit curated mappings from ca_ie_committee_targets.
    # These take priority — once an explicit target is set for a filer_id,
    # neither regex pass overrides it.
    explicit = 0
    try:
        res = sb.table("ca_ie_committee_targets").select(
            "ie_committee_filer_id,target_candidate_id,support_oppose"
        ).execute()
        for row in (res.data or []):
            fid = int(row.get("ie_committee_filer_id") or 0)
            cand = by_candidate_id.get(row.get("target_candidate_id") or "")
            sup_opp = (row.get("support_oppose") or "S").upper()
            if not fid or not cand or fid in by_committee:
                continue
            # First explicit entry wins per filer (single-target dict). Multi-
            # target PACs add multiple table rows but Schedule E per-row
            # CAND_NAML matching disambiguates them anyway; this fallback
            # only fires when CAND_NAML is empty.
            if fid not in name_to_target:
                name_to_target[fid] = (cand, sup_opp)
            seen.add(fid)
            explicit += 1
    except Exception as e:
        logger.warning("ca_ie_committee_targets lookup failed: %s", e)

    # Pass 1: regex against existing rows in ca_ie_committees. These include
    # names loaded via POWERSEARCH manual ingest not in FILERNAME_CD.
    try:
        res = sb.table("ca_ie_committees").select("filer_id,name").execute()
        for row in (res.data or []):
            fid = int(row.get("filer_id") or 0)
            _try_match(fid, row.get("name") or "")
    except Exception as e:
        logger.warning("ca_ie_committees lookup for name match failed: %s", e)

    # Pass 2: FILERNAME_CD scan for newly-registered PACs we don't have yet.
    path = DATA_DIR / "FILERNAME_CD.TSV"
    for row in stream_tsv(path):
        fid = to_int(row.get("FILER_ID", ""))
        _try_match(fid, row.get("NAML") or "")

    logger.info(
        "matched %d IE committees to candidates (%d explicit from ca_ie_committee_targets)",
        len(name_to_target),
        explicit,
    )
    # Print up to 10 examples so the log makes the matching auditable.
    for fid, (cand, sup_opp) in list(name_to_target.items())[:10]:
        logger.info("  %d → %s (%s)", fid, cand.name, sup_opp)
    return name_to_target


# ---------------------------------------------------------------------------
# Load seeded candidates from Supabase
# ---------------------------------------------------------------------------


@dataclass
class SeedCandidate:
    id: str
    slug: str
    name: str
    candidate_filer_id: int
    committee_filer_id: int


def load_seed_candidates(sb) -> tuple[Dict[int, SeedCandidate], Dict[int, SeedCandidate]]:
    """Returns (committee_map, candidate_map) keyed by filer_id."""
    res = sb.table("ca_candidates").select(
        "id,slug,name,candidate_filer_id,committee_filer_id"
    ).execute()
    by_committee: Dict[int, SeedCandidate] = {}
    by_candidate: Dict[int, SeedCandidate] = {}
    for row in res.data or []:
        c = SeedCandidate(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            candidate_filer_id=int(row["candidate_filer_id"]),
            committee_filer_id=int(row["committee_filer_id"]) if row.get("committee_filer_id") else 0,
        )
        if c.committee_filer_id:
            by_committee[c.committee_filer_id] = c
        by_candidate[c.candidate_filer_id] = c
    logger.info(
        "loaded %d candidates (%d committees) from ca_candidates",
        len(by_candidate),
        len(by_committee),
    )
    return by_committee, by_candidate


# ---------------------------------------------------------------------------
# Stage 1: filings + IE target discovery
# ---------------------------------------------------------------------------


def _norm_name(s: str) -> str:
    return (s or "").strip().upper().replace(".", "").replace(",", "")


def import_filings(
    sb,
    by_committee: Dict[int, SeedCandidate],
    by_candidate: Dict[int, SeedCandidate],
    primarily_formed: Dict[int, tuple],
):
    """Parse CVR_CAMPAIGN_DISCLOSURE_CD and upsert ca_filings for:
      (a) filings by our committees (matched on FILER_ID)
      (b) F496 filings targeting our candidates by CAND_NAML on the cover row
      (c) F496 / F461 filings by primarily-formed IE committees we recognized
          via committee-name match against FILERNAME_CD (BACK TO BASICS
          SUPPORTING MAHAN, DELIVER FOR CALIFORNIA - MAHAN, etc.). This is
          the only path that catches F496 covers with empty/odd CAND_NAML
          and F461 covers in general (which never carry CAND_NAML).

    Returns (relevant, f461_covers, ie_pac_f460_covers):
      - relevant: filing_id -> dict(...metadata...) for filings that hit any
        of (a)/(b)/(c). Tracks from_committee / is_ie / target_candidate_id.
      - f461_covers: filing_id -> [cover_record, ...] for every F461 cover seen
        (regardless of name match). Stage 4b consumes this to upsert ca_filings
        rows for F461 filings that turn out to be IE.
      - ie_pac_f460_covers: filing_id -> [cover_record, ...] for F460
        quarterly disclosures filed by primarily-formed IE PACs. Stage 4b
        scans EXPN_CD for Schedule E rows on these filings (the IE
        committee's own quarterly schedule of independent expenditures).
    """
    # Build name index from candidate last-name combos for IE matching.
    # Keyed by (upper(last), upper(first)) — first-name matching uses first token only
    # so variations like "Betty T." vs "BETTY" still hit.
    name_index: Dict[tuple, SeedCandidate] = {}
    for c in by_candidate.values():
        # Candidate.name is "Katie Porter" etc.; take last token as surname
        parts = c.name.split()
        if not parts:
            continue
        last = _norm_name(parts[-1])
        first = _norm_name(parts[0])
        name_index[(last, first)] = c
        # Also store last-name-only as fallback
        name_index[(last, "")] = c

    path = DATA_DIR / "CVR_CAMPAIGN_DISCLOSURE_CD.TSV"
    buffer: list = []
    relevant: Dict[int, dict] = {}
    f461_covers: Dict[int, list] = {}
    ie_pac_f460_covers: Dict[int, list] = {}
    total = 0
    for row in stream_tsv(path):
        filer_id = to_int(row.get("FILER_ID", ""))
        form_type = row.get("FORM_TYPE", "").strip()
        cand_naml = row.get("CAND_NAML", "").strip()
        cand_namf = row.get("CAND_NAMF", "").strip()

        by_committee_hit = filer_id in by_committee

        # IE detection: try cover-row name match first, then fall back to the
        # primarily-formed committee match (committee NAML matches a candidate).
        # F465 is a slate-mailer org statement and not an IE — never matched.
        ie_target: Optional[SeedCandidate] = None
        sup_opp_override: Optional[str] = None
        if form_type == "F496" and cand_naml:
            last = _norm_name(cand_naml)
            first_tok = _norm_name(cand_namf.split()[0]) if cand_namf else ""
            ie_target = name_index.get((last, first_tok)) or name_index.get((last, ""))
        if ie_target is None and form_type in ("F496", "F461"):
            pf = primarily_formed.get(filer_id)
            if pf is not None:
                ie_target, sup_opp_override = pf

        by_ie_hit = ie_target is not None

        # Cache every F461 cover so Stage 4b can look up filer_id by filing_id
        # and upsert ca_filings rows for the ones that turn out to be IE.
        if form_type == "F461":
            filing_id = to_int(row.get("FILING_ID", ""))
            if filing_id is not None and filer_id is not None:
                f461_covers.setdefault(filing_id, []).append({
                    "filing_id": filing_id,
                    "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
                    "filer_id": filer_id,
                    "form_type": form_type,
                    "stmt_type": row.get("STMT_TYPE", "").strip() or None,
                    "rpt_start": parse_calaccess_date(row.get("FROM_DATE", "")),
                    "rpt_end": parse_calaccess_date(row.get("THRU_DATE", "")),
                    "elect_date": parse_calaccess_date(row.get("ELECT_DATE", "")),
                    "filed_date": parse_calaccess_date(row.get("RPT_DATE", "")),
                    "office_cd": row.get("OFFICE_CD", "").strip() or None,
                    "sup_opp_cd": row.get("SUP_OPP_CD", "").strip() or None,
                })

        # Cache F460 covers filed by primarily-formed IE PACs. Their quarterly
        # disclosures carry Schedule E (independent expenditures) detail in
        # EXPN_CD that we'd otherwise miss — Stage 4b only scans F461 covers.
        # Concrete case: CALIFORNIA BACK TO BASICS SUPPORTING MATT MAHAN
        # (filer 1487425) and DELIVER FOR CALIFORNIA (filer 1488176) file
        # F460 quarterlies with $9.5M+ of pro-Mahan IE on Schedule E that
        # were silently dropped before this path existed.
        if form_type == "F460" and filer_id in primarily_formed:
            filing_id = to_int(row.get("FILING_ID", ""))
            if filing_id is not None and filer_id is not None:
                ie_pac_f460_covers.setdefault(filing_id, []).append({
                    "filing_id": filing_id,
                    "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
                    "filer_id": filer_id,
                    "form_type": form_type,
                    "stmt_type": row.get("STMT_TYPE", "").strip() or None,
                    "rpt_start": parse_calaccess_date(row.get("FROM_DATE", "")),
                    "rpt_end": parse_calaccess_date(row.get("THRU_DATE", "")),
                    "elect_date": parse_calaccess_date(row.get("ELECT_DATE", "")),
                    "filed_date": parse_calaccess_date(row.get("RPT_DATE", "")),
                    "office_cd": row.get("OFFICE_CD", "").strip() or None,
                    "sup_opp_cd": row.get("SUP_OPP_CD", "").strip() or None,
                })

        if not (by_committee_hit or by_ie_hit):
            continue

        filing_id = to_int(row.get("FILING_ID", ""))
        amend_id = to_int(row.get("AMEND_ID", "")) or 0
        if filing_id is None:
            continue

        record = {
            "filing_id": filing_id,
            "amend_id": amend_id,
            "filer_id": filer_id,
            "form_type": form_type,
            "stmt_type": row.get("STMT_TYPE", "").strip() or None,
            "rpt_start": parse_calaccess_date(row.get("FROM_DATE", "")),
            "rpt_end": parse_calaccess_date(row.get("THRU_DATE", "")),
            "elect_date": parse_calaccess_date(row.get("ELECT_DATE", "")),
            "filed_date": parse_calaccess_date(row.get("RPT_DATE", "")),
            "office_cd": row.get("OFFICE_CD", "").strip() or None,
            "cand_filer_id": ie_target.candidate_filer_id if ie_target else None,
            "cand_last_name": cand_naml or None,
            "cand_first_name": cand_namf or None,
            "sup_opp_cd": (sup_opp_override or row.get("SUP_OPP_CD", "").strip()) or None,
        }
        buffer.append(record)
        relevant[filing_id] = {
            "filer_id": filer_id,
            "form_type": form_type,
            "cand_filer_id": ie_target.candidate_filer_id if ie_target else None,
            "target_candidate_id": ie_target.id if ie_target else None,
            "sup_opp_cd": record["sup_opp_cd"],
            "amend_id": amend_id,
            "from_committee": by_committee_hit,
            "is_ie": by_ie_hit,
        }

        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_filings", buffer, "filing_id,amend_id")
            buffer = []

    total += upsert_batch(sb, "ca_filings", buffer, "filing_id,amend_id")
    ie_count = sum(1 for m in relevant.values() if m["is_ie"])
    own_count = sum(1 for m in relevant.values() if m["from_committee"])
    logger.info(
        "upserted %d filings (from our committees: %d, F496/F461 IE: %d, "
        "F461 covers cached: %d, IE-PAC F460 covers cached: %d)",
        total,
        own_count,
        ie_count,
        len(f461_covers),
        len(ie_pac_f460_covers),
    )
    return relevant, f461_covers, ie_pac_f460_covers


# ---------------------------------------------------------------------------
# Stage 2: contributions (RCPT_CD)
# ---------------------------------------------------------------------------


def import_contributions(
    sb,
    by_committee: Dict[int, SeedCandidate],
    relevant_filings: Dict[int, dict],
):
    """RCPT_CD rows don't have FILER_ID — join via FILING_ID to a committee filer
    via the relevant_filings index (which holds filings from our 24 committees).

    Pre-cycle rows (date < CYCLE_START) are dropped so prior-campaign donations
    don't get aggregated into 2026 totals — Porter has 2024 Senate receipts on
    her current committee, Villaraigosa has 2018 governor receipts, etc.

    Two-pass to capture the full F497 (late-contribution) detail:
      Pass 1 — RCPT_CD: Form 460 Schedule A entries plus the F497 receipts
        that CAL-ACCESS happens to mirror into RCPT_CD.
      Pass 2 — S497_CD: every F497P1 row for our committees' filings. Some
        F497 filings carry their detail ONLY in S497_CD, never in RCPT_CD,
        so reading just RCPT_CD silently drops them. Stage 5 already does
        this for IE committees; we mirror it for the candidate side.

    Both passes upsert into ca_contributions with the same
    (filing_id, amend_id, tran_id) key, so a row appearing in both files
    naturally collapses to one DB row. Cross-filing F497-vs-F460 dedup
    happens at the view layer in ca_contributions_deduped."""
    cycle_start_iso = CYCLE_START.isoformat()
    path = DATA_DIR / "RCPT_CD.TSV"
    # filing_id -> committee_filer_id, for filings from our committees only
    filing_to_committee = {
        fid: meta["filer_id"]
        for fid, meta in relevant_filings.items()
        if meta.get("from_committee") and meta.get("filer_id") in by_committee
    }
    logger.info("contributions: %d filings from our committees to scan", len(filing_to_committee))
    buffer: list = []
    total = 0
    skipped_old = 0
    for row in stream_tsv(path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        filer_id = filing_to_committee[filing_id]

        tran_id = row.get("TRAN_ID", "").strip()
        if filing_id is None or not tran_id:
            continue

        cand = by_committee[filer_id]
        amount = to_decimal(row.get("AMOUNT", ""))
        if amount is None:
            continue

        date_iso = parse_calaccess_date(row.get("RCPT_DATE", ""))
        if date_iso and date_iso < cycle_start_iso:
            skipped_old += 1
            continue

        record = {
            "candidate_id": cand.id,
            "committee_filer_id": filer_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "contributor_type": row.get("ENTITY_CD", "").strip() or None,
            "contributor_last_name": row.get("CTRIB_NAML", "").strip() or None,
            "contributor_first_name": row.get("CTRIB_NAMF", "").strip() or None,
            "employer": row.get("CTRIB_EMP", "").strip() or None,
            "occupation": row.get("CTRIB_OCC", "").strip() or None,
            "amount": amount,
            "contribution_date": date_iso,
            "cumulative_ytd": to_decimal(row.get("CUM_YTD", "")),
            "city": row.get("CTRIB_CITY", "").strip() or None,
            "state": row.get("CTRIB_ST", "").strip() or None,
            "zip": row.get("CTRIB_ZIP4", "").strip() or None,
            "cycle": classify_cycle(date_iso),
            "source_form_type": row.get("FORM_TYPE", "").strip() or None,
            # TRAN_TYPE='X' marks cross-reference/memo entries that re-report a
            # contribution already counted elsewhere; ca_contributions_deduped
            # drops them to match PowerSearch. Must be populated every run or the
            # filter silently decays as new X rows are filed.
            "tran_type": row.get("TRAN_TYPE", "").strip() or None,
        }
        buffer.append(record)

        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_contributions", buffer, "filing_id,amend_id,tran_id")
            buffer = []
            if total % 10_000 == 0:
                logger.info("  contributions: %d upserted so far", total)

    total += upsert_batch(sb, "ca_contributions", buffer, "filing_id,amend_id,tran_id")
    logger.info("RCPT_CD pass: upserted %d contributions (skipped %d pre-cycle)", total, skipped_old)

    # Pass 2: S497_CD. F497 late-contribution detail that may not be mirrored
    # into RCPT_CD lives here. We saw concrete cases of Steyer F497 filings
    # with 0 RCPT_CD rows but real detail in S497_CD — that's where the
    # ~$13M gap to Power Search was hiding.
    s497_path = DATA_DIR / "S497_CD.TSV"
    s497_buffer: list = []
    s497_total = 0
    s497_skipped_old = 0
    s497_skipped_other_form = 0
    for row in stream_tsv(s497_path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        form_type = (row.get("FORM_TYPE", "") or "").strip().upper()
        if form_type != "F497P1":
            # F497P2 is contributions made (donor side). We're on the
            # recipient side here, so skip.
            s497_skipped_other_form += 1
            continue
        tran_id = (row.get("TRAN_ID") or "").strip()
        if not tran_id:
            continue
        amount = to_decimal(row.get("AMOUNT", ""))
        if amount is None:
            continue
        date_iso = parse_calaccess_date(row.get("CTRIB_DATE", ""))
        if date_iso and date_iso < cycle_start_iso:
            s497_skipped_old += 1
            continue

        filer_id = filing_to_committee[filing_id]
        cand = by_committee[filer_id]
        # S497_CD uses ENTY_* for the contributor; RCPT_CD uses CTRIB_*.
        record = {
            "candidate_id": cand.id,
            "committee_filer_id": filer_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "contributor_type": (row.get("ENTITY_CD") or "").strip() or None,
            "contributor_last_name": (row.get("ENTY_NAML") or "").strip() or None,
            "contributor_first_name": (row.get("ENTY_NAMF") or "").strip() or None,
            "employer": (row.get("CTRIB_EMP") or "").strip() or None,
            "occupation": (row.get("CTRIB_OCC") or "").strip() or None,
            "amount": amount,
            "contribution_date": date_iso,
            "cumulative_ytd": None,
            "city": (row.get("ENTY_CITY") or "").strip() or None,
            "state": (row.get("ENTY_ST") or "").strip() or None,
            "zip": (row.get("ENTY_ZIP4") or "").strip() or None,
            "cycle": classify_cycle(date_iso),
            "source_form_type": form_type,  # 'F497P1'
            "tran_type": (row.get("TRAN_TYPE") or "").strip() or None,
        }
        s497_buffer.append(record)
        if len(s497_buffer) >= BATCH_SIZE:
            s497_total += upsert_batch(sb, "ca_contributions", s497_buffer, "filing_id,amend_id,tran_id")
            s497_buffer = []
    s497_total += upsert_batch(sb, "ca_contributions", s497_buffer, "filing_id,amend_id,tran_id")
    logger.info(
        "S497_CD pass: upserted %d F497P1 candidate contributions (skipped %d pre-cycle, %d non-P1)",
        s497_total,
        s497_skipped_old,
        s497_skipped_other_form,
    )


# ---------------------------------------------------------------------------
# Stage 3: expenditures (EXPN_CD)
# ---------------------------------------------------------------------------


def import_expenditures(
    sb,
    by_committee: Dict[int, SeedCandidate],
    relevant_filings: Dict[int, dict],
):
    """EXPN_CD rows don't have FILER_ID either — same FILING_ID join as contributions.

    Exclude rows that should not be summed into totals:
      - date < CYCLE_START — prior-campaign expenditures (Porter's 2024 Senate
        spending, Villaraigosa's 2018 governor run, etc.) re-appear on
        committee filings but don't belong in 2026 totals.
      - date IS NULL — CAL-ACCESS occasionally emits rows with no EXPN_DATE.
        They aggregate as cycle='unknown' downstream, but the dollar amounts
        are usually Schedule D rollups that double-count detail rows already
        captured. Drop them outright; if a row has no date it can't be placed
        in a cycle.
      - MEMO_CODE='X' — CAL-ACCESS "informational only" rows. These repeat
        detail already in a parent row; summing them double-counts.
      - FORM_TYPE='G' — Form 460 Schedule G, payments by agent/contractor. A
        sub-report of Schedule E; summing would double-count.
      - FORM_TYPE='F465P3' / 'F461P5' — those are IE / slate-mailer rows,
        not candidate-committee operating spending; captured via the IE
        import path separately.
    """
    cycle_start_iso = CYCLE_START.isoformat()
    path = DATA_DIR / "EXPN_CD.TSV"
    filing_to_committee = {
        fid: meta["filer_id"]
        for fid, meta in relevant_filings.items()
        if meta.get("from_committee") and meta.get("filer_id") in by_committee
    }
    logger.info("expenditures: %d filings from our committees to scan", len(filing_to_committee))
    buffer: list = []
    total = 0
    skipped_memo = 0
    skipped_schedule_g = 0
    skipped_old = 0
    skipped_no_date = 0
    for row in stream_tsv(path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        filer_id = filing_to_committee[filing_id]

        form_type = (row.get("FORM_TYPE") or "").strip()
        if form_type == "G":
            skipped_schedule_g += 1
            continue
        if (row.get("MEMO_CODE") or "").strip().upper() == "X":
            skipped_memo += 1
            continue

        tran_id = row.get("TRAN_ID", "").strip()
        if filing_id is None or not tran_id:
            continue

        amount = to_decimal(row.get("AMOUNT", ""))
        if amount is None:
            continue

        cand = by_committee[filer_id]
        date_iso = parse_calaccess_date(row.get("EXPN_DATE", ""))
        if date_iso is None:
            skipped_no_date += 1
            continue
        if date_iso < cycle_start_iso:
            skipped_old += 1
            continue

        record = {
            "candidate_id": cand.id,
            "committee_filer_id": filer_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "payee_last_name": row.get("PAYEE_NAML", "").strip() or None,
            "payee_first_name": row.get("PAYEE_NAMF", "").strip() or None,
            "payee_city": row.get("PAYEE_CITY", "").strip() or None,
            "payee_state": row.get("PAYEE_ST", "").strip() or None,
            "payee_zip": row.get("PAYEE_ZIP4", "").strip() or None,
            "amount": amount,
            "expenditure_date": date_iso,
            "expn_code": row.get("EXPN_CODE", "").strip() or None,
            "expn_description": row.get("EXPN_DSCR", "").strip() or None,
            "cumulative_ytd": to_decimal(row.get("CUM_YTD", "")),
            "cycle": classify_cycle(date_iso),
            "source_form_type": row.get("FORM_TYPE", "").strip() or None,
        }
        buffer.append(record)

        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_expenditures", buffer, "filing_id,amend_id,tran_id")
            buffer = []
            if total % 10_000 == 0:
                logger.info("  expenditures: %d upserted so far", total)

    total += upsert_batch(sb, "ca_expenditures", buffer, "filing_id,amend_id,tran_id")
    logger.info(
        "upserted %d expenditures (skipped %d memo, %d Schedule G, %d pre-cycle, %d no-date)",
        total,
        skipped_memo,
        skipped_schedule_g,
        skipped_old,
        skipped_no_date,
    )


# ---------------------------------------------------------------------------
# Stage 3b: cover-page summaries (SMRY_CD) and loans (LOAN_CD)
# ---------------------------------------------------------------------------


def import_summaries(
    sb,
    by_committee: Dict[int, SeedCandidate],
    relevant_filings: Dict[int, dict],
):
    """Parse SMRY_CD (Form 460/461 cover-page summary lines) and upsert ca_summaries
    for our committees' filings.

    These cover-page totals feed ca_contributions_summary: the unitemized
    contributions line (form_type='A', line_item='2') is added to the itemized
    sum to produce total_raised, and other lines back the cover-page rollups.
    Without this stage ca_summaries goes stale and total_raised silently
    under-counts every reporting period filed after the last manual load.

    SMRY_CD carries no FILER_ID; join via FILING_ID to our committees' filings,
    the same scoping used for contributions/expenditures. Every form_type /
    line_item is loaded (the views select the lines they need); the views pick
    the latest amendment via their own (filing_id, amend_id) join."""
    path = DATA_DIR / "SMRY_CD.TSV"
    filing_to_committee = {
        fid: meta["filer_id"]
        for fid, meta in relevant_filings.items()
        if meta.get("from_committee") and meta.get("filer_id") in by_committee
    }
    logger.info("summaries: %d filings from our committees to scan", len(filing_to_committee))
    buffer: list = []
    total = 0
    for row in stream_tsv(path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        line_item = (row.get("LINE_ITEM") or "").strip()
        form_type = (row.get("FORM_TYPE") or "").strip()
        if not line_item or not form_type:
            continue
        record = {
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "line_item": line_item,
            "form_type": form_type,
            "amount_a": to_decimal(row.get("AMOUNT_A", "")),
            "amount_b": to_decimal(row.get("AMOUNT_B", "")),
            "elec_date": parse_calaccess_date(row.get("ELEC_DT", "")),
        }
        buffer.append(record)
        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_summaries", buffer, "filing_id,amend_id,line_item,form_type")
            buffer = []
    total += upsert_batch(sb, "ca_summaries", buffer, "filing_id,amend_id,line_item,form_type")
    logger.info("upserted %d summary lines", total)


def import_loans(
    sb,
    by_committee: Dict[int, SeedCandidate],
    relevant_filings: Dict[int, dict],
):
    """Parse LOAN_CD (Form 460 Schedule B — loans received) and upsert ca_loans
    for our committees' filings. ca_contributions_deduped folds outstanding,
    non-forgiven loans into total_raised via amount_received.

    LOAN_CD carries no FILER_ID; join via FILING_ID like contributions. Amount
    columns (verified against the existing rows): LOAN_AMT1 = amount received
    this period, LOAN_AMT2 = outstanding balance, LOAN_AMT3 = cumulative to
    date, LOAN_AMT4 = amount repaid this period; LOAN_DATE1 = loan date,
    LOAN_DATE2 = due date. MEMO_CODE='X' rows mirror detail already on a parent
    row and are skipped (same treatment as expenditures)."""
    path = DATA_DIR / "LOAN_CD.TSV"
    filing_to_committee = {
        fid: meta["filer_id"]
        for fid, meta in relevant_filings.items()
        if meta.get("from_committee") and meta.get("filer_id") in by_committee
    }
    logger.info("loans: %d filings from our committees to scan", len(filing_to_committee))
    buffer: list = []
    total = 0
    skipped_memo = 0
    for row in stream_tsv(path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        if (row.get("MEMO_CODE") or "").strip().upper() == "X":
            skipped_memo += 1
            continue
        tran_id = (row.get("TRAN_ID") or "").strip()
        if not tran_id:
            continue
        filer_id = filing_to_committee[filing_id]
        cand = by_committee[filer_id]
        loan_date = parse_calaccess_date(row.get("LOAN_DATE1", ""))
        record = {
            "candidate_id": cand.id,
            "committee_filer_id": filer_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "lender_type": (row.get("ENTITY_CD") or "").strip() or None,
            "lender_last_name": (row.get("LNDR_NAML") or "").strip() or None,
            "lender_first_name": (row.get("LNDR_NAMF") or "").strip() or None,
            "lender_city": (row.get("LOAN_CITY") or "").strip() or None,
            "lender_state": (row.get("LOAN_ST") or "").strip() or None,
            "lender_zip": (row.get("LOAN_ZIP4") or "").strip() or None,
            "lender_employer": (row.get("LOAN_EMP") or "").strip() or None,
            "lender_occupation": (row.get("LOAN_OCC") or "").strip() or None,
            "amount_received": to_decimal(row.get("LOAN_AMT1", "")),
            "outstanding_balance": to_decimal(row.get("LOAN_AMT2", "")),
            "cumulative_loaned": to_decimal(row.get("LOAN_AMT3", "")),
            "amount_repaid": to_decimal(row.get("LOAN_AMT4", "")),
            "amount_forgiven": None,
            "loan_rate": (row.get("LOAN_RATE") or "").strip() or None,
            "loan_date": loan_date,
            "due_date": parse_calaccess_date(row.get("LOAN_DATE2", "")),
            "loan_type": (row.get("LOAN_TYPE") or "").strip() or None,
            "cycle": classify_cycle(loan_date),
            "source_form_type": (row.get("FORM_TYPE") or "").strip() or None,
        }
        buffer.append(record)
        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_loans", buffer, "filing_id,amend_id,tran_id")
            buffer = []
    total += upsert_batch(sb, "ca_loans", buffer, "filing_id,amend_id,tran_id")
    logger.info("upserted %d loans (skipped %d memo)", total, skipped_memo)


# ---------------------------------------------------------------------------
# Stage 4: IE committees + independent expenditures
# ---------------------------------------------------------------------------


def upsert_ie_committee(sb, filer_id: int, cache: set):
    """Lazy-upsert an IE committee record from FILERNAME_CD (one-time fetch)."""
    if filer_id in cache:
        return
    # First-time: pull name from FILERNAME_CD (cached in memory via file scan)
    # This function is called for each new IE filer_id; to avoid N filename scans,
    # we pre-load the names once in the caller.
    cache.add(filer_id)


def load_filer_names(filer_ids: set) -> Dict[int, dict]:
    """Scan FILERNAME_CD once and return dict of filer_id -> {name, filer_type, status, city, state, zip}."""
    path = DATA_DIR / "FILERNAME_CD.TSV"
    out: Dict[int, dict] = {}
    for row in stream_tsv(path):
        fid = to_int(row.get("FILER_ID", ""))
        if fid not in filer_ids:
            continue
        if fid in out:
            continue
        out[fid] = {
            "filer_id": fid,
            "name": (row.get("NAML", "") or "").strip() or f"Filer {fid}",
            "filer_type": (row.get("FILER_TYPE", "") or "").strip() or None,
            "status": (row.get("STATUS", "") or "").strip() or None,
            "city": (row.get("CITY", "") or "").strip() or None,
            "state": (row.get("ST", "") or "").strip() or None,
            "zip": (row.get("ZIP4", "") or "").strip() or None,
            "sponsor": None,
            "party_affiliation": None,
        }
    return out


def import_independent_expenditures(
    sb,
    relevant_filings: Dict[int, dict],
    by_candidate: Dict[int, SeedCandidate],
    by_committee: Dict[int, SeedCandidate],
    f461_covers: Dict[int, list],
    ie_pac_f460_covers: Dict[int, list],
    primarily_formed: Dict[int, tuple],
):
    """Build ca_ie_committees, ca_independent_expenditures, and the F461 cover
    rows in ca_filings.

    Three source paths feed ca_independent_expenditures:
      - F496 ("late" IE reports): the cover row in CVR carries CAND_NAML, so
        relevant_filings already has target_candidate_id resolved. Amounts and
        dates come from S496_CD joined by filing_id.
      - F461 (quarterly IE statements): the cover row does NOT carry CAND_NAML
        — multiple candidates can be targeted in one filing — so per-target
        detection is done against EXPN_CD Schedule E (FORM_TYPE='F461P5'/'E')
        rows, where each row has its own CAND_NAML, SUP_OPP_CD, AMOUNT, etc.
        f461_covers (built in import_filings) gives us filing_id → filer_id.
      - F460 Schedule E from primarily-formed IE PACs: many active IE PACs
        (e.g. CALIFORNIA BACK TO BASICS SUPPORTING MATT MAHAN, DELIVER FOR
        CALIFORNIA - MATT MAHAN) report their independent expenditures on
        their quarterly Form 460 Schedule E rather than via standalone
        F496/F461 filings. ie_pac_f460_covers caches those F460 covers; we
        scan EXPN_CD Schedule E for those filings the same way Stage 4b
        scans F461 covers, applying per-row CAND_NAML matching with a
        primarily-formed cover fallback when CAND_NAML is empty.
    """
    cycle_start_iso = CYCLE_START.isoformat()

    # ie_filings = F496/F461 covers that import_filings already flagged as IE
    # (either via cover-row name match or primarily-formed committee match).
    # We use it both as a fallback for Stage 4b per-row matching and as the
    # driver for Stage 4a.
    ie_filings = {
        fid: meta for fid, meta in relevant_filings.items() if meta.get("is_ie")
    }

    # ----- Stage 4-pre: scan EXPN_CD for F461 Schedule E rows that name-match
    # our candidates. Done up front so the discovered filer_ids feed into the
    # ca_ie_committees upsert below.
    name_index: Dict[tuple, SeedCandidate] = {}
    for c in by_candidate.values():
        parts = c.name.split()
        if not parts:
            continue
        last = _norm_name(parts[-1])
        first = _norm_name(parts[0])
        name_index[(last, first)] = c
        name_index[(last, "")] = c

    f461_ie_records: list = []
    f461_ie_filer_ids: set = set()
    f461_ie_filing_ids: set = set()
    f460_ie_records: list = []
    f460_ie_filer_ids: set = set()
    f460_ie_filing_ids: set = set()
    f461_skipped_old = 0
    f461_skipped_self = 0
    f461_skipped_contribution = 0
    f460_skipped_contribution = 0
    f461_attributed_via_cover = 0
    f460_attributed_via_cover = 0

    expn_path = DATA_DIR / "EXPN_CD.TSV"
    if f461_covers or ie_pac_f460_covers:
        for row in stream_tsv(expn_path):
            filing_id = to_int(row.get("FILING_ID", ""))
            if filing_id is None:
                continue
            f461_cover_list = f461_covers.get(filing_id)
            f460_cover_list = ie_pac_f460_covers.get(filing_id)
            if not f461_cover_list and not f460_cover_list:
                # Row's filing isn't an F461 IE cover or an IE-PAC F460.
                # Let import_expenditures handle it (if relevant) or skip.
                continue
            # Pick whichever cover applies. F461 takes priority since both
            # would be uncommon; same per-row processing logic for both.
            covers = f461_cover_list or f460_cover_list
            cover_form_type = "F461" if f461_cover_list else "F460"
            # EXPN_CD.FORM_TYPE is a per-row schedule code. Only Schedule E
            # rows are independent expenditures. Major donors filing F461
            # report their direct contributions on Schedule C / D, which
            # would otherwise be picked up here as fake IEs (and would
            # double-count rows already correctly captured in
            # ca_contributions). 'E' is the canonical code; 'F461P5' is the
            # variant that some CAL-ACCESS dumps use for the same schedule.
            # Skip MEMO_CODE='X' rows which mirror detail already on the
            # parent row — same exclusion import_expenditures applies.
            row_form_type = (row.get("FORM_TYPE") or "").strip()
            if row_form_type not in ("E", "F461P5"):
                continue
            # Form 461 Part 5 ("Contributions ... and Independent Expenditures
            # Made") is a MIXED schedule: major donors (individuals/firms giving
            # $10k+/yr) report their direct candidate CONTRIBUTIONS here next to
            # true IEs. In EXPN_CD only EXPN_CODE='IND' rows are independent
            # expenditures; MON/CTB (monetary contributions), IKD (in-kind) and
            # LON (loans) are contributions the candidate already reports on
            # their own F460 Schedule A — counting them here misclassifies them
            # AND double-counts.
            expn_code = (row.get("EXPN_CODE") or "").strip().upper()
            if row_form_type == "F461P5" and expn_code != "IND":
                f461_skipped_contribution += 1
                continue
            # Form 460 Schedule E (FORM_TYPE='E') is a primarily-formed PAC's own
            # schedule, but it mixes genuine independent expenditures with
            # contributions the PAC MADE to other committees (EXPN_CODE CTB/MON/IKD)
            # and refunds. Contributions made are transfers captured at the
            # recipient — counting them here double-counts across committees (e.g.
            # an $8M "NO ON STEYER" transfer to another anti-Steyer PAC that also
            # reports its ad spending) — and a refund is money returned, not spent.
            # Drop both; keep IND, agent-routed media ("SEE SCHEDULE G"/blank) and
            # operating outlays so the total reflects money spent for/against X.
            if row_form_type == "E" and (
                expn_code in ("CTB", "MON", "IKD")
                or re.search(r"refund", row.get("EXPN_DSCR") or "", re.I)
            ):
                f460_skipped_contribution += 1
                continue
            if (row.get("MEMO_CODE") or "").strip().upper() == "X":
                continue
            filer_id = covers[0]["filer_id"]
            # Don't let candidate committees leak into ca_ie_committees as
            # self-funding IE money — same guard the F496 path applies.
            if filer_id in by_committee:
                f461_skipped_self += 1
                continue
            cand_naml = (row.get("CAND_NAML") or "").strip()
            cand_namf = (row.get("CAND_NAMF") or "").strip()
            target_id = None
            if cand_naml:
                last = _norm_name(cand_naml)
                first_tok = _norm_name(cand_namf.split()[0]) if cand_namf else ""
                ie_target = name_index.get((last, first_tok)) or name_index.get((last, ""))
                if ie_target is not None:
                    target_id = ie_target.id
                else:
                    # Row names a candidate we don't track (e.g. a Senate or
                    # Assembly target). Don't fall back to the cover here —
                    # this row is genuinely about that other candidate.
                    continue
            else:
                # Per-row CAND_NAML is blank. Fall back to the cover's IE
                # target. For F461 covers that's set in import_filings via
                # primarily-formed match (lives in ie_filings). For F460
                # IE-PAC covers, target comes from primarily_formed directly
                # (those covers aren't in ie_filings).
                if cover_form_type == "F461":
                    cover_meta = ie_filings.get(filing_id)
                    if cover_meta is not None and cover_meta.get("target_candidate_id"):
                        target_id = cover_meta["target_candidate_id"]
                        f461_attributed_via_cover += 1
                else:  # F460
                    pf = primarily_formed.get(filer_id)
                    if pf is not None:
                        target_id = pf[0].id
                        f460_attributed_via_cover += 1
            if target_id is None:
                continue
            tran_id = (row.get("TRAN_ID") or "").strip()
            amount = to_decimal(row.get("AMOUNT", ""))
            if not tran_id or amount is None:
                continue
            date_iso = parse_calaccess_date(row.get("EXPN_DATE", ""))
            if date_iso and date_iso < cycle_start_iso:
                f461_skipped_old += 1
                continue
            # SUP_OPP_CD priority: per-row → cover → primarily-formed match.
            pf_sup_opp = None
            if cover_form_type == "F460":
                pf = primarily_formed.get(filer_id)
                if pf is not None:
                    pf_sup_opp = pf[1]
            sup_opp = (
                row.get("SUP_OPP_CD") or covers[0].get("sup_opp_cd") or pf_sup_opp or ""
            ).strip().upper() or None
            record = {
                "ie_committee_filer_id": filer_id,
                "target_candidate_id": target_id,
                "filing_id": filing_id,
                "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
                "tran_id": tran_id,
                "support_oppose": sup_opp,
                "amount": amount,
                "expenditure_date": date_iso,
                "description": (row.get("EXPN_DSCR") or "").strip() or None,
                "cycle": classify_cycle(date_iso),
                "source_form_type": cover_form_type,  # 'F461' or 'F460'
                "expn_code": expn_code or None,
            }
            if cover_form_type == "F461":
                f461_ie_records.append(record)
                f461_ie_filer_ids.add(filer_id)
                f461_ie_filing_ids.add(filing_id)
            else:
                f460_ie_records.append(record)
                f460_ie_filer_ids.add(filer_id)
                f460_ie_filing_ids.add(filing_id)

    logger.info(
        "EXPN_CD IE scan: F461 matched %d rows / %d filings / %d filers; "
        "F460-from-IE-PAC matched %d rows / %d filings / %d filers; "
        "skipped %d pre-cycle, %d self-funding, %d F461 contributions (non-IND), "
        "%d F460 contributions/refunds; "
        "attributed via cover: %d F461, %d F460",
        len(f461_ie_records),
        len(f461_ie_filing_ids),
        len(f461_ie_filer_ids),
        len(f460_ie_records),
        len(f460_ie_filing_ids),
        len(f460_ie_filer_ids),
        f461_skipped_old,
        f461_skipped_self,
        f461_skipped_contribution,
        f460_skipped_contribution,
        f461_attributed_via_cover,
        f460_attributed_via_cover,
    )

    if not ie_filings and not f461_ie_records and not f460_ie_records:
        logger.info("no IE filings targeting our candidates in this dump")
        return

    logger.info(
        "indexing %d F496 IE filings + %d F461 IE filings + %d F460-from-IE-PAC",
        len(ie_filings),
        len(f461_ie_filing_ids),
        len(f460_ie_filing_ids),
    )

    # Collect filer_ids of the IE committees so we can resolve names. Merge in
    # the manual allowlist so ballot-measure / off-race committees we track by
    # hand are also upserted into ca_ie_committees. Exclude any filer that's
    # one of our 24 candidate committees — those belong in ca_candidates and
    # their receipts are tracked via ca_contributions. Letting them leak into
    # ca_ie_committees double-counts self-funding as IE money.
    ie_filer_ids = {m["filer_id"] for m in ie_filings.values() if m.get("filer_id")}
    ie_filer_ids |= f461_ie_filer_ids
    ie_filer_ids |= f460_ie_filer_ids
    all_filer_ids = (ie_filer_ids | set(ALLOWLISTED_IE_FILER_IDS.keys())) - set(by_committee.keys())
    names = load_filer_names(all_filer_ids)
    # Stub any filer_ids not present in FILERNAME_CD so the FK constraint holds.
    for fid in all_filer_ids:
        if fid not in names:
            fallback = ALLOWLISTED_IE_FILER_IDS.get(fid) or f"Filer {fid}"
            names[fid] = {
                "filer_id": fid,
                "name": fallback,
                "filer_type": None,
                "status": None,
                "city": None,
                "state": None,
                "zip": None,
                "sponsor": None,
                "party_affiliation": None,
            }

    committees_rows = list(names.values())
    if committees_rows:
        upsert_batch(sb, "ca_ie_committees", committees_rows, "filer_id")
        logger.info(
            "upserted %d IE committees (%d resolved, %d stubbed, %d allowlisted)",
            len(committees_rows),
            sum(1 for v in names.values() if v["name"] and not v["name"].startswith("Filer ")),
            sum(1 for v in names.values() if v["name"] and v["name"].startswith("Filer ")),
            len(ALLOWLISTED_IE_FILER_IDS),
        )

    # Upsert ca_filings cover rows for F461 filings that turned out to be IE.
    # cand_filer_id stays null on the cover (F461 supports multiple targets);
    # the per-target link is captured on each ca_independent_expenditures row.
    if f461_ie_filing_ids:
        cover_buffer: list = []
        cover_total = 0
        for fid in f461_ie_filing_ids:
            for cover in f461_covers.get(fid, []):
                cover_buffer.append({
                    "filing_id": cover["filing_id"],
                    "amend_id": cover["amend_id"],
                    "filer_id": cover["filer_id"],
                    "form_type": "F461",
                    "stmt_type": cover.get("stmt_type"),
                    "rpt_start": cover.get("rpt_start"),
                    "rpt_end": cover.get("rpt_end"),
                    "elect_date": cover.get("elect_date"),
                    "filed_date": cover.get("filed_date"),
                    "office_cd": cover.get("office_cd"),
                    "cand_filer_id": None,
                    "cand_last_name": None,
                    "cand_first_name": None,
                    "sup_opp_cd": cover.get("sup_opp_cd"),
                })
                if len(cover_buffer) >= BATCH_SIZE:
                    cover_total += upsert_batch(sb, "ca_filings", cover_buffer, "filing_id,amend_id")
                    cover_buffer = []
        cover_total += upsert_batch(sb, "ca_filings", cover_buffer, "filing_id,amend_id")
        logger.info("upserted %d F461 IE cover rows into ca_filings", cover_total)

    # Stage 4a: Form 496 — one filing = one (amount, date, target). Join S496_CD by filing_id.
    s496_path = DATA_DIR / "S496_CD.TSV"
    buffer: list = []
    total = 0
    skipped_old = 0
    for row in stream_tsv(s496_path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in ie_filings:
            continue
        meta = ie_filings[filing_id]
        if meta.get("form_type") != "F496":
            continue
        tran_id = row.get("TRAN_ID", "").strip()
        amount = to_decimal(row.get("AMOUNT", ""))
        if not tran_id or amount is None:
            continue
        target_id = meta.get("target_candidate_id")
        if not target_id:
            continue
        date_iso = parse_calaccess_date(row.get("EXP_DATE", ""))
        # Filter out pre-2026-cycle rows — a filing from 2018 with a name that
        # matches a 2026 candidate does NOT count as 2026 IE.
        if date_iso and date_iso < cycle_start_iso:
            skipped_old += 1
            continue

        record = {
            "ie_committee_filer_id": meta["filer_id"],
            "target_candidate_id": target_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "support_oppose": (meta.get("sup_opp_cd") or "").strip().upper() or None,
            "amount": amount,
            "expenditure_date": date_iso,
            "description": row.get("EXPN_DSCR", "").strip() or None,
            "cycle": classify_cycle(date_iso),
            "source_form_type": "F496",
            "expn_code": (row.get("EXPN_CODE") or "").strip().upper() or None,
        }
        buffer.append(record)

        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
            buffer = []

    total += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
    logger.info("upserted %d Form 496 IE transactions (skipped %d pre-cycle)", total, skipped_old)

    # Stage 4b: Form 461 IE — flush the records collected in the pre-pass.
    if f461_ie_records:
        buffer = []
        total461 = 0
        for record in f461_ie_records:
            buffer.append(record)
            if len(buffer) >= BATCH_SIZE:
                total461 += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
                buffer = []
        total461 += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
        logger.info("upserted %d Form 461 IE transactions", total461)

    # Stage 4c: Form 460 Schedule E from primarily-formed IE PACs.
    if f460_ie_records:
        buffer = []
        total460 = 0
        for record in f460_ie_records:
            buffer.append(record)
            if len(buffer) >= BATCH_SIZE:
                total460 += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
                buffer = []
        total460 += upsert_batch(sb, "ca_independent_expenditures", buffer, "filing_id,amend_id,tran_id")
        logger.info("upserted %d Form 460 Schedule E IE transactions", total460)


# ---------------------------------------------------------------------------
# Stage 5: contributions RECEIVED BY the IE committees (who funds the PACs)
# ---------------------------------------------------------------------------


def import_ie_contributions(sb):
    """Scan RCPT_CD for contributions to every IE committee in ca_ie_committees.

    IE committees land in ca_ie_committees during Stage 4 (via F496/F461 filings
    targeting our 24 candidates), so the set is already scoped to committees
    active in this race. Here we:
      1. Pull all IE committee filer_ids from the DB.
      2. Re-scan CVR to collect every FILING_ID those committees ever filed
         (F460 quarterly disclosures are where receipts live).
      3. Scan RCPT_CD once, keeping rows whose FILING_ID is in that set AND
         whose RCPT_DATE is in the 2026 cycle window (>= CYCLE_START).

    Only cycle-scoped rows are persisted, matching the treatment for
    independent expenditures themselves.
    """
    cycle_start_iso = CYCLE_START.isoformat()

    res = sb.table("ca_ie_committees").select("filer_id").execute()
    ie_filer_ids = {int(r["filer_id"]) for r in (res.data or []) if r.get("filer_id") is not None}
    if not ie_filer_ids:
        logger.info("no IE committees in ca_ie_committees yet — run --only ie first")
        return
    logger.info("IE contributions: scanning for %d IE committees", len(ie_filer_ids))

    # Pass 1: build filing_id -> committee_filer_id for every filing an IE
    # committee submitted. We don't restrict by form type — F460 disclosures
    # carry RCPT_CD entries, and amendments to IE-specific forms can too.
    cvr_path = DATA_DIR / "CVR_CAMPAIGN_DISCLOSURE_CD.TSV"
    filing_to_committee: Dict[int, int] = {}
    for row in stream_tsv(cvr_path):
        filer_id = to_int(row.get("FILER_ID", ""))
        if filer_id not in ie_filer_ids:
            continue
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id is None:
            continue
        filing_to_committee[filing_id] = filer_id
    logger.info(
        "IE contributions: %d filings from %d IE committees",
        len(filing_to_committee),
        len({v for v in filing_to_committee.values()}),
    )

    # Semantic key used to dedup Form 497 rows against Form 460 rows (same
    # donation, different filing). Form 460 is the source of truth when both
    # exist — 497 is filed in the 24h window and then folded into the next
    # quarterly 460. Without this, big late gifts would double-count once the
    # 460 catches up.
    def semantic_key(filer_id: int, last: str, first: str, date_iso: Optional[str], amount) -> tuple:
        return (
            filer_id,
            (last or "").strip().upper(),
            (first or "").strip().upper(),
            date_iso or "",
            f"{float(amount):.2f}",
        )

    seen_keys: set = set()

    # Pass 2: stream RCPT_CD and keep matching + in-cycle rows.
    rcpt_path = DATA_DIR / "RCPT_CD.TSV"
    buffer: list = []
    total = 0
    skipped_old = 0
    for row in stream_tsv(rcpt_path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        tran_id = row.get("TRAN_ID", "").strip()
        if not tran_id:
            continue
        amount = to_decimal(row.get("AMOUNT", ""))
        if amount is None:
            continue
        date_iso = parse_calaccess_date(row.get("RCPT_DATE", ""))
        if date_iso and date_iso < cycle_start_iso:
            skipped_old += 1
            continue

        committee_id = filing_to_committee[filing_id]
        last = row.get("CTRIB_NAML", "").strip() or None
        first = row.get("CTRIB_NAMF", "").strip() or None
        seen_keys.add(semantic_key(committee_id, last or "", first or "", date_iso, amount))

        record = {
            "ie_committee_filer_id": committee_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "contributor_type": row.get("ENTITY_CD", "").strip() or None,
            "contributor_last_name": last,
            "contributor_first_name": first,
            "employer": row.get("CTRIB_EMP", "").strip() or None,
            "occupation": row.get("CTRIB_OCC", "").strip() or None,
            "amount": amount,
            "contribution_date": date_iso,
            "cumulative_ytd": to_decimal(row.get("CUM_YTD", "")),
            "city": row.get("CTRIB_CITY", "").strip() or None,
            "state": row.get("CTRIB_ST", "").strip() or None,
            "zip": row.get("CTRIB_ZIP4", "").strip() or None,
            "cycle": classify_cycle(date_iso),
            "source_form_type": row.get("FORM_TYPE", "").strip() or None,
        }
        buffer.append(record)

        if len(buffer) >= BATCH_SIZE:
            total += upsert_batch(sb, "ca_ie_contributions", buffer, "filing_id,amend_id,tran_id")
            buffer = []
            if total % 10_000 == 0:
                logger.info("  IE contributions: %d upserted so far", total)

    total += upsert_batch(sb, "ca_ie_contributions", buffer, "filing_id,amend_id,tran_id")
    buffer = []
    logger.info(
        "upserted %d Form 460 IE contributions (skipped %d pre-cycle)",
        total,
        skipped_old,
    )

    # Pass 3: stream S497_CD for late-contribution reports (Form 497 Schedule
    # P1). These are 24-hour / 10-day pre-election filings by the recipient
    # committee and carry the biggest whale gifts before the next quarterly
    # Form 460 lands. Dedup against pass 2 so we don't double-count the same
    # donation once it shows up on both forms.
    s497_path = DATA_DIR / "S497_CD.TSV"
    s497_total = 0
    s497_skipped_old = 0
    s497_skipped_dup = 0
    s497_skipped_other_form = 0
    for row in stream_tsv(s497_path):
        filing_id = to_int(row.get("FILING_ID", ""))
        if filing_id not in filing_to_committee:
            continue
        form_type = (row.get("FORM_TYPE", "") or "").strip().upper()
        if form_type != "F497P1":
            # F497P2 is contributions made (from the donor's side), not received.
            s497_skipped_other_form += 1
            continue
        tran_id = row.get("TRAN_ID", "").strip()
        if not tran_id:
            continue
        amount = to_decimal(row.get("AMOUNT", ""))
        if amount is None:
            continue
        date_iso = parse_calaccess_date(row.get("CTRIB_DATE", ""))
        if date_iso and date_iso < cycle_start_iso:
            s497_skipped_old += 1
            continue

        committee_id = filing_to_committee[filing_id]
        last = row.get("ENTY_NAML", "").strip() or None
        first = row.get("ENTY_NAMF", "").strip() or None
        key = semantic_key(committee_id, last or "", first or "", date_iso, amount)
        if key in seen_keys:
            s497_skipped_dup += 1
            continue
        seen_keys.add(key)

        record = {
            "ie_committee_filer_id": committee_id,
            "filing_id": filing_id,
            "amend_id": to_int(row.get("AMEND_ID", "")) or 0,
            "tran_id": tran_id,
            "contributor_type": row.get("ENTITY_CD", "").strip() or None,
            "contributor_last_name": last,
            "contributor_first_name": first,
            "employer": row.get("CTRIB_EMP", "").strip() or None,
            "occupation": row.get("CTRIB_OCC", "").strip() or None,
            "amount": amount,
            "contribution_date": date_iso,
            "cumulative_ytd": None,
            "city": row.get("ENTY_CITY", "").strip() or None,
            "state": row.get("ENTY_ST", "").strip() or None,
            "zip": row.get("ENTY_ZIP4", "").strip() or None,
            "cycle": classify_cycle(date_iso),
            "source_form_type": form_type,
        }
        buffer.append(record)

        if len(buffer) >= BATCH_SIZE:
            s497_total += upsert_batch(sb, "ca_ie_contributions", buffer, "filing_id,amend_id,tran_id")
            buffer = []
            if s497_total % 5_000 == 0:
                logger.info("  F497 IE contributions: %d upserted so far", s497_total)

    s497_total += upsert_batch(sb, "ca_ie_contributions", buffer, "filing_id,amend_id,tran_id")
    logger.info(
        "upserted %d Form 497 IE contributions (skipped %d pre-cycle, %d dup-of-F460, %d non-P1)",
        s497_total,
        s497_skipped_old,
        s497_skipped_dup,
        s497_skipped_other_form,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-download", action="store_true", help="Reuse existing zip in WORK_DIR")
    parser.add_argument("--skip-extract", action="store_true", help="Reuse existing TSVs in WORK_DIR")
    parser.add_argument(
        "--only",
        choices=["filings", "contributions", "expenditures", "summaries", "loans", "ie", "ie-contributions"],
        help="Run a single stage",
    )
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        sys.exit(1)

    sb = create_client(url, key)
    logger.info("connected to %s", url)

    if not args.skip_download:
        download_bulk()
    if not args.skip_extract:
        extract_tsvs()

    by_committee, by_candidate = load_seed_candidates(sb)
    if not by_committee:
        logger.error("no seeded candidates found — run the migration first")
        sys.exit(1)

    primarily_formed: Dict[int, tuple] = {}
    relevant_filings: Dict[int, dict] = {}
    f461_covers: Dict[int, list] = {}
    ie_pac_f460_covers: Dict[int, list] = {}

    if args.only in (None, "filings", "ie", "contributions", "expenditures", "summaries", "loans"):
        primarily_formed = match_committees_by_name(sb, by_candidate, by_committee)
        relevant_filings, f461_covers, ie_pac_f460_covers = import_filings(
            sb, by_committee, by_candidate, primarily_formed
        )

    if args.only in (None, "contributions"):
        import_contributions(sb, by_committee, relevant_filings)

    if args.only in (None, "expenditures"):
        import_expenditures(sb, by_committee, relevant_filings)

    if args.only in (None, "summaries"):
        import_summaries(sb, by_committee, relevant_filings)

    if args.only in (None, "loans"):
        import_loans(sb, by_committee, relevant_filings)

    if args.only in (None, "ie"):
        import_independent_expenditures(
            sb, relevant_filings, by_candidate, by_committee,
            f461_covers, ie_pac_f460_covers, primarily_formed,
        )

    # IE contributions reads ca_ie_committees, so it must run after "ie" (or
    # be skipped entirely if the caller explicitly isolated another stage).
    if args.only in (None, "ie-contributions"):
        import_ie_contributions(sb)

    logger.info("done at %s", datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    main()
