"""
scrapers/colorado.py — Download Colorado TRACER campaign finance data.

Three components, one file:

  1. Transactions — bulk ZIP downloads from the BulkDataDownloads endpoint.
       Years 2000–present × {contributions, expenditures, loans}.
       Tracked in manifest.csv; current-year files always re-fetched.

  2. Candidates — SeqID sweep across CandidateDetail.aspx.
       Iterates SeqID 1 → max (auto-detected via binary search), one row
       per candidate/election cycle.  Resumable via checkpoint file.

  3. Committees — OrgID sweep across CommitteeDetail.aspx.
       Same rolling-window pattern as candidates.  Resumable via checkpoint.

No authentication required.  Plain HTTP; no WAF issues observed.
"""

import csv
import io
import sys
import time
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from tqdm import tqdm
from tqdm.contrib.logging import logging_redirect_tqdm

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
from src.reporting.logger import get_logger

# =============================== paths ================================

RAW_DIR               = PROJECT_ROOT / "data" / "Colorado" / "raw"
MANIFEST_TX           = PROJECT_ROOT / "data" / "Colorado" / "manifest.csv"
ENTITIES_OUT          = RAW_DIR / "candidates_all.csv"
ENTITIES_CHECKPOINT   = RAW_DIR / "candidates_all.checkpoint"
COMMITTEES_OUT        = RAW_DIR / "committees.csv"
COMMITTEES_CHECKPOINT = RAW_DIR / "committees.checkpoint"

RAW_DIR.mkdir(parents=True, exist_ok=True)

# ========================= shared config ==============================

CURRENT_YEAR = datetime.today().year
SLEEP_SEC    = 0.25

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/147.0.0.0 Safari/537.36"
    ),
}

# ═══════════════════════════════════════════════════════════════════════════════
# PART 1 — TRANSACTIONS
# ═══════════════════════════════════════════════════════════════════════════════

TX_BASE_URL      = "https://Tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads"
TX_START_YEAR    = 2000
TX_YEARS         = list(range(TX_START_YEAR, CURRENT_YEAR + 1))
TX_MANIFEST_COLS = ["year", "data_type", "filename", "downloaded_at", "row_count"]

DATA_TYPES = [
    ("Contribution", "contributions"),
    ("Expenditure",  "expenditures"),
    ("Loan",         "loans"),
]


# ── Transaction manifest helpers ──────────────────────────────────────────────

def _tx_load_manifest() -> set[tuple[str, str]]:
    if not MANIFEST_TX.exists():
        return set()
    with open(MANIFEST_TX, newline="") as f:
        return {(r["year"], r["data_type"]) for r in csv.DictReader(f)}


def _tx_strip_manifest(keep_fn):
    if not MANIFEST_TX.exists():
        return
    with open(MANIFEST_TX, newline="") as f:
        rows = list(csv.DictReader(f))
    with open(MANIFEST_TX, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=TX_MANIFEST_COLS)
        w.writeheader()
        w.writerows(r for r in rows if keep_fn(r))


def _tx_append_manifest(record: dict):
    write_header = not MANIFEST_TX.exists()
    with open(MANIFEST_TX, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=TX_MANIFEST_COLS)
        if write_header:
            w.writeheader()
        w.writerow(record)


# ── Transaction download ───────────────────────────────────────────────────────

def _tx_download(year: int, url_label: str, file_label: str,
                 session: requests.Session) -> tuple[str, int] | None:
    """
    Fetch one year/type ZIP, decode the inner CSV, write to RAW_DIR.
    Returns (filename, row_count) on success, None on any failure.
    """
    zip_url  = f"{TX_BASE_URL}/{year}_{url_label}Data.csv.zip"
    filename = f"{file_label}_{year}.csv"
    out_path = RAW_DIR / filename

    try:
        resp = session.get(zip_url, timeout=120, stream=True)
        resp.raise_for_status()
    except requests.RequestException as e:
        return None, str(e)

    try:
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            raw_csv = zf.read(zf.namelist()[0])
    except (zipfile.BadZipFile, IndexError) as e:
        return None, f"zip error: {e}"

    # Handle BOM / encoding variants produced by .NET exports
    if raw_csv[:3] == b"\xef\xbb\xbf":
        text = raw_csv[3:].decode("utf-8", errors="replace")
    elif raw_csv[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw_csv.decode("utf-16")
    elif len(raw_csv) > 1 and raw_csv[1] == 0:
        text = raw_csv.decode("utf-16-le", errors="replace")
    else:
        text = raw_csv.decode("utf-8", errors="replace")

    out_path.write_text(text, encoding="utf-8")
    row_count = max(text.count("\n") - 1, 0)
    return (filename, row_count), None


# ── Transaction runner ────────────────────────────────────────────────────────

def run_transactions(log, force: bool = False,
                     start_year: int | None = None, end_year: int | None = None,
                     contributions: bool = False, expenditures: bool = False) -> tuple[int, int]:
    """Download transaction ZIPs for all years × types.  Returns (ok, err)."""
    current_year_str    = str(CURRENT_YEAR)
    year_range_explicit = start_year is not None or end_year is not None

    years = [y for y in TX_YEARS
             if (start_year is None or y >= start_year)
             and (end_year   is None or y <= end_year)]

    if contributions and not expenditures:
        active_types = [(u, f) for u, f in DATA_TYPES if f == "contributions"]
    elif expenditures and not contributions:
        active_types = [(u, f) for u, f in DATA_TYPES if f == "expenditures"]
    else:
        active_types = DATA_TYPES

    if force:
        if MANIFEST_TX.exists():
            MANIFEST_TX.unlink()
        done = set()
    else:
        done = _tx_load_manifest()

    session = requests.Session()
    session.headers.update({**HEADERS,
                             "Referer": "https://Tracer.sos.colorado.gov/PublicSite/"})

    ok = err = 0
    for year in years:
        for url_label, file_label in active_types:
            key      = (str(year), file_label)
            filename = f"{file_label}_{year}.csv"

            # Re-download if: current year, year range explicitly requested, or not yet done.
            if key in done and str(year) != current_year_str and not year_range_explicit:
                log.file_download_skip(filename=filename)
                continue

            t_file = time.perf_counter()
            log.file_download_start(filename=filename)
            result, error = _tx_download(year, url_label, file_label, session)

            if result is None:
                log.file_download_error(filename=filename, error=error)
                err += 1
                continue

            dl_filename, row_count = result
            log.file_download_ok(
                filename=dl_filename,
                bytes=(RAW_DIR / dl_filename).stat().st_size,
                rows=row_count,
                duration_s=round(time.perf_counter() - t_file, 2),
            )
            _tx_append_manifest({
                "year":          str(year),
                "data_type":     file_label,
                "filename":      dl_filename,
                "downloaded_at": datetime.today().strftime("%Y-%m-%d"),
                "row_count":     row_count,
            })
            done.add(key)
            ok += 1
            time.sleep(0.3)

    return ok, err


# ═══════════════════════════════════════════════════════════════════════════════
# PART 2 — ENTITIES (SeqID sweep)
# ═══════════════════════════════════════════════════════════════════════════════

ENTITY_URL       = "https://tracer.sos.colorado.gov/PublicSite/SearchPages/CandidateDetail.aspx"
KNOWN_MAX_SEQ_ID = 67819   # last verified ceiling; binary search extends from here

ENTITY_COLS = [
    "seq_id", "name", "candidate_id",
    "address1", "address2", "city_state_zip",
    "phone", "email", "web",
    "election_cycle", "election_year",
    "party", "jurisdiction", "office", "district",
    "cycle_status", "current_status",
    "term_date", "date_affidavit_filed", "voluntary_spending_limit",
    "scraped_at",
]


# ── Binary-search max-ID finder ───────────────────────────────────────────────

def _find_max_id(fetch_fn, known_max: int, step: int = 1000, label: str = "ID") -> int:
    """
    Return the highest consecutive valid ID at or above known_max.

    Steps upward by `step` until the first gap, then binary-searches
    [last_valid, first_invalid] for the exact edge.  If known_max itself is
    already past the end, searches downward instead.

    fetch_fn(id) must return truthy for a valid page, falsy for a gap/404.
    """
    if not fetch_fn(known_max):
        # known_max is stale — binary-search downward
        lo, hi = max(1, known_max // 2), known_max
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if fetch_fn(mid):
                lo = mid
            else:
                hi = mid - 1
        return lo

    lo = known_max
    hi = known_max + step
    while fetch_fn(hi):
        lo = hi
        hi += step

    while lo < hi - 1:
        mid = (lo + hi) // 2
        if fetch_fn(mid):
            lo = mid
        else:
            hi = mid

    return lo


# ── Page helpers ──────────────────────────────────────────────────────────────

def _txt(soup, id_: str) -> str:
    tag = soup.find(id=id_)
    return tag.text.strip() if tag else ""


def _parse_candidate_page(seq_id: int, html: str) -> list[dict] | None:
    """
    Parse CandidateDetail.aspx HTML for one SeqID.
    Returns a list of dicts (one per election cycle), or None for a gap page.
    """
    soup = BeautifulSoup(html, "html.parser")
    name = _txt(soup, "_ctl0_Content_lblCandName")
    if not name:
        return None

    base = {
        "seq_id":                   seq_id,
        "name":                     name,
        "candidate_id":             _txt(soup, "_ctl0_Content_lblCandidateID"),
        "address1":                 _txt(soup, "_ctl0_Content_lblCandMailAddress1"),
        "address2":                 _txt(soup, "_ctl0_Content_lblCandMailAddress2"),
        "city_state_zip":           _txt(soup, "_ctl0_Content_lblCandMailCityStateZip"),
        "phone":                    _txt(soup, "_ctl0_Content_lblCandPhone"),
        "email":                    _txt(soup, "_ctl0_Content_lnkCandEmail"),
        "web":                      _txt(soup, "_ctl0_Content_lnkCandWeb"),
        "current_status":           _txt(soup, "_ctl0_Content_lblCandStatus"),
        "term_date":                _txt(soup, "_ctl0_Content_lblCandTermDate"),
        "date_affidavit_filed":     _txt(soup, "_ctl0_Content_lblCandDateDeclared"),
        "voluntary_spending_limit": _txt(soup, "_ctl0_Content_lblCandVolSpendLimit"),
        "scraped_at":               datetime.today().strftime("%Y-%m-%d"),
    }

    rows = []
    campaigns_table = soup.find("table", {"id": "_ctl0_Content_dgdCampaigns"})
    if campaigns_table:
        for tr in campaigns_table.find_all("tr")[1:]:
            cells = [td.text.strip() for td in tr.find_all("td")]
            if len(cells) < 7:
                continue
            cycle = cells[1]
            rows.append({
                **base,
                "election_cycle": cycle,
                "election_year":  cycle.split()[0] if cycle else "",
                "party":          cells[2],
                "jurisdiction":   cells[3],
                "office":         cells[4],
                "district":       cells[5],
                "cycle_status":   cells[6],
            })

    if not rows:
        header = _txt(soup, "_ctl0_Content_lblPageHeader")
        rows.append({
            **base,
            "election_cycle": "",
            "election_year":  (header.split("Election Year")[-1].strip()
                               if "Election Year" in header else ""),
            "party":          _txt(soup, "_ctl0_Content_lblCandParty"),
            "jurisdiction":   _txt(soup, "_ctl0_Content_lblCandJurisdiction"),
            "office":         _txt(soup, "_ctl0_Content_lblCandOffice"),
            "district":       _txt(soup, "_ctl0_Content_lblCandDistrict"),
            "cycle_status":   _txt(soup, "_ctl0_Content_lblCampaignStatus"),
        })

    return rows


# ── Thread-local sessions ─────────────────────────────────────────────────────

_thread_local = threading.local()


def _get_session() -> requests.Session:
    if not hasattr(_thread_local, "session"):
        _thread_local.session = requests.Session()
        _thread_local.session.headers.update(HEADERS)
    return _thread_local.session


def _fetch_seq(seq_id: int) -> list[dict] | None:
    session = _get_session()
    try:
        r = session.get(ENTITY_URL, params={"SeqID": seq_id}, timeout=30)
        r.raise_for_status()
    except requests.RequestException:
        return None
    time.sleep(SLEEP_SEC)
    return _parse_candidate_page(seq_id, r.text)


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def _load_checkpoint(path: Path) -> int:
    if path.exists():
        try:
            return int(path.read_text().strip())
        except ValueError:
            pass
    return 0


def _save_checkpoint(path: Path, val: int):
    path.write_text(str(val))


# ── Entity writer (thread-safe) ───────────────────────────────────────────────

_write_lock = threading.Lock()


def _write_entity_rows(rows: list[dict]):
    if not rows:
        return
    write_header = not ENTITIES_OUT.exists()
    with _write_lock:
        with open(ENTITIES_OUT, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=ENTITY_COLS)
            if write_header:
                w.writeheader()
            w.writerows(rows)


# ── Entity runner ─────────────────────────────────────────────────────────────

def run_entities(log, force: bool = False, start_seq: int = 0,
                 max_seq: int | None = None, workers: int = 8) -> tuple[int, int]:
    """
    Sweep CandidateDetail.aspx from SeqID 1 → max_seq (auto-detected).
    Resumable: starts from the checkpoint unless force=True.
    Returns (found, errors).
    """
    if force:
        for f in [ENTITIES_OUT, ENTITIES_CHECKPOINT]:
            if f.exists():
                f.unlink()

    if max_seq is None:
        session = requests.Session()
        session.headers.update(HEADERS)

        def _probe_seq(sid):
            try:
                r = session.get(ENTITY_URL, params={"SeqID": sid}, timeout=10)
                r.raise_for_status()
                return bool(BeautifulSoup(r.text, "html.parser")
                            .find(id="_ctl0_Content_lblCandName"))
            except Exception:
                return False

        log.info(f"  Auto-detecting max SeqID (anchor={KNOWN_MAX_SEQ_ID:,}) …")
        max_seq = _find_max_id(_probe_seq, KNOWN_MAX_SEQ_ID, step=5000, label="SeqID")
        log.info(f"  Max SeqID: {max_seq:,}")

    checkpoint  = max(_load_checkpoint(ENTITIES_CHECKPOINT), start_seq)
    start_from  = checkpoint + 1

    if start_from > max_seq:
        log.info(f"Candidates: already complete (checkpoint={checkpoint:,}).")
        return 0, 0

    total = max_seq - start_from + 1
    found = err = 0
    CHUNK = 200
    BATCH = 50
    t0 = time.perf_counter()

    log.info(f"Candidates: SeqID {start_from:,} → {max_seq:,} "
             f"({total:,} IDs, {workers} workers)")

    completed = 0
    buffer: list[dict] = []
    seq_iter = iter(range(start_from, max_seq + 1))

    with logging_redirect_tqdm(loggers=[log._log]):
        bar = tqdm(total=total, desc="  candidates", unit="id",
                   dynamic_ncols=True)
        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                pending = {}
                for sid in seq_iter:
                    pending[pool.submit(_fetch_seq, sid)] = sid
                    if len(pending) >= CHUNK:
                        break

                while pending:
                    for future in as_completed(pending):
                        sid    = pending.pop(future)
                        result = future.result()
                        completed += 1
                        bar.update(1)

                        if result:
                            buffer.extend(result)
                            found += 1
                            bar.set_postfix_str(
                                (result[0].get("name") or "")[:40], refresh=False)
                        else:
                            err += 1

                        for next_sid in seq_iter:
                            pending[pool.submit(_fetch_seq, next_sid)] = next_sid
                            break

                        if completed % BATCH == 0:
                            _write_entity_rows(buffer)
                            buffer.clear()
                            _save_checkpoint(ENTITIES_CHECKPOINT, sid)

                        break  # rolling window: one future at a time

        finally:
            bar.close()

    _write_entity_rows(buffer)
    _save_checkpoint(ENTITIES_CHECKPOINT, max_seq)
    log.page_scrape_complete(
        filename=str(ENTITIES_OUT),
        rows=found,
        duration_s=round(time.perf_counter() - t0, 1),
        ok=found,
        err=err,
    )
    return found, err


# ═══════════════════════════════════════════════════════════════════════════════
# PART 3 — COMMITTEES (OrgID sweep)
# ═══════════════════════════════════════════════════════════════════════════════

COMM_DETAIL_URL      = "https://tracer.sos.colorado.gov/PublicSite/SearchPages/CommitteeDetail.aspx"
KNOWN_COMM_MAX_ORG_ID = 53_000   # last verified ceiling

COMMITTEE_COLS = [
    "org_id", "committee_id", "committee_name", "committee_type",
    "status", "date_registered", "date_terminated",
    "jurisdiction", "phone", "purpose",
    "registered_agent", "agent_phone", "agent_email",
    "address1", "city_state_zip",
    "mail_address1", "mail_city_state_zip",
    "dfa", "dfa_phone", "web",
    "scraped_at",
]

_comm_write_lock = threading.Lock()


def _scrape_committee_detail(org_id: int, session: requests.Session) -> dict | None:
    """
    Fetch CommitteeDetail.aspx?OrgID=<org_id>.
    Returns a flat dict, or None if the org_id is unused.
    """
    try:
        r = session.get(COMM_DETAIL_URL, params={"OrgID": org_id}, timeout=30)
        r.raise_for_status()
    except requests.RequestException:
        return None

    soup = BeautifulSoup(r.text, "html.parser")

    def t(id_): return _txt(soup, id_)

    name = t("_ctl0_Content_lblCommName")
    if not name:
        return None

    return {
        "org_id":               org_id,
        "committee_id":         t("_ctl0_Content_lblCommitteeID"),
        "committee_name":       name,
        "committee_type":       t("_ctl0_Content_lblCommitteeType"),
        "status":               t("_ctl0_Content_lblCommStatus"),
        "date_registered":      t("_ctl0_Content_lblCommDateOrganized"),
        "date_terminated":      t("_ctl0_Content_lblCommDateTerminated"),
        "jurisdiction":         t("_ctl0_Content_lblJurisdiction"),
        "phone":                t("_ctl0_Content_lblCommPhone"),
        "purpose":              t("_ctl0_Content_lblCommPurpose"),
        "registered_agent":     t("_ctl0_Content_lblRegisteredAgent"),
        "agent_phone":          t("_ctl0_Content_lblAgentPhone"),
        "agent_email":          t("_ctl0_Content_lnkAgentEmail"),
        "address1":             t("_ctl0_Content_lblPhysAddress1"),
        "city_state_zip":       t("_ctl0_Content_lblPhysCityStateZip"),
        "mail_address1":        t("_ctl0_Content_lblMailAddress1"),
        "mail_city_state_zip":  t("_ctl0_Content_lblMailCityStateZip"),
        "dfa":                  t("_ctl0_Content_lblDFA"),
        "dfa_phone":            t("_ctl0_Content_lblDFAPhone"),
        "web":                  t("_ctl0_Content_lnkCommWebAddress"),
        "scraped_at":           datetime.today().strftime("%Y-%m-%d"),
    }


def _fetch_org(org_id: int) -> dict | None:
    session = _get_session()
    result  = _scrape_committee_detail(org_id, session)
    time.sleep(SLEEP_SEC)
    return result


def _write_committee_rows(rows: list[dict]):
    if not rows:
        return
    write_header = not COMMITTEES_OUT.exists()
    with _comm_write_lock:
        with open(COMMITTEES_OUT, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COMMITTEE_COLS, extrasaction="ignore")
            if write_header:
                w.writeheader()
            w.writerows(rows)


def run_committees(log, force: bool = False, start_org: int = 0,
                   max_org: int | None = None, workers: int = 8) -> tuple[int, int]:
    """
    Sweep CommitteeDetail.aspx from OrgID 1 → max_org (auto-detected).
    Resumable via COMMITTEES_CHECKPOINT.  Returns (found, errors).
    """
    if force:
        for f in [COMMITTEES_OUT, COMMITTEES_CHECKPOINT]:
            if f.exists():
                f.unlink()

    if max_org is None:
        session = requests.Session()
        session.headers.update(HEADERS)

        def _probe_org(oid):
            try:
                r = session.get(COMM_DETAIL_URL, params={"OrgID": oid}, timeout=10)
                r.raise_for_status()
                soup = BeautifulSoup(r.text, "html.parser")
                # Require both name AND committee_id — the site returns pages with
                # lblCommName populated for invalid OrgIDs (person names bleed through),
                # but lblCommitteeID is empty on those spurious pages.
                name  = soup.find(id="_ctl0_Content_lblCommName")
                comm_id = soup.find(id="_ctl0_Content_lblCommitteeID")
                return bool(name and name.text.strip()
                            and comm_id and comm_id.text.strip())
            except Exception:
                return False

        log.info(f"  Auto-detecting max OrgID (anchor={KNOWN_COMM_MAX_ORG_ID:,}) …")
        max_org = _find_max_id(_probe_org, KNOWN_COMM_MAX_ORG_ID, step=5000, label="OrgID")
        # Safety cap — if the site bleeds data at high IDs the search can overshoot badly
        if max_org > KNOWN_COMM_MAX_ORG_ID * 10:
            log.warn(f"  Detected max OrgID {max_org:,} looks implausible; "
                     f"capping at {KNOWN_COMM_MAX_ORG_ID:,}")
            max_org = KNOWN_COMM_MAX_ORG_ID
        log.info(f"  Max OrgID: {max_org:,}")

    checkpoint = max(_load_checkpoint(COMMITTEES_CHECKPOINT), start_org)
    start_from = checkpoint + 1

    if start_from > max_org:
        log.info(f"Committees: already complete (checkpoint={checkpoint:,}).")
        return 0, 0

    total = max_org - start_from + 1
    found = err = 0
    CHUNK = 200
    BATCH = 50
    t0 = time.perf_counter()

    log.info(f"Committees: OrgID {start_from:,} → {max_org:,} "
             f"({total:,} IDs, {workers} workers)")

    completed = 0
    buffer: list[dict] = []
    org_iter = iter(range(start_from, max_org + 1))

    with logging_redirect_tqdm(loggers=[log._log]):
        bar = tqdm(total=total, desc="  committees", unit="id",
                   dynamic_ncols=True)
        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                pending = {}
                for oid in org_iter:
                    pending[pool.submit(_fetch_org, oid)] = oid
                    if len(pending) >= CHUNK:
                        break

                while pending:
                    for future in as_completed(pending):
                        oid    = pending.pop(future)
                        result = future.result()
                        completed += 1
                        bar.update(1)

                        if result:
                            buffer.append(result)
                            found += 1
                            bar.set_postfix_str(
                                (result.get("committee_name") or "")[:40], refresh=False)
                        else:
                            err += 1

                        for next_oid in org_iter:
                            pending[pool.submit(_fetch_org, next_oid)] = next_oid
                            break

                        if completed % BATCH == 0:
                            _write_committee_rows(buffer)
                            buffer.clear()
                            _save_checkpoint(COMMITTEES_CHECKPOINT, oid)

                        break  # rolling window: one future at a time

        finally:
            bar.close()

    _write_committee_rows(buffer)
    _save_checkpoint(COMMITTEES_CHECKPOINT, max_org)
    log.page_scrape_complete(
        filename=str(COMMITTEES_OUT),
        rows=found,
        duration_s=round(time.perf_counter() - t0, 1),
        ok=found,
        err=err,
    )
    return found, err


# ═══════════════════════════════════════════════════════════════════════════════
# TOP-LEVEL RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

def run(force: bool = False, entities: bool = False, transactions: bool = False,
        start_year: int | None = None, end_year: int | None = None,
        contributions: bool = False, expenditures: bool = False,
        candidates: bool = False, committees: bool = False,
        workers: int = 8,
        start_seq: int = 0, max_seq: int | None = None,
        start_org: int = 0, max_org: int | None = None):
    """
    Entry point used by orc.py.

    entities=True     — run both candidates (SeqID sweep) and committees (OrgID sweep)
    transactions=True — run bulk ZIP downloads for contributions/expenditures/loans
    (neither flag)    — run everything
    """
    log = get_logger("colorado", "scrape")
    t0  = time.perf_counter()
    log._emit("scrape_started", force=force, entities=entities, transactions=transactions,
              start_year=start_year, end_year=end_year,
              contributions=contributions, expenditures=expenditures)

    transactions_implied = contributions or expenditures
    entities_implied     = candidates or committees
    do_both         = not (entities or transactions or transactions_implied or entities_implied)
    do_transactions = transactions or transactions_implied or do_both
    do_entities     = entities or entities_implied or do_both

    files_ok = files_err = 0
    pages_ok = pages_err = 0

    try:
        if do_transactions:
            files_ok, files_err = run_transactions(
                log, force=force,
                start_year=start_year, end_year=end_year,
                contributions=contributions, expenditures=expenditures,
            )

        if do_entities:
            c_ok,  c_err  = run_entities(log, force=force,
                                          start_seq=start_seq, max_seq=max_seq,
                                          workers=workers)
            m_ok,  m_err  = run_committees(log, force=force,
                                            start_org=start_org, max_org=max_org,
                                            workers=workers)
            pages_ok  = c_ok  + m_ok
            pages_err = c_err + m_err

        duration = round(time.perf_counter() - t0, 1)
        log._emit("scrape_completed", status="completed", duration_s=duration,
                  files_ok=files_ok, files_err=files_err,
                  pages_ok=pages_ok, pages_err=pages_err)

    except KeyboardInterrupt:
        log._emit("scrape_completed", status="interrupted",
                  duration_s=round(time.perf_counter() - t0, 1),
                  files_ok=files_ok, files_err=files_err,
                  pages_ok=pages_ok, pages_err=pages_err)
        raise

    except Exception as e:
        log._emit("scrape_completed", status="error",
                  duration_s=round(time.perf_counter() - t0, 1),
                  files_ok=files_ok, files_err=files_err,
                  pages_ok=pages_ok, pages_err=pages_err,
                  error_type=type(e).__name__, error=str(e))
        raise


# =============================== CLI ==================================

if __name__ == "__main__":
    import argparse
    ap   = argparse.ArgumentParser(description="Download Colorado TRACER campaign finance data.")
    vert = ap.add_mutually_exclusive_group()
    vert.add_argument("--force",        action="store_true",
                      help="re-download everything, ignoring manifest and checkpoints")
    vert.add_argument("--start-year",   type=int, metavar="YYYY",
                      help="earliest year to download (inclusive)")
    ap.add_argument("--end-year",       type=int, metavar="YYYY",
                    help="latest year to download (inclusive, ≤ current year)")
    ap.add_argument("--transactions",   action="store_true",
                    help="transactions only")
    ap.add_argument("--entities",       action="store_true",
                    help="entities only (candidates + committees)")
    ap.add_argument("--contributions",  action="store_true",
                    help="contributions only")
    ap.add_argument("--expenditures",   action="store_true",
                    help="expenditures only")
    ap.add_argument("--candidates",     action="store_true",
                    help="candidates only")
    ap.add_argument("--committees",     action="store_true",
                    help="committees only")
    # Internal resume flags — for manual recovery after a partial entity sweep
    ap.add_argument("--start",          type=int, default=0,
                    help="candidate sweep: resume from this SeqID")
    ap.add_argument("--max",            type=int, default=None,
                    help="candidate sweep: max SeqID (default: auto-detect)")
    ap.add_argument("--start-org",      type=int, default=0,
                    help="committee sweep: resume from this OrgID")
    ap.add_argument("--max-org",        type=int, default=None,
                    help="committee sweep: max OrgID (default: auto-detect)")
    ap.add_argument("--workers",        type=int, default=8,
                    help="parallel workers for entity sweeps (default 8)")
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
            workers=args.workers,
            start_seq=args.start,
            max_seq=args.max,
            start_org=args.start_org,
            max_org=args.max_org,
        )
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
