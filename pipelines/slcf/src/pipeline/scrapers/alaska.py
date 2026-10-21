"""
scrapers/alaska.py — Download Alaska APOC campaign finance data.

Requires a live browser session via Playwright — Alaska's WAF blocks datacenter
IPs, so this must be run from a local machine. Exports are triggered by clicking
Search then Export, mirroring normal user interaction.

aws.state.ak.us is also fronted by DataDome (captcha-delivery.com) — confirmed
live 2026-09-23 by firing a burst of export requests and getting back a real
"Slide right to secure your access" interstitial, which explicitly names
"Rapid taps or clicks" / "Automated (bot) activity" as trigger reasons. This
matches the scraper's own back-to-back year-download pattern. The slider
requires a genuine human drag gesture — it cannot be solved by script. Runs
headless=False for exactly this reason (a headless browser is itself a bot
signal DataDome checks for) and uses a persistent Playwright profile
(under PROFILE_ROOT) so a human-solved challenge's trust cookie survives across runs
instead of being thrown away every time — same fix already proven for
Missouri's Incapsula CAPTCHA elsewhere in this repo. See
_wait_out_datadome() below and docs/states/alaska.md.

--grid (transactions only): no browser. Income and expenditures come over
plain HTTP from the same CDIncome / CDExpenditures search grids -- the fetch
state-politics-tracker's old pilot importer ran nightly from GitHub's runners,
which have neither a display for the headful Chromium above nor a human for
DataDome's slider. Per report year, statewide, in a fresh cookie session:
GET the page, POST Search (the filter is stored server-side), POST Export,
then page through the visible-page CSV link the export dialog returns
(GRID_PAGE_SIZE rows a request -- a whole-year export-all request gets its
connection dropped). Status "Complete, Not Amended" (the page's default and the
pilot's): only the current version of each report, where the browser path
takes "All Complete Forms". Connections are reset routinely (F5/DataDome):
every request retries with backoff, and a year is kept only if its row count
equals the "N items" the search reported. Output:
grid_CDIncome_<year>.csv / grid_CDExpense_<year>.csv, which the parser reads in
place of the bulk files. A failed year raises (exit 1), so nothing partial is
parsed.

The browser is the locally installed Google Chrome by default, not
Playwright's bundled Chromium, because DataDome blocks the bundled build on
the first request while the same network passes in an ordinary Chrome. When
Chrome is not installed, the scraper falls back to the bundled Chromium.
Set AK_BROWSER_CHANNEL to chrome, msedge or chromium to choose explicitly.
"""

import csv
import io
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path


# Make project root and src/pipeline importable before importing local modules
PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
from src.reporting.logger import get_logger

# =============================== paths ================================
RAW_DIR      = PROJECT_ROOT / "data" / "Alaska" / "raw"
MANIFEST     = PROJECT_ROOT / "data" / "Alaska" / "manifest.csv"

# Persistent Playwright profiles live under PROFILE_ROOT, one per browser
# channel (alaska-chrome, alaska-chromium, ...), since Chrome and Chromium
# profiles are not interchangeable. Not under data/Alaska/raw, because
# parsers glob that tree for CSV exports. These profiles are separate from
# the user's everyday browser profile. See _launch_context() and the
# launch note in run() for why they persist between runs.
PROFILE_ROOT = PROJECT_ROOT / ".playwright-profiles"

# Browser channel to launch: "chrome" (installed Google Chrome), "msedge"
# (installed Microsoft Edge) or "chromium" (Playwright's bundled build).
BROWSER_CHANNEL = os.environ.get("AK_BROWSER_CHANNEL", "chrome").strip().lower() or "chrome"

RAW_DIR.mkdir(parents=True, exist_ok=True)

MANIFEST_COLS = ["relation_type", "year", "filename", "row_count"]



SOURCES = [
    {"name": "Alaska Public Offices Commission (APOC)",
     "url": "https://aws.state.ak.us/ApocReports/"},
]

# =============================== pages ================================

# Alaska requires a live browser session — Playwright handles this by clicking
# Search then Export just like a user would. Must be run from a local machine;
# datacenter IPs are blocked by Alaska's WAF.
PAGES = {
    "income":       "https://aws.state.ak.us/ApocReports/CampaignDisclosure/CDIncome.aspx",
    "expenditures": "https://aws.state.ak.us/ApocReports/CampaignDisclosure/CDExpenditures.aspx",
    "candidates":   "https://aws.state.ak.us/apocreports/Campaign/AllCandidates.aspx?type=all",
    "groups":       "https://aws.state.ak.us/apocreports/Registration/GroupRegistration/GRForms.aspx",
    # Bulk candidate-registration listing, the candidate analog of GRForms.
    # Goes through the same year-based download_year() path. The export
    # carries candidate name, committee, treasurer, city and zip.
    "cr_forms":     "https://aws.state.ak.us/apocreports/Registration/CandidateRegistration/CRForms.aspx",
    # Independent Expenditure (Form 15-6) bulk exports -- same
    # Select-Year/Status/Search/Export flow as income/expenditures/groups
    # above (confirmed live 2026-09-24: identical ddlReportYear/ddlStatus/
    # btnSearch/btnExport/hlAllCSV markup), NOT the per-ID Common/View.aspx
    # detail sweep an earlier version of this scraper used -- that page-by-
    # page approach was unnecessary since these bulk grids already export
    # every filing. Two separate pages/exports (not one, like GR/CR) because
    # IEExpenditures.aspx and IEContributions.aspx are two independent
    # bulk-export grids, each with its own CSV, even though a single IE
    # filing's detail page shows both sides.
    "ie_expenditures":  "https://aws.state.ak.us/apocreports/IndependentExpenditures/IEExpenditures.aspx",
    "ie_contributions": "https://aws.state.ak.us/apocreports/IndependentExpenditures/IEContributions.aspx",
}

TRANSACTION_RELATIONS = {"income", "expenditures", "ie_expenditures", "ie_contributions"}
ENTITY_RELATIONS      = {"candidates", "groups", "cr_forms"}

STEMS = {
    "income":       "CDIncome",
    "expenditures": "CDExpense",
    "candidates":   "CDCandidates",
    "groups":       "GRForms",
    "cr_forms":     "CRForms",
    "ie_expenditures":  "IEExpenditures",
    "ie_contributions": "IEContributions",
}

# ========================= anti-automation setup =========================
# Chromium under CDP control (which is how Playwright drives it) sets
# navigator.webdriver=true and a few other properties by default -- the
# single most common signal basic bot-detection scripts check for. None of
# this defeats a serious bot-mitigation vendor like DataDome on its own
# (see the DataDome section below for the real handling), but it's the
# standard first line of defense, costs nothing to include, and is already
# the proven pattern in this repo for Nevada's WAF -- ported here as-is,
# just with an Alaska-appropriate timezone.
LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"]

# No user agent override: the browser's real user agent has to match the
# version it reports in its Sec-CH-UA client hints and TLS fingerprint.
# A hardcoded user agent from an older Chrome contradicts both, and
# DataDome scores that mismatch as automation.
VIEWPORT = {"width": 1440, "height": 900}
LOCALE   = "en-US"
TIMEZONE_ID = "America/Anchorage"

STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
window.chrome = window.chrome || { runtime: {} };
const _origQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _origQuery(parameters)
);
"""

# ========================== Year range default ==========================
def default_start_year(today: datetime | None = None) -> int:
    """First year of the current two-year election cycle: the odd year
    before an even (election) year. Large historical years take several
    minutes each to export and do not change, so routine runs refresh
    only the current cycle."""
    year = (today or datetime.today()).year
    return year - 1 if year % 2 == 0 else year


# ========================== Manifest helpers ==========================
def load_manifest() -> tuple[set[tuple[str, str]], set[str]]:
    """Return (done, has_data) sets from the manifest; empty sets if it doesn't exist."""
    done: set[tuple[str, str]] = set()
    has_data: set[str] = set()
    if not MANIFEST.exists():
        return done, has_data
    with open(MANIFEST, newline="") as f:
        for row in csv.DictReader(f):
            done.add((row["relation_type"], row["year"]))
            has_data.add(row["relation_type"])
    return done, has_data


def strip_manifest(keep_fn: callable) -> None:
    """Rewrite the manifest keeping only rows where keep_fn(row) is True."""
    if not MANIFEST.exists():
        return
    with open(MANIFEST, newline="") as f:
        rows = list(csv.DictReader(f))
    with open(MANIFEST, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        writer.writeheader()
        writer.writerows(r for r in rows if keep_fn(r))


def upsert_manifest(record: dict) -> None:
    """Add or overwrite the manifest entry matching (relation_type, year)."""
    existing = []
    if MANIFEST.exists():
        with open(MANIFEST, newline="") as f:
            existing = [
                r for r in csv.DictReader(f)
                if not (r["relation_type"] == record["relation_type"]
                        and r["year"] == record["year"])
            ]
    with open(MANIFEST, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_COLS)
        writer.writeheader()
        writer.writerows(existing)
        writer.writerow(record)



# ================ Division of Elections candidate list ================
# APOC's exports carry no legislative district: Office is bare "House" or
# "Senate" in every file. The Alaska Division of Elections publishes each
# election's candidate list as HTML pages, with candidates grouped under
# "HOUSE DISTRICT 01" / "SENATE DISTRICT A" headings and party and
# incumbency in the name cell. The entities step saves those pages for the
# current election cycle's primary and general; parsers/alaska.py reads
# district, party and incumbency from them. One request per page, a few
# pages per election.
#
# The pages are loaded in the same browser as the APOC exports rather than
# with requests: Python's certificate check fails against this site
# ("unable to get local issuer certificate") while Chrome, which fetches a
# missing intermediate certificate itself, loads it. Verification stays on.
DOE_BASE       = "https://www.elections.alaska.gov/candidates/"
DOE_PAGE_PARAM = "frm-page-407"
DOE_MAX_PAGES  = 20
DOE_TIMEOUT_MS = 60_000


def doe_election_codes(election_year: int) -> list[str]:
    """The site's election codes for one election year: 2026 ->
    ['26prim', '26genr']."""
    yy = f"{election_year % 100:02d}"
    return [f"{yy}prim", f"{yy}genr"]


def doe_page_path(code: str, page_num: int) -> Path:
    return RAW_DIR / f"DOECandidates_{code}_p{page_num}.html"


def _doe_page_count(html: str) -> int:
    """Highest page number linked from a list page (1 when unpaginated),
    capped at DOE_MAX_PAGES."""
    nums = [int(n) for n in re.findall(rf"{DOE_PAGE_PARAM}=(\d+)", html)]
    return min(max(nums, default=1), DOE_MAX_PAGES)


def download_doe_candidates(page, election_year: int, log) -> tuple[int, int]:
    """Save every page of the Division of Elections candidate list for
    each of election_year's elections, loaded in the browser `page`.
    Returns (pages_ok, pages_err).

    The page count comes from the pagination links on page 1. An
    election's saved pages are replaced only after all of its pages were
    fetched, so a failed run leaves the previous complete set in place."""
    pages_ok = pages_err = 0
    for code in doe_election_codes(election_year):
        url = f"{DOE_BASE}?election={code}"
        log.file_download_start(filename=f"Division of Elections candidate list {code}")
        pages: list[str] = []
        try:
            n = 1
            total = 1
            while n <= total:
                if n > 1:
                    time.sleep(random.uniform(1.0, 2.0))
                page_url = url if n == 1 else f"{url}&{DOE_PAGE_PARAM}={n}"
                t_page = time.perf_counter()
                resp = page.goto(page_url, timeout=DOE_TIMEOUT_MS, wait_until="domcontentloaded")
                if resp is None or not resp.ok:
                    raise RuntimeError(f"HTTP {resp.status if resp else 'no response'} for {page_url}")
                html = page.content()
                if n == 1:
                    total = _doe_page_count(html)
                pages.append(html)
                log.page_scrape_ok(entity="doe_candidates", page_id=f"{code} p{n}",
                                   duration_s=time.perf_counter() - t_page)
                n += 1
        except Exception as e:
            log.page_scrape_error(entity="doe_candidates", page_id=f"{code} p{len(pages) + 1}",
                                  error=str(e))
            pages_err += 1
            continue

        for old in RAW_DIR.glob(f"DOECandidates_{code}_p*.html"):
            old.unlink()
        size = 0
        for num, html in enumerate(pages, start=1):
            path = doe_page_path(code, num)
            path.write_text(html, encoding="utf-8")
            size += path.stat().st_size
        pages_ok += len(pages)
        log.info(f"  ✓ Division of Elections candidate list {code}: "
                 f"{len(pages)} page(s), {size / 1024:.1f} KB")
    return pages_ok, pages_err


# ========================= Playwright helpers =========================
def get_available_years(page) -> list[str]:
    sel = page.locator("select[name*='ddlReportYear']")
    if not sel.count():
        return []
    options = sel.locator("option").all()
    years = [
        opt.get_attribute("value")
        for opt in options
        if opt.get_attribute("value") not in ("-1", "0", "", None)
    ]
    return sorted(set(years))


def _launch_context(p, log):
    """Launch a persistent, visible browser context on BROWSER_CHANNEL.

    Falls back to Playwright's bundled Chromium when the requested
    installed browser cannot be launched (for example, Chrome is not
    installed). Each channel gets its own profile directory."""
    channels = [BROWSER_CHANNEL]
    if BROWSER_CHANNEL != "chromium":
        channels.append("chromium")
    last_err = None
    for channel in channels:
        profile_dir = PROFILE_ROOT / f"alaska-{channel}"
        profile_dir.mkdir(parents=True, exist_ok=True)
        kwargs = dict(
            headless=False, accept_downloads=False, args=LAUNCH_ARGS,
            viewport=VIEWPORT, locale=LOCALE, timezone_id=TIMEZONE_ID,
        )
        if channel != "chromium":
            kwargs["channel"] = channel
        try:
            context = p.chromium.launch_persistent_context(str(profile_dir), **kwargs)
        except Exception as e:
            last_err = e
            log.warning(f"  [!] Could not launch browser channel '{channel}': "
                        f"{str(e).splitlines()[0]}")
            continue
        log.info(f"  Browser: {channel} (profile {profile_dir.name})")
        return context
    raise last_err


# ========================= DataDome bot-check =========================
# See module docstring for how this was confirmed. Detection is by content
# signature (the delivery domain + the challenge's own copy) rather than a
# specific DOM selector, since that's stable even if DataDome's widget
# markup changes. Used as a logging/pause signal only -- the actual "did we
# get real content" check downstream (dropdown present, csv_link present,
# etc.) is the real source of truth, same structural-fallback approach
# already used for Missouri's WAF handling in this repo.
DATADOME_MARKERS = [
    "captcha-delivery.com",
    "slide right to secure your access",
    "verification required",
    "access is temporarily restricted",
    "we detected unusual activity from your device or network",
]

# The hard-block variant above has no widget to solve -- it's a cooldown,
# not a challenge -- so the "solve it by hand" prompt in _wait_out_datadome
# would be actively misleading for it. Checked separately so the log
# message matches what's actually on screen.
DATADOME_HARD_BLOCK_MARKERS = [
    "access is temporarily restricted",
]

DOWNLOAD_TIMEOUT_MS     = 600_000  # ms; confirmed clean downloads for the
                                    # largest years take up to ~440s server-
                                    # side alone, well past the old 180s cap
DATADOME_WAIT_TIMEOUT_S = 900      # how long to wait for a human to solve it
DATADOME_POLL_S         = 3
DATADOME_MAX_CONSECUTIVE_BLOCKS = 6  # abort the run rather than hammer a live block


def _content_has_datadome(content: str) -> bool:
    lowered = content.lower()
    return any(marker in lowered for marker in DATADOME_MARKERS)


def _looks_like_datadome(page) -> bool:
    try:
        content = page.content()
    except Exception:
        return False
    return _content_has_datadome(content)


def _wait_out_datadome(page, log, where: str) -> bool | None:
    """If DataDome is showing (either the interactive slider challenge or
    the no-widget "Access is temporarily restricted" cooldown variant), log
    an accurate message and poll until it clears or we give up after
    DATADOME_WAIT_TIMEOUT_S.

    Returns None if DataDome was never showing at all, True if it was
    showing and cleared before the timeout, False if it was still showing
    when we gave up -- callers should treat False as a signal to back off
    hard (stop retrying at normal cadence) rather than just another
    per-item failure, since hammering a live block only reinforces it."""
    try:
        content = page.content()
    except Exception:
        return None
    if not _content_has_datadome(content):
        return None

    hard_block = any(m in content.lower() for m in DATADOME_HARD_BLOCK_MARKERS)
    if hard_block:
        log.warning(
            f"[!] DataDome hard block ('Access is temporarily restricted') at "
            f"{where} -- no widget to solve, this is an IP-level cooldown that "
            f"only clears on its own (waiting up to {DATADOME_WAIT_TIMEOUT_S}s)"
        )
    else:
        log.warning(
            f"[!] DataDome challenge detected at {where} -- solve the slider "
            f"in the visible browser window (waiting up to {DATADOME_WAIT_TIMEOUT_S}s)"
        )

    waited = 0
    while waited < DATADOME_WAIT_TIMEOUT_S:
        time.sleep(DATADOME_POLL_S)
        waited += DATADOME_POLL_S
        if not _looks_like_datadome(page):
            log.info(f"  DataDome block at {where} cleared after {waited}s")
            return True
    log.warning(
        f"  DataDome block at {where} still showing after "
        f"{DATADOME_WAIT_TIMEOUT_S}s -- giving up on this attempt"
    )
    return False


FETCH_EXPORT_JS = """
async ([url, timeoutMs]) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: "include", signal: ctrl.signal });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}
"""


def _fetch_export(page, href: str, out_path: Path, page_url: str, log, where: str) -> int:
    """Fetch the CSV export from inside the page and write it to out_path.

    The request runs through the page's own fetch(), so it uses the same
    browser network stack and cookies as a click, but it does not go
    through the browser's download handling: installed Chrome crashes
    when a Playwright-managed download completes. Returns the row count.

    A DataDome response is not rendered by fetch(), so on one the page is
    reloaded to show the challenge in the visible window, then the year is
    failed so the caller's block counting applies."""
    log.info("  Waiting for the server to generate the export "
             "(large years take several minutes)...")
    res = page.evaluate(FETCH_EXPORT_JS, [href, DOWNLOAD_TIMEOUT_MS])
    status, text = res["status"], res["text"]
    head = text[:5000]
    if _content_has_datadome(head):
        page.goto(page_url, timeout=30_000)
        _wait_out_datadome(page, log, f"{where} export fetch")
        raise RuntimeError(f"DataDome blocked the export fetch at {where}")
    if status != 200 or head.lstrip().startswith("<"):
        raise RuntimeError(f"export fetch at {where} returned HTTP {status} "
                           f"with {'HTML' if head.lstrip().startswith('<') else 'unexpected'} content")
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return text.count("\n") - 1


def download_candidates(page, context, log) -> tuple[str, int] | None:
    page_url = PAGES["candidates"]
    page.goto(page_url, timeout=30_000)
    page.wait_for_load_state("networkidle")
    _wait_out_datadome(page, log, "candidates page load")

    year_sel = page.locator("select[name*='ddlYear']")
    if year_sel.count():
        year_sel.select_option("All")

    search_btn = page.locator("input[value='Search']")
    if search_btn.count():
        page.click("input[value='Search']")
        page.wait_for_load_state("networkidle")
        _wait_out_datadome(page, log, "candidates search")

    body_text = page.locator("body").inner_text()
    if "No records" in body_text or "0 records" in body_text.lower():
        log.info("  candidates: no records found")
        return None

    page.click("input[value='Export']")
    _wait_out_datadome(page, log, "candidates export click")

    csv_link = page.locator("a[id*='hlAllCSV']")
    try:
        csv_link.wait_for(timeout=15_000)
        # get_attribute("href") returns the raw HTML attribute, which on
        # this ASP.NET page is relative -- page.goto() on a context with
        # no baseURL throws on that. evaluate() reads the DOM's resolved
        # (absolute) href property instead, matching what live DevTools
        # testing confirmed works.
        csv_href = csv_link.evaluate("el => el.href")
    except Exception:
        log.warning("  [!] Export dialog did not appear for candidates")
        return None

    filename = "CDCandidates_all.csv"
    out_path = RAW_DIR / filename
    row_count = _fetch_export(page, csv_href, out_path, page_url, log, "candidates")
    return filename, row_count


def _save_debug_snapshot(page, label: str, log) -> None:
    """Save a screenshot and the page HTML to logs/dev/ for a failed step."""
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    out_dir = PROJECT_ROOT / "logs" / "dev"
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"{stamp}-alaska-{label}"
    try:
        page.screenshot(path=str(base.with_suffix(".png")), full_page=True)
        base.with_suffix(".html").write_text(page.content(), encoding="utf-8")
        log.warning(f"  [!] Saved page snapshot: {base.name}.png / .html")
    except Exception as e:
        log.warning(f"  [!] Could not save page snapshot: {e!r}")


RESULT_COUNT_RE = re.compile(r"([\d,]+)\s+items?\s+in\s+\d+\s+pages?", re.I)


def _result_count(page, timeout_ms: int = 20_000) -> int | None:
    """Wait for the results summary ("N items in M pages") and return N.

    Returns None when no summary renders within timeout_ms (for example,
    a search with no results shows no summary)."""
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        try:
            m = RESULT_COUNT_RE.search(page.locator("body").inner_text())
        except Exception:
            m = None
        if m:
            return int(m.group(1).replace(",", ""))
        time.sleep(1)
    return None


def _export_csv_href(page, csv_link, log, where: str, label: str) -> str:
    """Click Export and return the resolved href of the CSV export link.

    Call after _result_count(), which waits for the search results to
    render: an Export click made while the results postback is still in
    flight is dropped and the CSV link never appears. Retries the click
    once, then saves a page snapshot and raises."""
    for attempt in (1, 2):
        page.locator("input[value='Export']:visible").first.click()
        _wait_out_datadome(page, log, f"{where} export click")
        try:
            csv_link.wait_for(state="visible", timeout=30_000)
            # evaluate() returns the resolved absolute href; get_attribute()
            # returns the raw relative one, which goto() rejects.
            return csv_link.evaluate("el => el.href")
        except Exception:
            log.warning(f"  [!] CSV link did not appear after Export click "
                        f"(attempt {attempt}) at {where}")
    _save_debug_snapshot(page, label, log)
    raise RuntimeError(f"CSV export link never appeared at {where}")


def download_year(page, context, relation_type: str, year: str, log) -> tuple[str, int] | None:
    page_url = PAGES[relation_type]
    page.goto(page_url, timeout=30_000)
    page.wait_for_load_state("networkidle")
    _wait_out_datadome(page, log, f"{relation_type} {year} page load")

    year_sel = page.locator("select[name*='ddlReportYear']")
    if year_sel.count():
        year_sel.select_option(year)

    status_sel = page.locator("select[name*='ddlStatus']")
    if status_sel.count():
        try:
            status_sel.select_option(label="All Complete Forms")
        except Exception:
            status_sel.select_option("0")

    page.click("input[value='Search']")
    page.wait_for_load_state("networkidle")
    _wait_out_datadome(page, log, f"{relation_type} {year} search")

    body_text = page.locator("body").inner_text()
    if "No records" in body_text or "0 records" in body_text.lower():
        log.debug(f"  {relation_type} {year}: no records")
        return None

    filename = f"{STEMS[relation_type]}_{year}.csv"
    out_path = RAW_DIR / filename
    csv_link = page.locator("a[id*='hlAllCSV']")

    # An empty year gets an empty file, matching what the export returns
    # for one, so the year is recorded and not retried on every run.
    count = _result_count(page)
    if count == 0:
        log.info(f"  {relation_type} {year}: 0 results, writing empty file")
        out_path.write_text("", encoding="utf-8")
        return filename, -1
    try:
        csv_href = _export_csv_href(page, csv_link, log, f"{relation_type} {year}",
                                    f"{STEMS[relation_type]}_{year}")
    except RuntimeError:
        if count is not None:
            raise
        log.warning(f"  [!] {relation_type} {year}: no results summary and no CSV "
                    f"link; treating as empty (see the saved snapshot)")
        out_path.write_text("", encoding="utf-8")
        return filename, -1
    row_count = _fetch_export(page, csv_href, out_path, page_url,
                              log, f"{relation_type} {year}")
    return filename, row_count


# ===================== transactions: --grid mode =====================
# See the module docstring. relation -> (page, file stem, ddlField value).
GRID_PAGES = {
    "income":       ("CDIncome",       "CDIncome",  "IncomeTypes"),
    "expenditures": ("CDExpenditures", "CDExpense", "ExpenditureTypes"),
    # Independent expenditures (Form 15-6): the same Telerik search/export
    # grid, also served over plain HTTP (checked 2026-10-20: 1,555 rows for
    # 2026, no DataDome page). Until then only the Playwright path fetched
    # them, and a --grid run never did, so Alaska had no outside spending.
    "ie_expenditures":  ("IndependentExpenditures/IEExpenditures",  "IEExpenditures",  "IEFilerTypes"),
    "ie_contributions": ("IndependentExpenditures/IEContributions", "IEContributions", "IEFilerTypes"),
}
GRID_IE = ("ie_expenditures", "ie_contributions")
# The IE pages' name filter has no "CandidateName" option.
GRID_NAME_TYPE   = {"ie_expenditures": "Any", "ie_contributions": "Any"}
GRID_ROOT        = "https://aws.state.ak.us/ApocReports"
GRID_BASE        = f"{GRID_ROOT}/CampaignDisclosure"
GRID_STATUS      = "Default"   # "Complete, Not Amended"
GRID_PAGE_SIZE   = 5000        # ~30 s a request statewide
GRID_TRIES       = 8           # per request
GRID_YEAR_TRIES  = 3           # per year (a fresh session each time)
GRID_PAUSE_S     = 3           # between requests; resets come in bursts
GRID_USER_AGENT  = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
_GRID_COUNT_RE   = re.compile(r"<strong>([\d,]+)</strong>\s*items in")   # the pager's total
_GRID_ROW_RE     = re.compile(r'<tr class="rg(?:Alt)?Row"')               # a grid row
# Only a search's own answer: the unsearched page has an empty grid too.
_GRID_EMPTY_RE   = re.compile(r"Your Search Returned No Results", re.I)


def grid_url(relation_type: str) -> str:
    page = GRID_PAGES[relation_type][0]
    return f"{GRID_ROOT}/{page}.aspx" if "/" in page else f"{GRID_BASE}/{page}.aspx"


def grid_filename(relation_type: str, year: str) -> str:
    """grid_<stem>_<year>.csv for income / expenditures; the IE exports keep
    the Playwright path's own names (IEExpenditures_<year>.csv), which is
    what parsers/alaska.py reads."""
    stem = GRID_PAGES[relation_type][1]
    return f"{stem}_{year}.csv" if relation_type in GRID_IE else f"grid_{stem}_{year}.csv"


def _grid_request(session, url: str, log, data: dict | None = None) -> str:
    """GET (or POST `data`) with the pilot's retry-everything handling: resets,
    timeouts, 5xx and DataDome pages all retry, with a longer wait each time."""
    import requests
    last = None
    for attempt in range(GRID_TRIES):
        if attempt:
            time.sleep(min(60, 5 * attempt))
        try:
            resp = (session.post(url, data=data, timeout=300) if data is not None
                    else session.get(url, timeout=300))
            if resp.status_code >= 500:
                last = f"HTTP {resp.status_code}"
                continue
            resp.raise_for_status()
            text = resp.content.decode("utf-8", "replace")
            # HTML only: a CSV's free text could quote a marker phrase.
            if "html" in resp.headers.get("Content-Type", "") and _content_has_datadome(text):
                last = "DataDome block page"
                log.warning(f"  [!] DataDome page from {url.split('?')[0]} -- backing off")
                time.sleep(30)
                continue
            return text
        except requests.RequestException as e:
            last = e
    raise RuntimeError(f"{url.split('?')[0]}: failed after {GRID_TRIES} tries: {last}")


def _grid_form(html: str, prefix: str, field: str, year: str, button: str, value: str,
               name_type: str = "CandidateName") -> dict:
    """The search form as the page posts it: any filer, any type, one report
    year, GRID_STATUS, plus the button pressed. `prefix` is the controls'
    name prefix up to "csfFilter$" ("M$C$<x>$" or, on the IE pages, "M$C$")."""
    def hidden(name):
        m = re.search(rf'id="{name}" value="([^"]*)"', html)
        if not m:
            raise RuntimeError(f"no {name} on the page")
        return m.group(1)
    f = f"{prefix}csfFilter$"
    return {"__EVENTTARGET": "", "__EVENTARGUMENT": "", "__LASTFOCUS": "",
            "__VIEWSTATE": hidden("__VIEWSTATE"),
            "__VIEWSTATEGENERATOR": hidden("__VIEWSTATEGENERATOR"),
            f + "ddlNameType": name_type, f + "txtName": "",
            f + "ddlField": field, f + "ddlValue": "-1",
            f + "txtBeginDate": "", f + "txtEndDate": "",
            f + "ddlReportYear": year, f + "ddlStatus": GRID_STATUS,
            f + button: value}


def _grid_year_once(relation_type: str, year: str, log) -> tuple[list[str], list[list[str]]] | None:
    """(header, rows) of one statewide report year, or None when the search
    returns no results. Raises when the export doesn't add up."""
    import requests
    page, _, field = GRID_PAGES[relation_type]
    url = grid_url(relation_type)
    name_type = GRID_NAME_TYPE.get(relation_type, "CandidateName")
    session = requests.Session()
    session.headers["User-Agent"] = GRID_USER_AGENT

    html = _grid_request(session, url, log)
    m = re.search(r'name="(M\$C\$(?:[^"$]+\$)?)csfFilter\$txtName"', html)
    if not m:
        raise RuntimeError(f"{page}: search form not found")
    prefix = m.group(1)
    time.sleep(GRID_PAUSE_S)
    found = _grid_request(session, url, log,
                          _grid_form(html, prefix, field, year, "btnSearch", "Search", name_type))
    m = _GRID_COUNT_RE.search(found)
    if m:
        expected = int(m.group(1).replace(",", ""))
    elif _GRID_EMPTY_RE.search(found):
        return None
    elif "rgPager" not in found and _GRID_ROW_RE.search(found):
        # One screen of results (2027's handful of early gifts) has no pager.
        expected = len(_GRID_ROW_RE.findall(found))
    else:
        raise RuntimeError(f"{page} {year}: search returned neither rows nor 'No Results'")

    # The export dialog's links carry the session's stored search.
    time.sleep(GRID_PAUSE_S)
    dialog = _grid_request(session, url, log,
                           _grid_form(found, prefix, field, year, "btnExport", "Export", name_type))
    links = [l.replace("&amp;", "&") for l in re.findall(r'href="([^"]*isExport[^"]*)"', dialog)]
    page_link = next((l for l in links if "exportFormat=CSV" in l and "exportAll=False" in l), None)
    if not page_link:
        raise RuntimeError(f"{page} {year}: no CSV export link in the export dialog")
    page_link = "https://aws.state.ak.us" + page_link if page_link.startswith("/") else page_link

    header, rows = None, []
    for index in range(-(-expected // GRID_PAGE_SIZE)):
        u = re.sub(r"pageSize=\d+", f"pageSize={GRID_PAGE_SIZE}",
                   re.sub(r"pageIndex=\d+", f"pageIndex={index}", page_link))
        time.sleep(GRID_PAUSE_S)
        records = list(csv.reader(io.StringIO(_grid_request(session, u, log))))
        if not records:
            break
        if header is None:
            header = records[0]
            if "Result" not in header or "Amount" not in header:
                raise RuntimeError(f"{page} {year}: unexpected export header {header[:5]}")
        elif records[0] != header:
            raise RuntimeError(f"{page} {year}: export header changed on page {index}")
        rows.extend(records[1:])
        log.info(f"  {page} {year}: page {index}: {len(records) - 1} rows")
        if len(records) - 1 < GRID_PAGE_SIZE:
            break
    if len(rows) != expected:
        raise RuntimeError(f"{page} {year}: exported {len(rows)} rows, the search "
                           f"reported {expected}")
    return header, rows


def download_grid_year(relation_type: str, year: str, log) -> tuple[str, int] | None:
    """One report year of income or expenditures via the grid export, into
    grid_<stem>_<year>.csv (written to .part, renamed when complete). None when
    the year has no rows. Retries the whole year GRID_YEAR_TRIES times."""
    filename = grid_filename(relation_type, year)
    last = None
    for attempt in range(GRID_YEAR_TRIES):
        if attempt:
            log.warning(f"  [!] {filename}: {last} -- retrying the year")
            time.sleep(30 * attempt)
        try:
            result = _grid_year_once(relation_type, year, log)
            break
        except RuntimeError as e:
            last = e
    else:
        raise RuntimeError(f"{filename}: {last}")
    if result is None:
        return None
    header, rows = result
    out_path = RAW_DIR / filename
    part = RAW_DIR / (filename + ".part")
    with open(part, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    part.replace(out_path)
    return filename, len(rows)


def run_grid(log, start_year: int | None, end_year: int | None,
             do_income: bool, do_expend: bool, do_ie: bool = False) -> tuple[int, int]:
    """--grid: income / expenditures (and, with do_ie, the independent
    expenditure exports) per report year over plain HTTP.
    Returns (files_ok, files_err); raises after logging when a year fails."""
    import requests
    session = requests.Session()
    session.headers["User-Agent"] = GRID_USER_AGENT
    html = _grid_request(session, f"{GRID_BASE}/CDIncome.aspx", log)
    sel = re.search(r'<select[^>]*name="[^"]*ddlReportYear"[^>]*>(.*?)</select>', html, re.S)
    years = sorted({y for y in re.findall(r'value="(\d{4})"', sel.group(1) if sel else "")})
    if not years:
        raise RuntimeError("CDIncome: no report years in the search form")
    years = [y for y in years
             if (start_year is None or int(y) >= start_year)
             and (end_year is None or int(y) <= end_year)]
    files_ok = files_err = 0
    wanted = {"income": do_income, "expenditures": do_expend,
              "ie_expenditures": do_ie, "ie_contributions": do_ie}
    for relation_type in GRID_PAGES:
        if not wanted[relation_type]:
            continue
        log.info(f"\nAlaska {relation_type} (grid): report years {', '.join(years)}")
        for year in years:
            filename = grid_filename(relation_type, year)
            log.file_download_start(filename=filename)
            t_file = time.perf_counter()
            try:
                result = download_grid_year(relation_type, year, log)
            except Exception as e:
                log.file_download_error(filename=filename, error=str(e))
                raise
            if result is None:
                # A year with no reports yet: drop a stale file from an
                # earlier run rather than parse it.
                (RAW_DIR / filename).unlink(missing_ok=True)
                log.info(f"  {filename}: no reports for {year}")
                continue
            filename, row_count = result
            log.file_download_ok(filename=filename, bytes=(RAW_DIR / filename).stat().st_size,
                                 rows=row_count, duration_s=time.perf_counter() - t_file)
            files_ok += 1
            upsert_manifest({"relation_type": f"{relation_type}_grid", "year": year,
                             "filename": filename, "row_count": row_count})
    return files_ok, files_err


# ============================ orchestrator ============================
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
    independent_expenditures: bool = False,
    grid: bool = False,
):
    """Orchestrate download of transaction CSVs and/or candidate/group entities.

    Vertical scope (mutually exclusive):
        force=True              — re-download all years, wipe relevant manifest entries
        start_year / end_year   — restrict year-based downloads to this range
        neither                 — start_year defaults to the first year of the
                                  current two-year election cycle (2025 in
                                  2025-2026); pass start_year=2008 to backfill

    Horizontal scope:
        No flags                — download everything
        transactions            — income + expenditures only
        entities                — candidates + groups only
        contributions           — income only (implies transactions)
        expenditures            — expenditures only (implies transactions)
        candidates              — CDCandidates + CRForms bulk only (implies entities)
        committees              — GRForms bulk only (implies entities)
        independent_expenditures — IE (Form 15-6) bulk exports only (its own filing track, own manifest vertical -- not folded into entities/transactions so an --entities/--transactions caller doesn't unexpectedly pick it up). Uses the same year-based bulk Search/Export flow as income/expenditures/groups, not a per-ID detail sweep.

    grid=True: income and expenditures come over plain HTTP by report year
    (grid_*_<year>.csv, see the module docstring) and need no browser; a
    failed year raises (exit 1). Other relations still use Playwright.
    """
    log = get_logger("alaska", "scrape")
    t0  = time.perf_counter()
    log.info("Starting Alaska scraper")
    if not force and start_year is None and end_year is None:
        start_year = default_start_year()
        log.info(f"  No year range given: defaulting to --start-year {start_year} "
                 f"(current election cycle). Pass --start-year 2008 to backfill.")
    log._emit("scrape_started", force=force, entities=entities, transactions=transactions,
              start_year=start_year, end_year=end_year,
              contributions=contributions, expenditures=expenditures,
              candidates=candidates, committees=committees,
              independent_expenditures=independent_expenditures, grid=grid)

    # ── Resolve granular scope ────────────────────────────────────────
    # Any horizontal flag set → only the named types; none → everything.
    no_horizontal = not (entities or transactions or contributions or
                         expenditures or candidates or committees or
                         independent_expenditures)

    do_income        = no_horizontal or transactions or contributions
    do_expend        = no_horizontal or transactions or expenditures
    do_candidates_dl = no_horizontal or entities or candidates
    do_groups_dl     = no_horizontal or entities or committees
    # Independent_expenditures is its OWN horizontal flag, not folded into
    # entities -- see run()'s docstring. no_horizontal alone still covers
    # the plain-no-flags "download everything" case.
    do_ie            = no_horizontal or independent_expenditures

    files_ok = files_err = pages_ok = pages_err = 0
    current_year = str(datetime.today().year)

    # ── --grid: income / expenditures over plain HTTP, no browser ─────
    if grid and (do_income or do_expend or do_ie):
        try:
            files_ok, files_err = run_grid(log, start_year, end_year, do_income, do_expend, do_ie)
        except Exception as e:
            log._emit("scrape_completed", status="error",
                      duration_s=round(time.perf_counter() - t0, 1),
                      files_ok=files_ok, files_err=files_err + 1,
                      pages_ok=pages_ok, pages_err=pages_err,
                      error_type=type(e).__name__, error=str(e))
            raise
        do_income = do_expend = do_ie = False
        if not (do_candidates_dl or do_groups_dl):
            duration = round(time.perf_counter() - t0, 1)
            log.info(f"Done in {duration}s")
            log._emit("scrape_completed", status="completed", duration_s=duration,
                      files_ok=files_ok, files_err=files_err,
                      pages_ok=pages_ok, pages_err=pages_err)
            return

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log.error("[!] Playwright not installed. Run: pip install playwright && playwright install chromium")
        log._emit("scrape_completed", status="error", duration_s=0.0,
                  files_ok=0, files_err=0, pages_ok=0, pages_err=0,
                  error="playwright not installed")
        return

    # ── Scoped manifest clearing ──────────────────────────────────────
    if force:
        relations_to_clear = set()
        if do_income:        relations_to_clear.add("income")
        if do_expend:        relations_to_clear.add("expenditures")
        if do_candidates_dl: relations_to_clear.add("candidates")
        if do_candidates_dl: relations_to_clear.add("cr_forms")
        if do_groups_dl:     relations_to_clear.add("groups")
        if do_ie:            relations_to_clear.add("ie_expenditures")
        if do_ie:            relations_to_clear.add("ie_contributions")
        strip_manifest(lambda r: r["relation_type"] not in relations_to_clear)

    elif start_year is not None or end_year is not None:
        # Year range — wipe manifest entries for year-based relations within the range
        # so they get re-downloaded, not skipped as "already done".
        year_based = set()
        if do_income:        year_based.add("income")
        if do_expend:        year_based.add("expenditures")
        if do_groups_dl:     year_based.add("groups")
        if do_candidates_dl: year_based.add("cr_forms")
        if do_ie:            year_based.add("ie_expenditures")
        if do_ie:            year_based.add("ie_contributions")

        def _outside_range(r: dict) -> bool:
            """Keep rows that are NOT in the wipe zone."""
            if r["relation_type"] not in year_based:
                return True   # non-year-based entries always kept
            try:
                yr = int(r["year"])
            except ValueError:
                return True   # non-numeric year entries (e.g. "all") always kept
            if start_year is not None and yr < start_year:
                return True   # below range — keep
            if end_year is not None and yr > end_year:
                return True   # above range — keep
            return False      # within range — wipe

        strip_manifest(_outside_range)

    done, has_data = load_manifest()

    # ── Build pages_to_run for the Playwright loop ────────────────────
    pages_to_run: set[str] = set()
    if do_income:        pages_to_run.add("income")
    if do_expend:        pages_to_run.add("expenditures")
    if do_candidates_dl: pages_to_run.add("candidates")
    if do_candidates_dl: pages_to_run.add("cr_forms")
    if do_groups_dl:     pages_to_run.add("groups")
    if do_ie:            pages_to_run.add("ie_expenditures")
    if do_ie:            pages_to_run.add("ie_contributions")

    try:
        # ── Playwright: transaction CSVs + candidate/group exports ────
        with sync_playwright() as p:
            # Persistent profile (under PROFILE_ROOT), not a fresh launch()/
            # new_context() pair. Confirmed live 2026-09-23: aws.state.ak.us
            # is fronted by DataDome, which serves an interactive "slide to
            # verify" challenge when it sees automated-looking traffic
            # (explicitly names "rapid taps or clicks" / "automated bot
            # activity" as trigger reasons -- matches this scraper's own
            # back-to-back year-download pattern). It requires a real human
            # drag gesture; it cannot be solved by script. A throwaway
            # new_context() starts with zero cookies every run, so DataDome
            # has no way to recognize a returning, already-trusted session,
            # and a fresh challenge is effectively guaranteed every time.
            # launch_persistent_context() writes cookies (including the
            # `datadome` trust cookie set after a challenge is solved) to
            # the profile directory -- solve it once by hand and later runs
            # reuse that cookie, same fix already proven for Missouri's
            # Incapsula CAPTCHA elsewhere in this repo. If the challenge
            # ever reappears, that's the trust cookie expiring or getting
            # invalidated, not a code regression -- just solve it again once.
            context = _launch_context(p, log)
            context.add_init_script(STEALTH_INIT_SCRIPT)
            page = context.new_page()

            def _browser_alive() -> bool:
                try:
                    page.evaluate("1")
                    return True
                except Exception:
                    return False

            def _relaunch_browser() -> None:
                """Replace a crashed or closed browser with a fresh one on
                the same persistent profile."""
                nonlocal context, page
                log.warning("  [!] Browser closed unexpectedly -- relaunching")
                try:
                    context.close()
                except Exception:
                    pass
                context = _launch_context(p, log)
                context.add_init_script(STEALTH_INIT_SCRIPT)
                page = context.new_page()

            # ── Division of Elections candidate list ──────────────────
            # Current election cycle only: older cycles' lists are not
            # known to be published under the same codes.
            if do_candidates_dl:
                election_year = default_start_year() + 1
                if end_year is None or end_year >= election_year:
                    log.info(f"\nAlaska Division of Elections candidate list ({election_year}):")
                    ok, err = download_doe_candidates(page, election_year, log)
                    pages_ok += ok
                    pages_err += err

            for relation_type, page_url in PAGES.items():
                if relation_type not in pages_to_run:
                    continue

                log.info(f"\nAlaska {relation_type}:")

                # Candidates — single all-years export, no year filter applies
                if relation_type == "candidates":
                    key = ("candidates", "all")
                    cand_file = RAW_DIR / "CDCandidates_all.csv"
                    # The candidate registry is one all-years export, so it
                    # is refreshed whenever the run covers the current year;
                    # new registrations appear in it all cycle.
                    refresh = force or end_year is None or end_year >= int(current_year)
                    if (key in done or cand_file.exists()) and not refresh:
                        log.file_download_skip(filename="CDCandidates_all.csv")
                    else:
                        log.file_download_start(filename="CDCandidates_all.csv")
                        t_file  = time.perf_counter()
                        result  = None
                        err_msg = None
                        try:
                            result = download_candidates(page, context, log)
                        except Exception as e:
                            err_msg = str(e)

                        if err_msg:
                            log.file_download_error(filename="CDCandidates_all.csv", error=err_msg)
                            files_err += 1
                        elif result:
                            filename, row_count = result
                            size = (RAW_DIR / filename).stat().st_size
                            log.file_download_ok(filename=filename, bytes=size,
                                                 rows=row_count,
                                                 duration_s=time.perf_counter() - t_file)
                            files_ok += 1
                            upsert_manifest({
                                "relation_type": "candidates",
                                "year":          "all",
                                "filename":      filename,
                                "row_count":     row_count,
                            })
                            done.add(key)
                    continue

                # Year-based relations (income, expenditures, groups)
                if not _browser_alive():
                    _relaunch_browser()
                page.goto(page_url, timeout=30_000)
                page.wait_for_load_state("networkidle")
                _wait_out_datadome(page, log, f"{relation_type} years dropdown load")

                years = get_available_years(page)
                if not years:
                    log.warning(f"  [!] Could not read year dropdown for {relation_type} — skipping")
                    continue

                log.info(f"  Available years: {years[0]}–{years[-1]} ({len(years)} total)")
                consecutive_datadome_blocks = 0

                for year in years:
                    yr_int        = int(year)
                    expected_stem = f"{STEMS[relation_type]}_{year}.csv"

                    # Year range filter — skip years outside requested window
                    if start_year is not None and yr_int < start_year:
                        log.file_download_skip(filename=expected_stem)
                        continue
                    if end_year is not None and yr_int > end_year:
                        log.file_download_skip(filename=expected_stem)
                        continue

                    key           = (relation_type, year)
                    expected_file = RAW_DIR / expected_stem
                    # When a year range is active the manifest was already wiped for
                    # in-range entries — don't fall back to file existence or those
                    # years will still be skipped even though the manifest was cleared.
                    year_range_active = start_year is not None or end_year is not None
                    already_done = key in done or (
                        not year_range_active
                        and expected_file.exists()
                        and expected_file.stat().st_size > 0
                    )

                    if already_done and year != current_year and not force:
                        log.file_download_skip(filename=expected_stem)
                        continue

                    log.file_download_start(filename=expected_stem)
                    t_file  = time.perf_counter()
                    result  = None
                    err_msg = None
                    try:
                        result = download_year(page, context, relation_type, year, log)
                    except Exception as e:
                        err_msg = str(e)
                    if err_msg and not _browser_alive():
                        _relaunch_browser()
                        log.info(f"  Retrying {expected_stem} in the relaunched browser")
                        err_msg = None
                        try:
                            result = download_year(page, context, relation_type, year, log)
                        except Exception as e:
                            err_msg = str(e)

                    if err_msg:
                        log.file_download_error(filename=expected_stem, error=err_msg)
                        files_err += 1
                        try:
                            was_datadome = not page.is_closed() and _content_has_datadome(page.content())
                        except Exception:
                            was_datadome = False
                        if was_datadome:
                            consecutive_datadome_blocks += 1
                            if consecutive_datadome_blocks >= DATADOME_MAX_CONSECUTIVE_BLOCKS:
                                log.warning(
                                    f"  {consecutive_datadome_blocks} consecutive DataDome "
                                    f"blocks on {relation_type} -- stopping this relation type "
                                    f"rather than hammering a live block; re-run later to resume"
                                )
                                break
                        continue

                    if result is None:
                        continue

                    filename, row_count = result
                    size = (RAW_DIR / filename).stat().st_size
                    log.file_download_ok(filename=filename, bytes=size, rows=row_count,
                                         duration_s=time.perf_counter() - t_file)
                    files_ok += 1
                    consecutive_datadome_blocks = 0
                    upsert_manifest({
                        "relation_type": relation_type,
                        "year":          year,
                        "filename":      filename,
                        "row_count":     row_count,
                    })
                    done.add(key)
                    # DataDome's own challenge copy calls out "rapid taps or
                    # clicks" as a trigger signal -- a little jitter between
                    # years (vs. the old flat 1s) costs almost nothing over
                    # a run and reduces how metronomic the request pattern
                    # looks.
                    time.sleep(random.uniform(2.0, 5.0))

            context.close()

        duration = round(time.perf_counter() - t0, 1)
        log.info(f"Done in {duration}s")
        log._emit("scrape_completed", status="completed", duration_s=duration,
                  files_ok=files_ok, files_err=files_err,
                  pages_ok=pages_ok, pages_err=pages_err)

    except KeyboardInterrupt:
        log.warning("Interrupted")
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


# ====== CLI ==================================
if __name__ == "__main__":
    # Vertical scope (mutually exclusive):
    #   (no flag)                    incremental — current year + fill manifest gaps
    #   --start-year / --end-year    year range only
    #   --force                      all years, wipe manifest entries in scope
    #
    # Horizontal scope:
    #   (no flag)         all types
    #   --transactions    income + expenditures
    #   --entities        candidates + groups
    #   --contributions   income only
    #   --expenditures    expenditures only
    #   --candidates      CDCandidates + CRForms bulk
    #   --committees      GRForms bulk
    import argparse
    ap = argparse.ArgumentParser(
        description="Download Alaska APOC campaign finance data."
    )

    # Vertical — mutually exclusive
    vert = ap.add_mutually_exclusive_group()
    vert.add_argument("--force",      action="store_true",
                      help="re-download all years in scope, wipe relevant manifest entries")
    vert.add_argument("--start-year", type=int, metavar="YYYY",
                      help="earliest year to download (inclusive)")
    ap.add_argument("--end-year", type=int, metavar="YYYY",
                    help="latest year to download (inclusive, ≤ current year); "
                         "use with or without --start-year")

    # Horizontal — top level
    ap.add_argument("--transactions", action="store_true",
                    help="transactions only (income + expenditures)")
    ap.add_argument("--entities",     action="store_true",
                    help="entities only (candidates, groups)")

    # Horizontal — second level
    ap.add_argument("--contributions", action="store_true",
                    help="income files only")
    ap.add_argument("--expenditures",  action="store_true",
                    help="expenditure files only")
    ap.add_argument("--candidates",    action="store_true",
                    help="CDCandidates export + CRForms bulk only")
    ap.add_argument("--committees",    action="store_true",
                    help="GRForms bulk only")
    ap.add_argument("--independent-expenditures", action="store_true",
                    dest="independent_expenditures",
                    help="IE (Form 15-6) bulk exports only -- separate filing track from everything else this scraper covers")
    ap.add_argument("--grid", action="store_true",
                    help="income / expenditures over plain HTTP (no browser), status "
                         "'Complete, Not Amended', into grid_*_<year>.csv")

    args, _ = ap.parse_known_args()

    # --end-year requires --start-year or stands alone; validate range
    cy = datetime.today().year
    if args.end_year:
        if args.end_year > cy:
            ap.error(f"--end-year cannot exceed current year ({cy})")
        if args.start_year and args.start_year > args.end_year:
            ap.error("--start-year cannot be greater than --end-year")
    # --force is already mutually exclusive with --start-year via the group;
    # also guard against --force + --end-year
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
            independent_expenditures=args.independent_expenditures,
            grid=args.grid,
        )
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
