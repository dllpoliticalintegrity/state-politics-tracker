#!/usr/bin/env python3
"""
TEC → Supabase importer for TX Governor 2026 campaign finance.

Downloads the Texas Ethics Commission bulk CSV dump, filters to the
candidates seeded in `tx_candidates`, and upserts:
  - tx_filings                 (cover.csv — report metadata + cover-sheet totals,
                                including unitemized amounts and cash on hand;
                                plus cover_t/cover_ss.csv special-report cover
                                sheets, flagged special = true)
  - tx_contributions           (contribs_##.csv, filtered to our filers; plus
                                cont_t/cont_ss.csv special-report rows)
  - tx_expenditures            (expend_##.csv, filtered to our filers; plus
                                expn_t.csv special-report rows)
  - tx_loans                   (loans.csv)
  - tx_ie_committees + tx_independent_expenditures
                               (cand.csv — direct campaign expenditures that
                                explicitly name a benefited GOVERNOR candidate)
  - tx_ie_contributions        (contributions into those DCE filers, cycle-scoped)

Unlike CAL-ACCESS, TEC data needs no amendment chains or name-regex committee
matching: rows carry infoOnlyFlag='Y' when their report has been superseded
(we skip those), and DCE records identify the benefited candidate and office
sought as structured fields.

Special pre-election ("daily", formerly Telegram) and special session reports
are the one wrinkle: TEC keeps their rows in separate files (cover_t/cover_ss,
cont_t/cont_ss, expn_t) because the same transactions are re-reported on the
filer's next regular report. We import them flagged special = true; the
database's refresh_tx_special_supersession() (run by refresh_tx_finance_views
after every import) marks a special row rereported once a regular report
covering its date exists — and likewise any row whose own report has since
been superseded (infoOnlyFlag = 'Y'; we skip those rows on import, but rows
imported before the correction landed would otherwise linger) — and every
view excludes rereported rows. cand.csv
(DCE benefited-candidate rows) is a single file that already contains the
special-report rows, so those are flagged by reportInfoIdent membership in the
special cover sheets.

Env vars (required unless --discover):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage:
  pip install -r requirements.txt
  python import_tx_finance.py --discover      # list active GOVERNOR filers (no DB)
  python import_tx_finance.py                 # full pipeline
  python import_tx_finance.py --skip-download # reuse /tmp/tec
  python import_tx_finance.py --only filings  # one stage
"""

import argparse
import csv
import io
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("tx-finance")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# The link on https://www.ethics.state.tx.us/search/cf/ 301s to CloudFront;
# urllib follows the redirect. Refreshed daily by TEC.
TEC_ZIP_URL = "https://prd.tecprd.ethicsefile.com/public/cf/public/TEC_CF_CSV.zip"
WORK_DIR = Path(os.environ.get("TEC_WORK_DIR", "/tmp/tec"))
ZIP_PATH = WORK_DIR / "TEC_CF_CSV.zip"

# Statewide offices this tracker follows. Discovery (--discover) takes an
# --office flag; the DCE stage accepts a benefited candidate from any of these.
TARGET_OFFICES = ("GOVERNOR", "LTGOVERNOR", "ATTYGEN")

PRIMARY_DATE = date(2026, 3, 3)
RUNOFF_DATE = date(2026, 5, 26)
GENERAL_DATE = date(2026, 11, 3)
# Texas officeholder committees are long-lived (Abbott's goes back decades),
# so pre-cycle exclusion matters even more than it did for CA.
CYCLE_START = date(2025, 1, 1)

BATCH_SIZE = 500

# Special pre-election / special session report files. TEC stores these apart
# from the regular shards; they may be absent from a given dump.
SPECIAL_COVER_FILES = ("cover_t.csv", "cover_ss.csv")
SPECIAL_CONTRIB_FILES = ("cont_t.csv", "cont_ss.csv")
SPECIAL_EXPEND_FILES = ("expn_t.csv",)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_tec_date(raw: str) -> Optional[str]:
    """TEC date format: yyyyMMdd. Return ISO YYYY-MM-DD or None."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def classify_cycle(iso_date: Optional[str]) -> str:
    if not iso_date:
        return "unknown"
    try:
        d = date.fromisoformat(iso_date)
    except ValueError:
        return "unknown"
    if d < CYCLE_START:
        return "pre-cycle"
    if d <= PRIMARY_DATE:
        return "primary-2026"
    if d <= RUNOFF_DATE:
        return "runoff-2026"
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


def norm_ident(raw: str) -> str:
    """TEC filer account #s appear zero-padded ('00019652'). Normalize for
    comparison while preserving non-numeric idents as-is."""
    raw = (raw or "").strip()
    stripped = raw.lstrip("0")
    return stripped or raw


def norm_name(s: str) -> str:
    return re.sub(r"[^A-Z]", "", (s or "").upper())


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


class BatchWriter:
    def __init__(self, sb, table: str, on_conflict: str):
        self.sb, self.table, self.on_conflict = sb, table, on_conflict
        self.rows: list = []
        self.total = 0

    def add(self, row: dict):
        self.rows.append(row)
        if len(self.rows) >= BATCH_SIZE:
            self.flush()

    def flush(self):
        if self.rows:
            self.total += upsert_batch(self.sb, self.table, self.rows, self.on_conflict)
            self.rows = []


# ---------------------------------------------------------------------------
# Download + zip streaming
# ---------------------------------------------------------------------------


def download_bulk():
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    if ZIP_PATH.exists() and ZIP_PATH.stat().st_size > 500_000_000:
        logger.info("zip already downloaded: %s", ZIP_PATH)
        return
    logger.info("downloading TEC bulk zip (~1 GB)...")
    req = Request(TEC_ZIP_URL, headers={"User-Agent": "tx-gov-polling-ingest/1.0"})
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
    logger.info("downloaded %.2f GB", ZIP_PATH.stat().st_size / 1_000_000_000)


def stream_csv(zf: zipfile.ZipFile, member: str) -> Iterator[dict]:
    """Stream rows of a CSV member without extracting the ~9 GB of files to
    disk. All TEC CSVs carry a header row; parse strictly by header names —
    the actual columns drift from CFS-ReadMe.txt (e.g. cover.csv has
    reportTypeCd1..10 where the layout doc shows one field)."""
    with zf.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
        reader = csv.DictReader(text)
        yield from reader


def optional_members(zf: zipfile.ZipFile, names: tuple) -> List[str]:
    """The special-report files that are actually in this dump."""
    present = [n for n in names if n in zf.namelist()]
    missing = [n for n in names if n not in zf.namelist()]
    if missing:
        logger.info("special-report files absent from dump (fine): %s", ", ".join(missing))
    return present


def load_special_report_ids(zf: zipfile.ZipFile) -> set:
    """reportInfoIdent of every special pre-election / special session report
    in the dump (all filers — the files are small). cand.csv rows carry no
    marker of their own, so this is how DCE rows get their special flag."""
    ids = set()
    for member in optional_members(zf, SPECIAL_COVER_FILES):
        for row in stream_csv(zf, member):
            try:
                ids.add(int(row["reportInfoIdent"]))
            except (KeyError, ValueError):
                continue
    logger.info("special-report cover sheets in dump: %d", len(ids))
    return ids


def members_matching(zf: zipfile.ZipFile, pattern: str) -> List[str]:
    """The contribs_## shard count grows over time (100 as of 2026-07), so
    enumerate members by pattern rather than hardcoding."""
    rx = re.compile(pattern)
    names = sorted(n for n in zf.namelist() if rx.fullmatch(n))
    if not names:
        logger.warning("no zip members match %s", pattern)
    return names


# ---------------------------------------------------------------------------
# Discovery (no DB required)
# ---------------------------------------------------------------------------


def discover_governor_filers(zf: zipfile.ZipFile, office: str = "GOVERNOR"):
    """Print filers whose campaign treasurer appointment targets GOVERNOR and
    who filed a report covering activity in this cycle. filers.csv alone lists
    everyone who *ever* filed a gubernatorial CTA (~170 filers back to 2000),
    so cross-reference cover.csv for recent activity before curating seeds."""
    gov: Dict[str, dict] = {}
    logger.info("discovering %s filers", office)
    for row in stream_csv(zf, "filers.csv"):
        if (row.get("ctaSeekOfficeCd") or "").strip() == office:
            gov[norm_ident(row.get("filerIdent"))] = row
    logger.info("%d filers with a %s CTA on record", len(gov), office)

    active: Dict[str, dict] = {}
    for row in stream_csv(zf, "cover.csv"):
        fid = norm_ident(row.get("filerIdent"))
        if fid not in gov:
            continue
        period_end = parse_tec_date(row.get("periodEndDt"))
        if not period_end or date.fromisoformat(period_end) < CYCLE_START:
            continue
        cur = active.setdefault(fid, {"latest": period_end, "reports": 0, "raised": 0.0})
        cur["reports"] += 1
        cur["latest"] = max(cur["latest"], period_end)
        cur["raised"] += to_decimal(row.get("totalContribAmount")) or 0.0

    print(f"\n{len(active)} {office} filers with reports covering {CYCLE_START} or later:\n")
    print(f"{'filerIdent':>10}  {'reports':>7}  {'latest period end':>17}  {'total contribs':>14}  name")
    for fid, info in sorted(active.items(), key=lambda kv: -kv[1]["raised"]):
        f = gov[fid]
        print(
            f"{f.get('filerIdent',''):>10}  {info['reports']:>7}  {info['latest']:>17}"
            f"  {info['raised']:>14,.0f}  {f.get('filerName','')}"
        )

    # SPACs linked to those candidates. A candidate's real war chest often
    # lives in their principal SPAC (Abbott: 'Texans for Greg Abbott'), and
    # outside SPACs are the TX version of CA's primarily-formed IE committees.
    print("\nSPACs linked (by TEC staff, via spacs.csv) to those candidates:\n")
    print(f"{'spacIdent':>10}  {'status':10}  {'position':8}  {'candIdent':>10}  spac name  /  candidate")
    for row in stream_csv(zf, "spacs.csv"):
        cand_fid = norm_ident(row.get("candidateFilerIdent"))
        if cand_fid not in active:
            continue
        if (row.get("spacCommitteeStatusCd") or "").strip() != "ACTIVE":
            continue
        print(
            f"{row.get('spacFilerIdent',''):>10}  {row.get('spacCommitteeStatusCd',''):10}"
            f"  {row.get('spacPositionCd',''):8}  {row.get('candidateFilerIdent',''):>10}"
            f"  {row.get('spacFilerName','')}  /  {row.get('candidateFilerName','')}"
        )
    print(
        "\nCurate into tx_candidates: filer_ident (COH account) and, when the campaign"
        "\nraises through a SPAC, committee_filer_ident. Outside SPACs belong in"
        "\ntx_ie_committee_targets instead."
    )


# ---------------------------------------------------------------------------
# Seeds
# ---------------------------------------------------------------------------


@dataclass
class SeedCandidate:
    id: str
    slug: str
    name: str
    filer_ident: str  # COH account, normalized (leading zeros stripped)
    committee_filer_ident: str  # principal SPAC account, "" if none


def load_seed_candidates(sb) -> Dict[str, SeedCandidate]:
    """Returns filer_ident (normalized) → SeedCandidate, with the candidate's
    COH account AND their principal SPAC both mapping to the candidate.
    Major TX campaigns raise through a specific-purpose committee (Abbott is
    COH 19652 but the money is in SPAC 51153 'Texans for Greg Abbott'), so
    both accounts' filings/transactions count as the candidate's."""
    res = sb.table("tx_candidates").select(
        "id,slug,name,filer_ident,committee_filer_ident"
    ).execute()
    seeds: Dict[str, SeedCandidate] = {}
    n = 0
    for row in res.data or []:
        c = SeedCandidate(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            filer_ident=norm_ident(row["filer_ident"]),
            committee_filer_ident=norm_ident(row.get("committee_filer_ident") or ""),
        )
        seeds[c.filer_ident] = c
        if c.committee_filer_ident:
            seeds[c.committee_filer_ident] = c
        n += 1
    logger.info("loaded %d candidates (%d filer accounts) from tx_candidates", n, len(seeds))
    return seeds


def load_ie_targets(sb) -> Dict[str, tuple]:
    """Curated overrides: ie_filer_ident → (candidate_id, support_oppose).
    DCE records name the benefited candidate, so unlike CA this is only for
    edge cases (e.g. marking a DCE filer as opposing)."""
    targets: Dict[str, tuple] = {}
    try:
        res = sb.table("tx_ie_committee_targets").select(
            "ie_filer_ident,target_candidate_id,support_oppose"
        ).execute()
        for row in res.data or []:
            targets[norm_ident(row["ie_filer_ident"])] = (
                row["target_candidate_id"],
                (row.get("support_oppose") or "S").upper(),
            )
    except Exception as e:
        logger.warning("tx_ie_committee_targets lookup failed: %s", e)
    return targets


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def contributor_name(row: dict, prefix: str) -> tuple:
    """TEC splits INDIVIDUAL (last/first) vs ENTITY (organization) names.
    Returns (type, last_or_org, first)."""
    ptype = (row.get(f"{prefix}PersentTypeCd") or "").strip()
    if ptype == "ENTITY":
        return ptype, (row.get(f"{prefix}NameOrganization") or "").strip(), ""
    return (
        ptype,
        (row.get(f"{prefix}NameLast") or "").strip(),
        (row.get(f"{prefix}NameFirst") or "").strip(),
    )


def import_filings(sb, zf: zipfile.ZipFile, filer_idents: set) -> None:
    """cover.csv → tx_filings. Cover sheets carry the unitemized totals and
    cash on hand (contribsMaintainedAmount) — TEC's equivalent of the
    CAL-ACCESS SMRY_CD stage, with no separate file needed."""
    writer = BatchWriter(sb, "tx_filings", on_conflict="report_info_ident")
    sources = [("cover.csv", False)] + [(m, True) for m in optional_members(zf, SPECIAL_COVER_FILES)]
    for member, special in sources:
      for row in stream_csv(zf, member):
        fid = norm_ident(row.get("filerIdent"))
        if fid not in filer_idents:
            continue
        report_types = [
            row.get(f"reportTypeCd{i}") for i in range(1, 11) if (row.get(f"reportTypeCd{i}") or "").strip()
        ]
        writer.add({
            "report_info_ident": int(row["reportInfoIdent"]),
            "filer_ident": fid,
            "filer_name": (row.get("filerName") or "").strip(),
            "form_type": (row.get("formTypeCd") or "").strip(),
            "report_types": ",".join(report_types),
            "received_dt": parse_tec_date(row.get("receivedDt")),
            "filed_dt": parse_tec_date(row.get("filedDt")),
            "period_start": parse_tec_date(row.get("periodStartDt")),
            "period_end": parse_tec_date(row.get("periodEndDt")),
            "election_dt": parse_tec_date(row.get("electionDt")),
            "election_type": (row.get("electionTypeCd") or "").strip() or None,
            "superseded": (row.get("infoOnlyFlag") or "").strip().upper() == "Y",
            "unitemized_contribs": to_decimal(row.get("unitemizedContribAmount")),
            "total_contribs": to_decimal(row.get("totalContribAmount")),
            "unitemized_expend": to_decimal(row.get("unitemizedExpendAmount")),
            "total_expend": to_decimal(row.get("totalExpendAmount")),
            "loan_balance": to_decimal(row.get("loanBalanceAmount")),
            "cash_on_hand": to_decimal(row.get("contribsMaintainedAmount")),
            "special": special,
        })
    writer.flush()
    logger.info("tx_filings: upserted %d reports", writer.total)


def iter_transaction_rows(zf, members: List[str], filer_idents: set) -> Iterator[dict]:
    """Shared filter for contribution/expenditure shards: our filers only,
    skip superseded reports, skip non-itemized placeholder rows."""
    for member in members:
        n = 0
        for row in stream_csv(zf, member):
            if norm_ident(row.get("filerIdent")) not in filer_idents:
                continue
            if (row.get("infoOnlyFlag") or "").strip().upper() == "Y":
                continue
            n += 1
            yield row
        logger.info("  %s: %d matching rows", member, n)


def import_contributions(
    sb, zf, seeds: Dict[str, SeedCandidate],
    table: str = "tx_contributions", ident_to_candidate: Optional[Dict[str, str]] = None,
):
    """contribs_##.csv → tx_contributions (or tx_ie_contributions when called
    with the DCE filer set)."""
    idents = set(ident_to_candidate) if ident_to_candidate is not None else set(seeds)
    writer = BatchWriter(sb, table, on_conflict="report_info_ident,contribution_info_id")
    skipped_precycle = 0
    sources = [(members_matching(zf, r"contribs_\d+\.csv"), False),
               (optional_members(zf, SPECIAL_CONTRIB_FILES), True)]
    for members, special in sources:
      for row in iter_transaction_rows(zf, members, idents):
        iso = parse_tec_date(row.get("contributionDt"))
        cycle = classify_cycle(iso)
        if cycle == "pre-cycle":
            skipped_precycle += 1
            continue
        fid = norm_ident(row.get("filerIdent"))
        ptype, last, first = contributor_name(row, "contributor")
        rec = {
            "report_info_ident": int(row["reportInfoIdent"]),
            "contribution_info_id": int(row["contributionInfoId"]),
            "contributor_type": ptype,
            "contributor_last_name": last,
            "contributor_first_name": first,
            "employer": (row.get("contributorEmployer") or "").strip() or None,
            "occupation": (row.get("contributorOccupation") or "").strip() or None,
            "amount": to_decimal(row.get("contributionAmount")) or 0.0,
            "contribution_date": iso,
            "city": (row.get("contributorStreetCity") or "").strip() or None,
            "state": (row.get("contributorStreetStateCd") or "").strip() or None,
            "zip": (row.get("contributorStreetPostalCode") or "").strip() or None,
            "out_of_state_pac": (row.get("contributorOosPacFlag") or "").strip().upper() == "Y",
            "cycle": cycle,
            "source_form_type": (row.get("formTypeCd") or "").strip(),
            "special": special,
        }
        if ident_to_candidate is not None:
            # tx_ie_contributions keys the committee by ie_filer_ident and has
            # no filer_ident column.
            rec["ie_filer_ident"] = fid
        else:
            rec["filer_ident"] = fid
            rec["candidate_id"] = seeds[fid].id
        writer.add(rec)
    writer.flush()
    logger.info("%s: upserted %d rows (%d pre-cycle skipped)", table, writer.total, skipped_precycle)


def import_expenditures(sb, zf, seeds: Dict[str, SeedCandidate]):
    writer = BatchWriter(sb, "tx_expenditures", on_conflict="report_info_ident,expend_info_id")
    skipped_precycle = 0
    sources = [(members_matching(zf, r"expend_\d+\.csv"), False),
               (optional_members(zf, SPECIAL_EXPEND_FILES), True)]
    for members, special in sources:
      for row in iter_transaction_rows(zf, members, set(seeds)):
        iso = parse_tec_date(row.get("expendDt"))
        cycle = classify_cycle(iso)
        if cycle == "pre-cycle":
            skipped_precycle += 1
            continue
        fid = norm_ident(row.get("filerIdent"))
        ptype, last, first = contributor_name(row, "payee")
        writer.add({
            "report_info_ident": int(row["reportInfoIdent"]),
            "expend_info_id": int(row["expendInfoId"]),
            "filer_ident": fid,
            "candidate_id": seeds[fid].id,
            "payee_type": ptype,
            "payee_last_name": last,
            "payee_first_name": first,
            "payee_city": (row.get("payeeStreetCity") or "").strip() or None,
            "payee_state": (row.get("payeeStreetStateCd") or "").strip() or None,
            "payee_zip": (row.get("payeeStreetPostalCode") or "").strip() or None,
            "amount": to_decimal(row.get("expendAmount")) or 0.0,
            "expenditure_date": iso,
            "category_code": (row.get("expendCatCd") or "").strip() or None,
            "description": (row.get("expendDescr") or "").strip() or None,
            "cycle": cycle,
            "source_form_type": (row.get("formTypeCd") or "").strip(),
            "special": special,
        })
    writer.flush()
    logger.info("tx_expenditures: upserted %d rows (%d pre-cycle skipped)", writer.total, skipped_precycle)


def import_loans(sb, zf, seeds: Dict[str, SeedCandidate]):
    writer = BatchWriter(sb, "tx_loans", on_conflict="report_info_ident,loan_info_id")
    for row in iter_transaction_rows(zf, ["loans.csv"], set(seeds)):
        iso = parse_tec_date(row.get("loanDt"))
        cycle = classify_cycle(iso)
        if cycle == "pre-cycle":
            continue
        fid = norm_ident(row.get("filerIdent"))
        ptype, last, first = contributor_name(row, "lender")
        writer.add({
            "report_info_ident": int(row["reportInfoIdent"]),
            "loan_info_id": int(row["loanInfoId"]),
            "filer_ident": fid,
            "candidate_id": seeds[fid].id,
            "lender_type": ptype,
            "lender_last_name": last,
            "lender_first_name": first,
            "amount": to_decimal(row.get("loanAmount")) or 0.0,
            "loan_date": iso,
            "is_guarantor": (row.get("loanGuaranteedFlag") or "").strip().upper() == "Y",
            "cycle": cycle,
        })
    writer.flush()
    logger.info("tx_loans: upserted %d rows", writer.total)


def import_dce(sb, zf, seeds: Dict[str, SeedCandidate], targets: Dict[str, tuple],
               special_report_ids: Optional[set] = None) -> set:
    """cand.csv → tx_ie_committees + tx_independent_expenditures.

    Texas's independent-expenditure analog: a CAND record names the candidate
    a direct campaign expenditure benefits, including office sought — so we
    match on structured (last, first) + candidateSeekOfficeCd = GOVERNOR
    instead of CA's committee-name regex. Returns the DCE filer ident set for
    the ie-contributions stage.
    """
    seed_by_name = {
        (norm_name(c.name.split()[-1]), norm_name(c.name.split()[0])): c
        for c in seeds.values()
        if len(c.name.split()) >= 2
    }
    committees: Dict[str, str] = {}
    writer = BatchWriter(sb, "tx_independent_expenditures", on_conflict="expend_info_id,expend_persent_id")
    unmatched = 0
    for row in stream_csv(zf, "cand.csv"):
        if (row.get("candidateSeekOfficeCd") or "").strip() not in TARGET_OFFICES:
            continue
        if (row.get("infoOnlyFlag") or "").strip().upper() == "Y":
            continue
        iso = parse_tec_date(row.get("expendDt"))
        cycle = classify_cycle(iso)
        if cycle in ("pre-cycle", "unknown"):
            continue
        fid = norm_ident(row.get("filerIdent"))
        key = (norm_name(row.get("candidateNameLast")), norm_name(row.get("candidateNameFirst")))
        cand = seed_by_name.get(key)
        sup_opp = "S"
        if fid in targets:
            cand_id, sup_opp = targets[fid]
        elif cand:
            cand_id = cand.id
        else:
            unmatched += 1
            continue
        committees[fid] = (row.get("filerName") or "").strip()
        writer.add({
            "expend_info_id": int(row["expendInfoId"]),
            "expend_persent_id": int(row["expendPersentId"]),
            "report_info_ident": int(row["reportInfoIdent"]),
            "ie_filer_ident": fid,
            "target_candidate_id": cand_id,
            "support_oppose": sup_opp,
            "amount": to_decimal(row.get("expendAmount")) or 0.0,
            "expenditure_date": iso,
            "description": (row.get("expendDescr") or "").strip() or None,
            "category_code": (row.get("expendCatCd") or "").strip() or None,
            "cycle": cycle,
            "special": int(row["reportInfoIdent"]) in (special_report_ids or set()),
        })
    for fid, name in committees.items():
        upsert_batch(sb, "tx_ie_committees", [{"filer_ident": fid, "name": name}], on_conflict="filer_ident")
    writer.flush()
    logger.info(
        "tx_independent_expenditures: upserted %d rows across %d DCE filers "
        "(%d GOVERNOR rows didn't match a seeded candidate)",
        writer.total, len(committees), unmatched,
    )
    return set(committees)


def import_spac_links(sb, zf, seeds: Dict[str, SeedCandidate]) -> set:
    """spacs.csv → tx_ie_committees (+ tx_ie_committee_targets rows tagged
    'auto:spacs.csv').

    TEC staff maintain explicit SPAC → candidate links with a
    SUPPORT/OPPOSE/ASSIST position — the structured version of what CA forced
    us to reconstruct with committee-name regexes. Candidates' principal
    committees (committee_filer_ident on tx_candidates) are excluded; the rest
    are outside groups whose donors ie-contributions will pick up. Their
    expenditure attribution is a port-time decision (see docs).
    """
    principal = {c.committee_filer_ident for c in seeds.values() if c.committee_filer_ident}
    position_map = {"SUPPORT": "S", "OPPOSE": "O", "ASSIST": "S"}
    added: set = set()
    for row in stream_csv(zf, "spacs.csv"):
        cand = seeds.get(norm_ident(row.get("candidateFilerIdent")))
        if not cand:
            continue
        if (row.get("spacCommitteeStatusCd") or "").strip() != "ACTIVE":
            continue
        spac_fid = norm_ident(row.get("spacFilerIdent"))
        if not spac_fid or spac_fid in principal:
            continue
        upsert_batch(sb, "tx_ie_committees", [{
            "filer_ident": spac_fid,
            "name": (row.get("spacFilerName") or "").strip(),
        }], on_conflict="filer_ident")
        upsert_batch(sb, "tx_ie_committee_targets", [{
            "ie_filer_ident": spac_fid,
            "target_candidate_id": cand.id,
            "support_oppose": position_map.get((row.get("spacPositionCd") or "").strip(), "S"),
            "note": "auto:spacs.csv",
        }], on_conflict="ie_filer_ident,target_candidate_id")
        added.add(spac_fid)
    logger.info("tx_ie_committees: registered %d linked SPACs from spacs.csv", len(added))
    return added


def import_ie_contributions(sb, zf, seeds: Dict[str, SeedCandidate]):
    res = sb.table("tx_ie_committees").select("filer_ident").execute()
    idents = {norm_ident(r["filer_ident"]): None for r in (res.data or [])}
    if not idents:
        logger.info("no DCE committees in tx_ie_committees yet — run --only ie first")
        return
    import_contributions(sb, zf, seeds, table="tx_ie_contributions", ident_to_candidate=idents)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-download", action="store_true", help="Reuse existing zip in WORK_DIR")
    parser.add_argument("--discover", action="store_true",
                        help="List filers active this cycle for --office and exit (no DB needed)")
    parser.add_argument("--office", default="GOVERNOR", choices=list(TARGET_OFFICES),
                        help="Office for --discover (default GOVERNOR)")
    parser.add_argument(
        "--only",
        choices=["filings", "contributions", "expenditures", "loans", "ie", "ie-contributions"],
        help="Run a single stage",
    )
    args = parser.parse_args()

    if not args.skip_download:
        download_bulk()
    zf = zipfile.ZipFile(ZIP_PATH)

    if args.discover:
        discover_governor_filers(zf, args.office)
        return

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        sys.exit(1)
    from supabase import create_client
    sb = create_client(url, key)
    logger.info("connected to %s", url)

    seeds = load_seed_candidates(sb)
    if not seeds:
        logger.error("no seeded candidates — populate tx_candidates first (try --discover)")
        sys.exit(1)
    targets = load_ie_targets(sb)

    special_report_ids = load_special_report_ids(zf)

    ie_filers: set = set()
    if args.only in (None, "ie"):
        ie_filers = import_dce(sb, zf, seeds, targets, special_report_ids)
        ie_filers |= import_spac_links(sb, zf, seeds)

    if args.only in (None, "filings"):
        # Include DCE/SPAC filers so their cover sheets (and unitemized totals) land too.
        import_filings(sb, zf, set(seeds) | ie_filers)

    if args.only in (None, "contributions"):
        import_contributions(sb, zf, seeds)

    if args.only in (None, "expenditures"):
        import_expenditures(sb, zf, seeds)

    if args.only in (None, "loans"):
        import_loans(sb, zf, seeds)

    if args.only in (None, "ie-contributions"):
        import_ie_contributions(sb, zf, seeds)

    logger.info("done at %s", datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    main()
