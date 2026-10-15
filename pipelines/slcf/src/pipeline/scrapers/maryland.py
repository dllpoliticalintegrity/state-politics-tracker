"""
scrapers/maryland.py — Download Maryland campaign finance data.

POSTs to the Maryland State Board of Elections campaign finance JSON API:
  https://api-campaignfinance.maryland.gov/api/ExportPublicData/GetExportPublicDownloadData

  - Contributions & Loans: transactionTypeCode=TCON, per filing year
  - Expenditures:          transactionTypeCode=TEXP, per filing year
  - Committees:            transactionTypeCode=TCMD, filingYear=0 (all at once)

No authentication required — only Content-Type and Accept headers needed.
Data begins in 2021; earlier filing years return empty responses.
Response is text/csv (CRLF line endings) with a timestamp title row on
line 0 followed by a standard header row on line 1. Some fields (ZipCode)
use Excel-style quoting (="VALUE") — stripped in the parser.

--grid (transactions only): fetch contributions and expenditures from the
PublicGrid export instead —
  https://api-campaignfinance.maryland.gov/api/PublicGrid/DownloadPublicGridData
the CSV behind the site's contribution / expenditure search pages, and the
source of state-politics-tracker's old pilot importer. The bulk export above
carries no transaction id; the grid's TransactionID is the stable per-row key
that tracker's loader upserts on (columns.py, TRANSACTION_IDS). The grid is
queried statewide by TRANSACTION DATE, one calendar month per request (~60k
rows / ~30 s in a busy month), and each year's months are concatenated into
grid_{contributions|expenditures}_{year}.csv, which the parser reads in place
of the bulk files. The TCON grid holds no loans (they have their own grid),
so grid mode writes no loans_debts rows — as the pilot.
"""

import calendar
import csv
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
from src.reporting.logger import get_logger

# ================================ paths ================================
RAW_DIR  = PROJECT_ROOT / "data" / "Maryland" / "raw"
MANIFEST = PROJECT_ROOT / "data" / "Maryland" / "manifest.csv"

RAW_DIR.mkdir(parents=True, exist_ok=True)

MANIFEST_COLS = ["transaction_type", "year", "filename", "downloaded_at", "row_count"]

# ============================ constants ================================

API_URL = "https://api-campaignfinance.maryland.gov/api/ExportPublicData/GetExportPublicDownloadData"

TRANSACTION_TYPES = {
    "TCON": "contributions",
    "TEXP": "expenditures",
}

# Earliest filing year that returns data — 2020 and earlier return empty responses.
START_YEAR = 2021

# --grid: per transaction type, (grid name, filter key, row-count endpoint,
# extra filter). The expenditure grid takes no type code (as the pilot).
GRID_URL   = "https://api-campaignfinance.maryland.gov/api/PublicGrid/DownloadPublicGridData"
GRID_COUNT = "https://api-campaignfinance.maryland.gov/api/PublicGrid/{}"
GRID = {
    "TCON": ("ContributionPublicGrid", "contributionSearchFilter", "GetContributionList",
             {"transactionTypeCode": "TCON"}),
    "TEXP": ("ExpenditurePublicGrid", "expenditureSearchFilter", "GetExpenditureList", {}),
}
GRID_TRIES = 4

# ========================= manifest helpers ===========================

def load_manifest() -> set[tuple[str, str]]:
    """Return set of (transaction_type_code, year) already downloaded."""
    if not MANIFEST.exists():
        return set()
    with open(MANIFEST, newline="") as f:
        return {(row["transaction_type"], row["year"])
                for row in csv.DictReader(f)}


def strip_manifest(keep_fn):
    if not MANIFEST.exists():
        return
    with open(MANIFEST, newline="") as f:
        rows = list(csv.DictReader(f))
    with open(MANIFEST, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        writer.writeheader()
        writer.writerows(r for r in rows if keep_fn(r))


def append_manifest(record: dict):
    write_header = not MANIFEST.exists()
    with open(MANIFEST, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        if write_header:
            writer.writeheader()
        writer.writerow(record)


# ========================= download helpers ==========================

def _make_session() -> requests.Session:
    """Create a requests session with headers that avoid 403s from the .NET backend."""
    s = requests.Session()
    s.headers.update({
        "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36",
        "Accept":       "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Referer":      "https://campaignfinance.maryland.gov/",
        "Origin":       "https://campaignfinance.maryland.gov",
    })
    return s


def _decode_response(content: bytes) -> str:
    """Detect and normalize UTF-16 or BOM-prefixed UTF-8 to plain UTF-8 string."""
    if content[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return content.decode("utf-16")
    if len(content) > 1 and content[1] == 0:
        return content.decode("utf-16-le")
    if content[:3] == b"\xef\xbb\xbf":
        return content[3:].decode("utf-8")
    return content.decode("utf-8", errors="replace")


# ============================ committees ============================

def download_committees(log, session: requests.Session) -> tuple[str, int] | None:
    """
    Fetch all registered committees in a single request (filingYear=0).
    Returns (filename, row_count) or None on failure.
    Always re-fetched — committee registrations change continuously.
    """
    filename = "committees.csv"
    out_path = RAW_DIR / filename

    log.file_download_start(filename=filename)
    t0 = time.perf_counter()

    payload = {
        "filingYear":          "0",
        "transactionTypeCode": "TCMD",
        "type":                "CSV",
        "fileName":            "committees",
        "openInNewTab":        False,
    }

    try:
        resp = session.post(API_URL, json=payload, timeout=120)
        resp.raise_for_status()
    except requests.RequestException as e:
        log.file_download_error(filename=filename, error=str(e))
        return None

    text = _decode_response(resp.content)
    out_path.write_text(text, encoding="utf-8")
    # Row count: subtract 2 for the title row and header row
    row_count = max(text.count("\n") - 2, 0)

    log.file_download_ok(
        filename=filename,
        bytes=out_path.stat().st_size,
        rows=row_count,
        duration_s=round(time.perf_counter() - t0, 2),
    )
    return filename, row_count


# ========================== transactions ============================

def download_transaction(log, transaction_type: str, year: str,
                         session: requests.Session) -> tuple[str, int] | None:
    """
    POST to the Maryland CF API and save the CSV response.
    Returns (filename, row_count) or None on failure.
    """
    label    = TRANSACTION_TYPES[transaction_type]
    filename = f"{label}_{year}.csv"
    out_path = RAW_DIR / filename

    log.file_download_start(filename=filename)
    t0 = time.perf_counter()

    payload = {
        "filingYear":          year,
        "transactionTypeCode": transaction_type,
        "type":                "CSV",
        "fileName":            filename,
        "openInNewTab":        False,
    }

    try:
        resp = session.post(API_URL, json=payload, timeout=300)
        resp.raise_for_status()
    except requests.RequestException as e:
        log.file_download_error(filename=filename, error=str(e))
        return None

    text = _decode_response(resp.content)

    # Empty response (pre-2021 years return 0 bytes — skip silently)
    if not text.strip():
        log.file_download_skip(filename=filename)
        return filename, 0

    out_path.write_text(text, encoding="utf-8")
    # Subtract 2 for the title row and header row
    row_count = max(text.count("\n") - 2, 0)

    log.file_download_ok(
        filename=filename,
        bytes=out_path.stat().st_size,
        rows=row_count,
        duration_s=round(time.perf_counter() - t0, 2),
    )
    return filename, row_count


# ===================== transactions: --grid mode =====================

def _grid_windows(year: int) -> list[tuple[str, str]]:
    """One (from, to) window per calendar month of `year`, through the
    current month. The current year's last window runs to 31 December, so a
    row dated ahead of today (a filer's typo) is still fetched."""
    today = date.today()
    last  = 12 if year < today.year else today.month
    out   = []
    for m in range(1, last + 1):
        end = (date(year, 12, 31) if m == last and year == today.year
               else date(year, m, calendar.monthrange(year, m)[1]))
        out.append((f"{year}-{m:02d}-01", end.isoformat()))
    return out


def _grid_window(session: requests.Session, code: str, start: str, end: str) -> str:
    """CSV text (title row, header row, data) of one statewide window, or ''
    when the window holds no rows. The download answers an EMPTY result with
    HTTP 500 (error code 999), so a 500 is checked against the grid's own
    row-count endpoint: 0 rows is an empty window; anything else is a real
    failure, retried, then raised — a silently missing month would read as
    deleted transactions downstream."""
    grid, key, count_endpoint, extra = GRID[code]
    filt = {"pageNumber": 1, "pageSize": 100, "sortBy": "TransactionDate",
            "sortType": "DESC", "fromDate": start, "toDate": end, **extra}
    body = {"publicGridName": grid, "fileName": "export", "type": "CSV", key: filt}
    last = None
    for attempt in range(GRID_TRIES):
        if attempt:
            time.sleep(10 * attempt)
        try:
            resp = session.post(GRID_URL, json=body, timeout=900)
            if resp.status_code == 500:
                n = session.post(GRID_COUNT.format(count_endpoint),
                                 json={**filt, "pageSize": 1}, timeout=120)
                n.raise_for_status()
                if n.json()["data"]["totalItems"] == 0:
                    return ""
            resp.raise_for_status()
            text  = _decode_response(resp.content)
            lines = text.split("\n", 2)
            if len(lines) >= 2 and lines[1].startswith("TransactionID,"):
                return text
            last = f"unexpected response: {text[:200]!r}"
        except (requests.RequestException, ValueError, KeyError, TypeError) as e:
            last = e
    raise RuntimeError(f"{grid} {start}..{end}: failed after {GRID_TRIES} tries: {last}")


def download_grid_year(log, transaction_type: str, year: str,
                       session: requests.Session) -> tuple[str, int]:
    """Fetch one transaction-date year from the PublicGrid export, month by
    month, into grid_{label}_{year}.csv (one title + header row, then every
    month's rows). Written to a .part file and renamed only when every month
    succeeded; any failure raises, so the scraper exits non-zero and the
    orchestrator stops before parsing a partial year."""
    label    = TRANSACTION_TYPES[transaction_type]
    filename = f"grid_{label}_{year}.csv"
    out_path = RAW_DIR / filename
    part     = RAW_DIR / (filename + ".part")

    log.file_download_start(filename=filename)
    t0 = time.perf_counter()
    header = None
    row_count = 0
    try:
        with open(part, "w", encoding="utf-8", newline="") as out:
            for start, end in _grid_windows(int(year)):
                text = _grid_window(session, transaction_type, start, end)
                if not text:
                    continue
                title, head, data = (text.split("\n", 2) + [""])[:3]
                if header is None:
                    header = head
                    out.write(title + "\n" + head + "\n")
                elif head != header:
                    raise RuntimeError(f"{filename}: header changed in {start}..{end}")
                if data and not data.endswith("\n"):
                    data += "\n"
                out.write(data)
                row_count += data.count("\n")
                time.sleep(0.5)
    except Exception as e:
        part.unlink(missing_ok=True)
        log.file_download_error(filename=filename, error=str(e))
        raise

    if header is None:
        part.unlink(missing_ok=True)
        log.file_download_skip(filename=filename)
        return filename, 0
    part.replace(out_path)
    log.file_download_ok(
        filename=filename,
        bytes=out_path.stat().st_size,
        rows=row_count,
        duration_s=round(time.perf_counter() - t0, 2),
    )
    return filename, row_count


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
    grid: bool = False,
):
    """Orchestrate download of Maryland campaign finance data.

    Vertical scope (mutually exclusive):
        force=True              — re-download all years in scope, wipe manifest
        start_year / end_year   — restrict transaction downloads to this year range

    Horizontal scope:
        No flags                — download everything
        transactions            — contributions + expenditures only
        entities                — committees only
        contributions           — contributions only
        expenditures            — expenditures only
        candidates / committees — treated as entities (single committee file)

    grid=True: transactions come from the PublicGrid export by transaction-date
    year (grid_*_{year}.csv, with TransactionIDs) instead of the bulk files —
    see the module docstring. A failed grid window raises (exit 1).

    Note: committees are always re-downloaded regardless of manifest — they
    update continuously as new committees register throughout the cycle.
    Year flags do not apply to committees (single all-committee request).
    """
    log = get_logger("maryland", "scrape")
    t0  = time.perf_counter()
    log._emit("scrape_started", force=force, entities=entities, transactions=transactions,
              start_year=start_year, end_year=end_year,
              contributions=contributions, expenditures=expenditures,
              candidates=candidates, committees=committees, grid=grid)

    # ── Resolve granular scope ────────────────────────────────────────
    no_horizontal = not (entities or transactions or contributions or
                         expenditures or candidates or committees)

    do_transactions  = no_horizontal or transactions or contributions or expenditures
    do_entities      = no_horizontal or entities or candidates or committees

    # Transaction type filter
    if contributions and not expenditures:
        active_tx_types = {"TCON": "contributions"}
    elif expenditures and not contributions:
        active_tx_types = {"TEXP": "expenditures"}
    else:
        active_tx_types = TRANSACTION_TYPES

    # Year range — from start_year (or START_YEAR floor) to current year
    current_year     = datetime.today().year
    range_start      = start_year if start_year is not None else START_YEAR
    years            = [
        str(y) for y in range(range_start, current_year + 1)
        if (end_year is None or y <= end_year)
    ]
    current_year_str = str(current_year)

    files_ok = files_err = 0

    try:
        session = _make_session()

        # ── Committees ────────────────────────────────────────────────
        # Always re-download — no manifest check. Committees register year-round
        # and a stale file quickly becomes out of date.
        if do_entities:
            result = download_committees(log, session)
            if result:
                filename, row_count = result
                # Upsert manifest entry for committees
                strip_manifest(lambda r: r["transaction_type"] != "TCMD")
                append_manifest({
                    "transaction_type": "TCMD",
                    "year":             "0",
                    "filename":         filename,
                    "downloaded_at":    datetime.today().strftime("%Y-%m-%d"),
                    "row_count":        row_count,
                })
                log.info(f"  committees: {row_count:,} rows")
                files_ok += 1
            else:
                files_err += 1

        # ── Transactions ──────────────────────────────────────────────
        if do_transactions:
            # Grid downloads keep their own manifest rows (TCON_GRID / TEXP_GRID):
            # their years are transaction-date years, not filing years.
            suffix = "_GRID" if grid else ""
            if force:
                strip_manifest(lambda r: r["transaction_type"] in
                               {code + suffix for code in active_tx_types})
                done = set()
            else:
                done = load_manifest()

            year_range_explicit = start_year is not None or end_year is not None
            for transaction_type, label in active_tx_types.items():
                for year in years:
                    key = (transaction_type + suffix, year)
                    if key in done and year != current_year_str and not year_range_explicit:
                        log.file_download_skip(
                            filename=f"{'grid_' if grid else ''}{label}_{year}.csv")
                        continue

                    if grid:
                        result = download_grid_year(log, transaction_type, year, session)
                    else:
                        result = download_transaction(log, transaction_type, year, session)
                    if result is None:
                        files_err += 1
                        continue

                    filename, row_count = result
                    append_manifest({
                        "transaction_type": transaction_type + suffix,
                        "year":             year,
                        "filename":         filename,
                        "downloaded_at":    datetime.today().strftime("%Y-%m-%d"),
                        "row_count":        row_count,
                    })
                    done.add(key)
                    files_ok += 1
                    time.sleep(0.5)

        duration = round(time.perf_counter() - t0, 1)
        log.info(f"Done in {duration}s — {files_ok} ok, {files_err} errors")
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
        description="Download Maryland campaign finance data from the SBE bulk export API."
    )

    vert = ap.add_mutually_exclusive_group()
    vert.add_argument("--force",      action="store_true",
                      help="re-download all years in scope, wipe manifest")
    vert.add_argument("--start-year", type=int, metavar="YYYY",
                      help="earliest year to download (inclusive)")

    ap.add_argument("--end-year",     type=int, metavar="YYYY",
                    help="latest year to download (inclusive, ≤ current year)")

    ap.add_argument("--transactions", action="store_true",
                    help="transactions only (contributions + expenditures)")
    ap.add_argument("--entities",     action="store_true",
                    help="entities only (committees)")
    ap.add_argument("--contributions", action="store_true",
                    help="contributions only")
    ap.add_argument("--expenditures",  action="store_true",
                    help="expenditures only")
    ap.add_argument("--candidates",    action="store_true",
                    help="committees only (alias; MD has no separate candidate file)")
    ap.add_argument("--committees",    action="store_true",
                    help="committees only")
    ap.add_argument("--grid",          action="store_true",
                    help="transactions from the PublicGrid export (with transaction "
                         "ids) by transaction-date year, instead of the bulk files")

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
            grid=args.grid,
        )
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
