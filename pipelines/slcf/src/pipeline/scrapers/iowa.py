"""
scrapers/iowa.py — Download Iowa campaign finance data.

POSTs to the Iowa Ethics and Campaign Disclosure Board public reports API:
  https://webapp.iecdb.iowa.gov/api/publicreports/state
which returns all ~17,000+ DR-2 filing records as JSON, each with a fileUrl
pointing to a pre-generated PDF on Azure Blob Storage. Both the index API
and the individual PDF downloads require no authentication.

The index is always fetched on every run (~7.5 MB). PDFs are downloaded
incrementally — already-present files are skipped unless they belong to the
current year (which are always re-checked for amendments) or --force is set.

When a committee amends a filing, Iowa generates a new PDF with a new
filename (timestamp in name). The index always returns the latest version.
Old amendment files persist on disk as orphans but are never re-parsed,
since the parser reads only files listed in the manifest.

--search (transactions): contributions and expenditures also come from the
IECDB Searchable Database, the JSON behind the site's contribution and
expenditure search —
  https://webapp.iecdb.iowa.gov/api/search/table
— which carries a stable per-transaction id (transactionId) and the kind of
the other party (committee / organisation / individual), neither of which the
PDFs have, and is current to the latest filed report (the Iowa Data Hub's
bulk exports, datasets 917 / 918, stopped taking new filings in July 2026).
Queried statewide, one calendar quarter at a time:
  • every row: one query per committee type (lookups/committee/types) —
    option 7 "to a committee type" for contributions, 8 "from a committee
    type" for expenditures. A query is capped at 300,000 rows, so a capped
    window is split; each window is padded by a day on either side (some
    rows are stamped 06:00 UTC and fall outside an exact window) and rows
    are kept by their own date, deduplicated by transactionId.
  • the organisations: option 4 "from an organization" / 6 "to an
    organization", which the API answers statewide (a committee-type code
    must be present but is not applied). Committees carry their own code;
    nameless lump sums are named "Un-itemized"; everyone else is a person.
Rows go to search_{contributions|expenditures}_{year}.csv, written as .part
and renamed only once every window succeeded; a failure raises, so the
scraper exits non-zero before a partial year can be parsed. The PDFs are
still downloaded in this mode: loans (Sch-F1/F2) and committee details exist
only there. A run without --search deletes the search files, so the parser
goes back to the PDFs' own schedules.
"""

import calendar
import csv
import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from tqdm import tqdm
from tqdm.contrib.logging import logging_redirect_tqdm

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
from src.reporting.logger import get_logger

# =============================== paths ================================
RAW_DIR  = PROJECT_ROOT / "data" / "Iowa" / "raw"
MANIFEST = PROJECT_ROOT / "data" / "Iowa" / "manifest.csv"

RAW_DIR.mkdir(parents=True, exist_ok=True)

MANIFEST_COLS = [
    "file_id", "period_year", "period_description", "report_type",
    "organization_type", "candidate_name", "committee_code", "committee_name",
    "filed_on", "filename", "file_url", "downloaded_at",
]

# ============================ constants ==============================

INDEX_URL = "https://webapp.iecdb.iowa.gov/api/publicreports/state"

# Required headers — without Content-Type/Origin the API returns 400.
REQUEST_HEADERS = {
    "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                     "AppleWebKit/537.36 (KHTML, like Gecko) "
                     "Chrome/147.0.0.0 Safari/537.36",
    "Content-Type":  "application/json",
    "Accept":        "application/json, text/plain, */*",
    "Referer":       "https://webapp.iecdb.iowa.gov/publicReports/state-reports",
    "Origin":        "https://webapp.iecdb.iowa.gov",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
}

# --search: the Searchable Database. Per output table: (transactionType,
# per-committee-type option, organisation option) — the site's own codes.
SEARCH_URL   = "https://webapp.iecdb.iowa.gov/api/search/table"
SEARCH_TYPES = "https://webapp.iecdb.iowa.gov/api/lookups/committee/types"
SEARCH = {
    "contributions": ("CON", 7, 4),   # returns CON and INK rows
    "expenditures":  ("EXP", 8, 6),
}
SEARCH_CAP        = 300_000           # the API's row limit per query
SEARCH_TRIES      = 4
SEARCH_START_YEAR = 2008              # earliest rows in the database
SEARCH_COLS = [
    "transactionId", "date", "transactionType", "kind", "amount", "checkNumber",
    "committeeType", "primaryCommitteeCode", "primaryName",
    "secondaryCommitteeCode", "secondaryName", "secondaryAddress1",
    "secondaryAddress2", "secondaryCity", "secondaryState", "secondaryZip",
]

# ========================= manifest helpers ==========================

def load_manifest() -> dict[str, dict]:
    """Return dict of filename → manifest row for all downloaded files."""
    if not MANIFEST.exists():
        return {}
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        return {row["filename"]: row for row in csv.DictReader(f)}


def strip_manifest(keep_fn):
    """Rewrite manifest keeping only rows where keep_fn(row) is True."""
    if not MANIFEST.exists():
        return
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    with open(MANIFEST, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        writer.writeheader()
        writer.writerows(r for r in rows if keep_fn(r))


def append_manifest(record: dict):
    write_header = not MANIFEST.exists() or MANIFEST.stat().st_size == 0
    with open(MANIFEST, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        if write_header:
            writer.writeheader()
        writer.writerow(record)


# ========================== index fetch =============================

def fetch_index(session: requests.Session) -> list[dict]:
    """
    POST to the public reports state endpoint and return all filing records.
    The empty JSON body triggers a full dump (no filters).
    """
    resp = session.post(INDEX_URL, json={}, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    results = data.get("results", [])
    return results


# ========================== download =================================

def download_pdf(session: requests.Session, file_url: str,
                 dest: Path, log) -> bool:
    """Download a single PDF to dest. Returns True on success."""
    try:
        r = session.get(file_url, timeout=120, stream=True)
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)
        return True
    except Exception as e:
        log.file_download_error(filename=dest.name, error=str(e))
        return False


# ==================== transactions: --search mode ====================

def _search_post(session: requests.Session, body: dict) -> list[dict]:
    """One Searchable Database query, retried. HTTP 204 is an empty result."""
    last = None
    for attempt in range(SEARCH_TRIES):
        if attempt:
            time.sleep(15 * attempt)
        try:
            resp = session.post(SEARCH_URL, json=body, timeout=900)
            if resp.status_code == 204:
                return []
            resp.raise_for_status()
            rows = resp.json()
            if isinstance(rows, list):
                return rows
            last = f"unexpected response: {str(rows)[:200]}"
        except (requests.RequestException, ValueError) as e:
            last = e
    raise RuntimeError(f"search {body}: failed after {SEARCH_TRIES} tries: {last}")


def _search_window(session: requests.Session, tx_type: str, option: int, type_cd: str,
                   start: date, end: date) -> list[dict]:
    """Rows dated start..end (inclusive) for one query, splitting the window
    when the API's row cap is hit or a long window keeps failing (the
    server's own SQL timeout). The query is padded by a day on each side;
    rows are kept by their own date."""
    body = {"transactionType": tx_type, "transactionOption": option,
            "primaryCommitteeTypeCd": type_cd, "primaryCommitteeId": None,
            "secondaryCommitteeId": None,
            "DateFrom": f"{start - timedelta(days=1)}T00:00:00Z",
            "DateTo":   f"{end + timedelta(days=1)}T23:59:59Z"}
    try:
        rows = _search_post(session, body)
    except RuntimeError:
        if (end - start).days < 7:
            raise
        rows = None
    if rows is None or len(rows) >= SEARCH_CAP:
        if start == end:
            raise RuntimeError(f"search {tx_type}/{option}/{type_cd} {start}: "
                               f"{SEARCH_CAP:,}-row cap on a single day")
        mid = start + (end - start) // 2
        return (_search_window(session, tx_type, option, type_cd, start, mid)
                + _search_window(session, tx_type, option, type_cd, mid + timedelta(days=1), end))
    lo, hi = start.isoformat(), end.isoformat()
    return [r for r in rows if lo <= (r.get("date") or "")[:10] <= hi]


def _search_quarters(start_year: int, end_year: int) -> list[tuple[date, date]]:
    """Calendar quarters from start_year through end_year (the current year's
    last quarter runs to 31 December, so a row dated ahead by a filer's typo
    is still fetched)."""
    return [(date(y, m, 1), date(y, m + 2, calendar.monthrange(y, m + 2)[1]))
            for y in range(start_year, end_year + 1) for m in (1, 4, 7, 10)]


def _search_kind(row: dict, organisations: set[str]) -> str:
    if row.get("secondaryCommitteeCode"):
        return "Committee"
    if row.get("transactionId") in organisations:
        return "Organization"
    if (row.get("secondaryName") or "").strip().lower() == "un-itemized":
        return "Unitemized"
    return "Individual"


def run_search(log, start_year: int | None, end_year: int | None) -> int:
    """--search: fetch both tables from the Searchable Database into
    search_{label}_{year}.csv (see the module docstring). Returns the number
    of year files written; raises on any failure."""
    session = requests.Session()
    session.headers.update({**REQUEST_HEADERS,
                            "Referer": "https://webapp.iecdb.iowa.gov/searchable-database"})
    types = None
    for attempt in range(SEARCH_TRIES):
        try:
            r = session.get(SEARCH_TYPES, timeout=120)
            r.raise_for_status()
            types = {t["code"]: (t.get("name") or "").strip() for t in r.json()}
            break
        except (requests.RequestException, ValueError, KeyError, TypeError) as e:
            log.warning(f"  committee types: try {attempt + 1}/{SEARCH_TRIES} failed: {e}")
            time.sleep(15 * (attempt + 1))
    if not types:
        raise RuntimeError("search: no committee types from lookups/committee/types")

    first = start_year or SEARCH_START_YEAR
    last  = end_year or datetime.today().year
    files = 0
    for label, (tx_type, type_option, org_option) in SEARCH.items():
        filename = f"search_{label}_{first}-{last}"
        log.file_download_start(filename=filename)
        t0 = time.perf_counter()
        handles: dict[str, tuple] = {}
        counts:  dict[str, int]   = {}
        seen:    set[str]         = set()
        try:
            for q_start, q_end in _search_quarters(first, last):
                organisations = {r.get("transactionId") for r in _search_window(
                    session, tx_type, org_option, next(iter(types)), q_start, q_end)}
                for type_cd, type_name in types.items():
                    for row in _search_window(session, tx_type, type_option, type_cd,
                                              q_start, q_end):
                        tid = row.get("transactionId")
                        if not tid or tid in seen:
                            continue
                        seen.add(tid)
                        year = row["date"][:4]
                        if year not in handles:
                            fh = open(RAW_DIR / f"search_{label}_{year}.csv.part", "w",
                                      encoding="utf-8", newline="")
                            w = csv.DictWriter(fh, fieldnames=SEARCH_COLS, extrasaction="ignore")
                            w.writeheader()
                            handles[year] = (fh, w)
                            counts[year] = 0
                        handles[year][1].writerow({**row, "kind": _search_kind(row, organisations),
                                                   "committeeType": type_name})
                        counts[year] += 1
                log.info(f"    {label} {q_start}..{q_end}: {len(seen):,} rows so far")
        except BaseException as e:
            for year, (fh, _) in handles.items():
                fh.close()
                (RAW_DIR / f"search_{label}_{year}.csv.part").unlink(missing_ok=True)
            log.file_download_error(filename=filename, error=str(e))
            raise
        for year, (fh, _) in handles.items():
            fh.close()
            (RAW_DIR / f"search_{label}_{year}.csv.part").replace(
                RAW_DIR / f"search_{label}_{year}.csv")
        # An in-range year file from an earlier run that got no rows now.
        for old in RAW_DIR.glob(f"search_{label}_*.csv"):
            year = old.stem.rsplit("_", 1)[-1]
            if year.isdigit() and first <= int(year) <= last and year not in counts:
                old.unlink()
        log.file_download_ok(filename=filename,
                             bytes=sum((RAW_DIR / f"search_{label}_{y}.csv").stat().st_size
                                       for y in counts),
                             rows=sum(counts.values()),
                             duration_s=round(time.perf_counter() - t0, 2))
        files += len(counts)
    return files


# ============================== run ==================================

def run(
    force: bool = False,
    entities: bool = False,
    transactions: bool = False,
    start_year: int | None = None,
    end_year: int | None = None,
    contributions: bool = False,
    expenditures: bool = False,
    candidates: bool = False,
    committees: bool = False,
    search: bool = False,
):
    """
    Download Iowa DR-2 filing PDFs from the IECDB public reports API.

    Iowa doesn't separate entities vs transactions — everything is in the
    PDFs, so horizontal scope flags are ignored. Vertical scope (year range
    and --force) is fully supported.

    Vertical scope:
        (no flag)        incremental — skip already-downloaded files;
                         always re-check current-year PDFs for amendments
        --start-year     re-download all PDFs with period_year >= YYYY
        --end-year       re-download all PDFs with period_year <= YYYY
        --force          wipe manifest and re-download everything

    search=True: contributions and expenditures are first fetched from the
    Searchable Database (search_*_{year}.csv, with transaction ids) — see the
    module docstring; a failure there raises (exit 1). The PDFs follow as
    usual, for loans and committee details.
    """
    log = get_logger("iowa", "scrape")
    t0  = time.perf_counter()
    log._emit("scrape_started", force=force, entities=entities,
              transactions=transactions, start_year=start_year, end_year=end_year,
              search=search)

    if search:
        try:
            n = run_search(log, start_year, end_year)
        except BaseException as e:
            log._emit("scrape_completed", status="error",
                      duration_s=round(time.perf_counter() - t0, 1),
                      files_ok=0, files_err=1,
                      error_type=type(e).__name__, error=str(e))
            raise
        log.info(f"  Searchable Database: {n} year files "
                 f"({round(time.perf_counter() - t0, 1)}s)")
    else:
        # Search files left by an earlier --search run would replace the
        # PDFs' own schedules in the parser.
        for old in RAW_DIR.glob("search_*.csv"):
            old.unlink()

    current_year     = datetime.today().year
    current_year_str = str(current_year)
    year_range_active = start_year is not None or end_year is not None

    files_ok = files_err = 0

    try:
        session = requests.Session()
        session.headers.update(REQUEST_HEADERS)

        # ── Fetch the full index ──────────────────────────────────────
        log.info("Fetching filing index from IECDB public reports API…")
        t_idx = time.perf_counter()
        try:
            records = fetch_index(session)
        except Exception as e:
            log._emit("scrape_completed", status="error",
                      duration_s=round(time.perf_counter() - t0, 1),
                      files_ok=0, files_err=0,
                      error_type=type(e).__name__, error=str(e))
            raise

        log.info(f"  Index: {len(records):,} filings "
                 f"({round(time.perf_counter() - t_idx, 1)}s)")

        # ── Filter by year range ──────────────────────────────────────
        if start_year is not None:
            records = [r for r in records if int(r.get("periodYear", 0)) >= start_year]
        if end_year is not None:
            records = [r for r in records if int(r.get("periodYear", 0)) <= end_year]

        # ── Prepare manifest ──────────────────────────────────────────
        if force:
            # If year range active with --force that's blocked by CLI validation,
            # but handle gracefully: wipe only in-range years.
            if year_range_active:
                def _in_range(r):
                    try:
                        yr = int(r["period_year"])
                    except (ValueError, KeyError):
                        return True
                    if start_year is not None and yr >= start_year:
                        return False
                    if end_year is not None and yr <= end_year:
                        return False
                    return True
                strip_manifest(_in_range)
            else:
                strip_manifest(lambda _: False)
            done = {}
        elif year_range_active:
            # Wipe manifest entries in the requested range so we re-download them.
            def _outside_range(r):
                try:
                    yr = int(r["period_year"])
                except (ValueError, KeyError):
                    return True
                if start_year is not None and yr >= start_year:
                    return False
                if end_year is not None and yr <= end_year:
                    return False
                return True
            strip_manifest(_outside_range)
            done = load_manifest()
        else:
            done = load_manifest()

        # ── Download PDFs ─────────────────────────────────────────────
        today = datetime.today().strftime("%Y-%m-%d")

        with logging_redirect_tqdm(loggers=[log._log]):
            with tqdm(records, desc="  iowa PDFs", unit="pdf",
                      dynamic_ncols=True,
                      total=len(records)) as bar:
                for rec in bar:
                    filename    = rec.get("fileName", "")
                    file_url    = rec.get("fileUrl", "")
                    period_year = str(rec.get("periodYear", ""))
                    file_id     = str(rec.get("id", ""))

                    if not filename or not file_url:
                        bar.set_postfix_str("skip:no-url", refresh=False)
                        continue

                    dest = RAW_DIR / filename
                    is_current_year = (period_year == current_year_str)

                    # Skip if already downloaded and not current year /
                    # not in a forced re-download range.
                    if filename in done and not year_range_active:
                        if not is_current_year:
                            log.file_download_skip(filename=filename)
                            bar.set_postfix_str(filename[:40], refresh=False)
                            continue
                        # Current year: skip only if file still on disk
                        # (unchanged filename = no new amendment)
                        if dest.exists() and dest.stat().st_size > 0:
                            log.file_download_skip(filename=filename)
                            bar.set_postfix_str(filename[:40], refresh=False)
                            continue

                    log.file_download_start(filename=filename)
                    t_file = time.perf_counter()

                    ok = download_pdf(session, file_url, dest, log)
                    if not ok:
                        files_err += 1
                        bar.set_postfix_str(f"ERR:{filename[:30]}", refresh=False)
                        continue

                    log.file_download_ok(
                        filename=filename,
                        bytes=dest.stat().st_size,
                        rows=0,    # PDFs don't have a meaningful "row count" at scrape time
                        duration_s=round(time.perf_counter() - t_file, 2),
                    )

                    # Upsert manifest — remove old entry for same file_id if any
                    # (handles the case where a filing was amended and filename changed)
                    append_manifest({
                        "file_id":            file_id,
                        "period_year":        period_year,
                        "period_description": rec.get("periodDescription", ""),
                        "report_type":        rec.get("reportType", ""),
                        "organization_type":  rec.get("organizationType", ""),
                        "candidate_name":     rec.get("candidateName") or "",
                        "committee_code":     rec.get("committeeCode", ""),
                        "committee_name":     rec.get("committeeName", ""),
                        "filed_on":           rec.get("filedOn", ""),
                        "filename":           filename,
                        "file_url":           file_url,
                        "downloaded_at":      today,
                    })
                    done[filename] = {}
                    files_ok += 1
                    bar.set_postfix_str(filename[:40], refresh=False)

                    # Polite delay — blob storage is fast but ~17k requests warrants courtesy
                    time.sleep(0.05)

        duration = round(time.perf_counter() - t0, 1)
        log.info(f"Done in {duration}s — {files_ok:,} downloaded, {files_err} errors")
        log._emit("scrape_completed", status="completed", duration_s=duration,
                  files_ok=files_ok, files_err=files_err)

    except KeyboardInterrupt:
        log.warning("Interrupted")
        log._emit("scrape_completed", status="interrupted",
                  duration_s=round(time.perf_counter() - t0, 1),
                  files_ok=files_ok, files_err=files_err)
        raise

    except Exception as e:
        log._emit("scrape_completed", status="error",
                  duration_s=round(time.perf_counter() - t0, 1),
                  files_ok=files_ok, files_err=files_err,
                  error_type=type(e).__name__, error=str(e))
        raise


# ================================ CLI ================================

if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Download Iowa campaign finance PDFs from the IECDB public reports API."
    )

    vert = ap.add_mutually_exclusive_group()
    vert.add_argument("--force",      action="store_true",
                      help="re-download all PDFs in scope, wipe manifest")
    vert.add_argument("--start-year", type=int, metavar="YYYY",
                      help="earliest period_year to download (inclusive)")

    ap.add_argument("--end-year",     type=int, metavar="YYYY",
                    help="latest period_year to download (inclusive, ≤ current year)")

    ap.add_argument("--transactions", action="store_true",
                    help="(ignored — Iowa PDFs contain all data types)")
    ap.add_argument("--entities",     action="store_true",
                    help="(ignored — Iowa PDFs contain all data types)")
    ap.add_argument("--contributions", action="store_true")
    ap.add_argument("--expenditures",  action="store_true")
    ap.add_argument("--candidates",    action="store_true")
    ap.add_argument("--committees",    action="store_true")
    ap.add_argument("--search",        action="store_true",
                    help="contributions and expenditures from the IECDB Searchable "
                         "Database (with transaction ids); PDFs still give loans")

    args, _ = ap.parse_known_args()

    cy = datetime.today().year
    if args.end_year:
        if args.end_year > cy:
            ap.error(f"--end-year cannot exceed current year ({cy})")
        if args.start_year and args.start_year > args.end_year:
            ap.error("--start-year cannot be greater than --end-year")
    if args.force and args.end_year:
        ap.error("--force cannot be combined with --end-year")

    try:
        run(
            force=args.force,
            entities=args.entities,
            transactions=args.transactions,
            start_year=args.start_year,
            end_year=args.end_year,
            contributions=args.contributions,
            expenditures=args.expenditures,
            candidates=args.candidates,
            committees=args.committees,
            search=args.search,
        )
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
