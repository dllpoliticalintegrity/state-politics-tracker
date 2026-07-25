#!/usr/bin/env python3
"""
Michigan legislature finance: MiTN bulk exports -> cf_filers / cf_filer_links /
cf_official_finance.

This is the reference implementation of the identity-first pipeline described
in docs/plan.md. The order matters:

  1. **Registry.** Michigan's bulk contribution export carries, on every row,
     the committee's id, legal name, type, and — for candidate committees — the
     candidate's name, party, office sought, and district sought. That makes
     the export its own filer registry; no separate committee scrape needed.
  2. **Match by rule, and record the rule.** Every sitting legislator comes from
     cf_officials (the Open States roster, which is the authoritative
     denominator: 148 seats, not "however many filers exist"). Each is matched
     against the registry on office + district + surname, falling back to a
     *unique* office + surname. Committees that match nothing are left alone;
     legislators that match nothing are reported, never guessed at.
  3. **Scope by transaction date, not by file.** Michigan names its exports by
     filing-statement year, so the 2025 and 2026 files contain thousands of
     rows dated 2024. Summing a file because of its name is how a tracker ends
     up publishing all-time totals under a 2026 label. Every row is filtered to
     the cycle window before it counts.
  4. **Check before publishing.** --check runs the assertions in run_checks()
     and exits non-zero, so a bad sync fails the workflow instead of quietly
     replacing good numbers with bad ones.

Auth: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to write. Reading the roster
needs no key — cf_officials is publicly readable.

Usage:
    python3 import_mi_legislature.py --dry-run          # fetch, match, report
    python3 import_mi_legislature.py --check            # dry run + assertions
    python3 import_mi_legislature.py                    # load Supabase
"""

import argparse
import collections
import io
import json
import os
import re
import sys
import zipfile
from datetime import date, datetime, timezone
from urllib import parse, request

STATE = "mi"
CYCLE = "2026"
# Michigan's legislative cycle: the two years after the 2024 general, through
# the 2026 general. Transactions outside this window belong to another cycle
# regardless of which file they arrived in.
CYCLE_START = date(2025, 1, 1)
CYCLE_END = date(2026, 12, 31)
# Which statement-year files can contain in-window transactions.
FILE_YEARS = {"2025", "2026"}

MI_BASE = "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
# cf_officials is publicly readable, so a dry run needs no credentials.
PUBLIC_URL = "https://lohxdfrxnxuxjdvvyfjc.supabase.co"
PUBLIC_KEY = "sb_publishable_r8D7t0Stine_UgCoU_ps8g_UDRKSpoX"

# Open States chamber -> the office string Michigan prints on filings.
CHAMBER_OFFICE = {
    "upper": "State Senator",
    "lower": "Representative in State Legislature",
}

# Sanity ceilings for --check. A Michigan legislative seat is not a governor's
# race; a member over the ceiling means a statewide committee has been matched
# in by mistake, which is the single most likely way this pipeline goes wrong.
MAX_RAISED_PER_MEMBER = 2_000_000
MIN_MATCH_RATE = 0.95

NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


# --------------------------------------------------------------------------
# Normalization — the matcher's whole vocabulary
# --------------------------------------------------------------------------

def surname_key(value):
    """Comparable surname: drop suffixes and punctuation, join what's left.

    Michigan writes surnames as they were filed — "WILSON JR.", "ANDREWS IV",
    "DE BOER" — while Open States writes "Wilson", "Andrews", "DeBoer". Joining
    the remaining tokens makes those agree without loosening the match: it only
    ever removes separators, never letters.
    """
    tokens = [t for t in re.sub(r"[^A-Za-z ]", " ", value or "").lower().split()
              if t and t not in NAME_SUFFIXES]
    return "".join(tokens)


def district_number(value):
    """'32nd District' / '32' -> 32. Returns None when there's no number."""
    m = re.match(r"\s*(\d+)", str(value or ""))
    return int(m.group(1)) if m else None


def parse_mdy(value):
    """MiTN dates are m/d/Y. Returns a date, or None if unparseable."""
    v = (value or "").strip()
    if not v:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def parse_money(value):
    try:
        return float(re.sub(r"[$,]", "", (value or "").strip()) or 0)
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http(url, data=None, headers=None, method=None, timeout=600):
    req = request.Request(url, data=data, headers=headers or {}, method=method)
    with request.urlopen(req, timeout=timeout) as r:
        return r.read()


def sb_headers(key, extra=None):
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    h.update(extra or {})
    return h


def fetch_officials():
    """Sitting MI legislators from cf_officials — the roster we must cover."""
    url = (f"{PUBLIC_URL}/rest/v1/cf_officials?select=id,name,family_name,party,"
           f"chamber,district&state=eq.{STATE}&chamber=not.is.null&limit=1000")
    return json.loads(http(url, headers=sb_headers(PUBLIC_KEY)))


def sb_write(table, rows, conflict):
    if not rows:
        return
    for i in range(0, len(rows), 500):
        http(f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={parse.quote(conflict)}",
             data=json.dumps(rows[i:i + 500]).encode(),
             headers=sb_headers(SERVICE_KEY, {
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal",
             }))


# --------------------------------------------------------------------------
# Michigan bulk exports
# --------------------------------------------------------------------------

def mi_export_index():
    raw = http(f"{MI_BASE}?page=gov.mi.boe.component.cfrexport.page.cfrexportresults"
               f"&pageSize=500&pageNumber=1&sortDirection=DESC&sortBy=year&type=",
               headers={"User-Agent": BROWSER_UA})
    return json.loads(raw)["data"]["list"]


def mi_export_rows(cache_dir=None):
    """Yield (kind, row-dict) for every in-cycle contribution and expenditure file.

    'Receipts' files are skipped: they're the per-statement summary totals, and
    counting them beside the itemized Contribution rows would double the money.
    """
    for meta in mi_export_index():
        if str(meta.get("year")) not in FILE_YEARS:
            continue
        kind = {"Contribution": "contribution", "Expenditure": "expenditure"}.get(
            meta.get("transactiontype"))
        if not kind:
            continue
        blob = None
        cached = None
        if cache_dir:
            cached = os.path.join(cache_dir, f"mi-{meta['download']}.zip")
            if os.path.exists(cached):
                blob = open(cached, "rb").read()
        if blob is None:
            print(f"   downloading {meta['year']} {meta['transactiontype']}…", flush=True)
            blob = http(f"{MI_BASE}?page=gov.mi.boe.component.cfrexport.page.cfrexportfile"
                        f"&id={meta['download']}", headers={"User-Agent": BROWSER_UA})
            if cached:
                open(cached, "wb").write(blob)
        z = zipfile.ZipFile(io.BytesIO(blob))
        for name in z.namelist():
            with io.TextIOWrapper(z.open(name), encoding="utf-8", errors="replace") as f:
                cols = f.readline().rstrip("\n").split("\t")
                idx = {c: i for i, c in enumerate(cols)}
                for line in f:
                    p = line.rstrip("\n").split("\t")
                    if len(p) < len(cols) - 4:
                        continue
                    yield kind, {c: (p[i].strip() if i < len(p) else "")
                                 for c, i in idx.items()}


# --------------------------------------------------------------------------
# Pipeline stages
# --------------------------------------------------------------------------

def collect(cache_dir=None):
    """One pass over the exports: build the filer registry and per-committee totals.

    Totals are keyed by committee here, not by legislator — matching happens
    afterwards, so a change to the matcher never requires re-reading 400MB.
    """
    filers = {}
    totals = collections.defaultdict(
        lambda: {"raised": 0.0, "spent": 0.0, "contribution_count": 0,
                 "expenditure_count": 0})
    skipped_out_of_cycle = 0
    skipped_undated = 0

    for kind, row in mi_export_rows(cache_dir):
        filer_id = row.get("cfr_com_id", "")
        if not filer_id:
            continue
        # Accumulate rather than take the first row: the two exports carry
        # different columns — expenditures have the office and district but no
        # candidate name, contributions have all of them — and the export index
        # hands us expenditures first. Taking whichever row we saw first would
        # leave every filer without a surname and match nothing.
        f = filers.get(filer_id)
        if f is None:
            f = filers[filer_id] = {
                "state": STATE, "filer_id": filer_id,
                "name": row.get("com_legal_name") or f"Committee {filer_id}",
                "committee_type": None, "candidate_first_name": None,
                "candidate_last_name": None, "candidate_party": None,
                "office_sought": None, "district_sought": None,
                "district_number": None, "cycle": CYCLE,
            }
        for column, field in (("com_type", "committee_type"),
                              ("can_first_name", "candidate_first_name"),
                              ("can_last_name", "candidate_last_name"),
                              ("can_political_party", "candidate_party"),
                              ("can_office_sought", "office_sought"),
                              ("can_district_sought", "district_sought")):
            if not f[field] and row.get(column):
                f[field] = row[column]
        if f["district_number"] is None:
            f["district_number"] = district_number(f["district_sought"])

        when = parse_mdy(row.get("received_date") if kind == "contribution"
                         else row.get("exp_date"))
        if when is None:
            skipped_undated += 1
            continue
        if not (CYCLE_START <= when <= CYCLE_END):
            skipped_out_of_cycle += 1
            continue

        amount = parse_money(row.get("amount"))
        t = totals[filer_id]
        if kind == "contribution":
            t["raised"] += amount
            t["contribution_count"] += 1
        else:
            t["spent"] += amount
            t["expenditure_count"] += 1

    return filers, totals, {"out_of_cycle": skipped_out_of_cycle,
                            "undated": skipped_undated}


def match(officials, filers):
    """Match each sitting legislator to their candidate committee(s).

    Two tiers, both rule-based. Nothing weaker is written: a legislator we
    can't place is reported so the gap is visible, because a wrong committee is
    worse than a missing one.
    """
    legislative = {fid: f for fid, f in filers.items()
                   if f["committee_type"] == "Candidate"
                   and f["office_sought"] in CHAMBER_OFFICE.values()}

    by_office_district = collections.defaultdict(list)
    by_office_name = collections.defaultdict(list)
    for fid, f in legislative.items():
        key_name = surname_key(f["candidate_last_name"])
        by_office_district[(f["office_sought"], f["district_number"], key_name)].append(fid)
        by_office_name[(f["office_sought"], key_name)].append(fid)

    links, unmatched = [], []
    for o in officials:
        office = CHAMBER_OFFICE.get(o["chamber"])
        key_name = surname_key(o.get("family_name") or o["name"].split()[-1])
        seat = district_number(o.get("district"))

        hits = by_office_district.get((office, seat, key_name), [])
        method, note = "district_id", None
        if not hits:
            # Committees keep the district they were formed in, so a member
            # redistricted since their last filing won't match on seat. Accept
            # office + surname only when it's unambiguous statewide.
            candidates = by_office_name.get((office, key_name), [])
            if len(candidates) == 1:
                hits, method = candidates, "name_unique"
                filed = legislative[candidates[0]]["district_sought"]
                note = f"committee filed under {filed}; member now in district {o.get('district')}"
        if not hits:
            unmatched.append(o)
            continue
        for fid in hits:
            links.append({"official": o, "filer_id": fid,
                          "match_method": method, "match_note": note})
    return links, unmatched


def rollup(officials, links, filers, totals, as_of):
    """One cf_official_finance row per legislator, covering all their committees."""
    by_official = collections.defaultdict(list)
    for link in links:
        by_official[link["official"]["id"]].append(link)

    rank = {"state_id": 3, "district_id": 2, "name_unique": 1, "manual": 0}
    rows = []
    for o in officials:
        got = by_official.get(o["id"])
        if not got:
            continue
        agg = {"raised": 0.0, "spent": 0.0, "contribution_count": 0,
               "expenditure_count": 0}
        committees = []
        for link in got:
            t = totals.get(link["filer_id"])
            if t:
                for k in agg:
                    agg[k] += t[k]
            committees.append({
                "filer_id": link["filer_id"],
                "name": filers[link["filer_id"]]["name"],
                "match_method": link["match_method"],
            })
        rows.append({
            "official_id": o["id"],
            "state": STATE,
            "cycle": CYCLE,
            "cycle_start": CYCLE_START.isoformat(),
            "cycle_end": CYCLE_END.isoformat(),
            "raised": round(agg["raised"], 2),
            "spent": round(agg["spent"], 2),
            "contribution_count": agg["contribution_count"],
            "expenditure_count": agg["expenditure_count"],
            "committees": committees,
            "weakest_match": min((c["match_method"] for c in committees),
                                 key=lambda m: rank.get(m, 0)),
            "source": "mi-boe-mitn",
            "as_of": as_of,
        })
    return rows


# --------------------------------------------------------------------------
# QA
# --------------------------------------------------------------------------

def run_checks(officials, rows, unmatched, skipped):
    """Assertions a sync must pass before it's allowed to publish."""
    failures = []
    seats = len(officials)

    rate = len(rows) / seats if seats else 0
    if rate < MIN_MATCH_RATE:
        failures.append(f"match rate {rate:.1%} below {MIN_MATCH_RATE:.0%} "
                        f"({len(rows)}/{seats} seats); unmatched: "
                        f"{', '.join(o['name'] for o in unmatched[:10])}")

    hot = [r for r in rows if r["raised"] > MAX_RAISED_PER_MEMBER]
    if hot:
        names = {o["id"]: o["name"] for o in officials}
        failures.append("implausible totals (statewide committee matched in?): "
                        + ", ".join(f"{names.get(r['official_id'], r['official_id'])} "
                                    f"${r['raised']:,.0f}" for r in hot[:5]))

    if not seats:
        failures.append("no legislators in cf_officials — run the Open States sync first")

    broke = [r for r in rows if r["raised"] == 0 and r["spent"] == 0]
    if len(broke) > seats * 0.1:
        failures.append(f"{len(broke)} matched legislators have no transactions at all — "
                        "check the cycle window or the export index")

    # Not a failure, but the number that proves date-scoping is happening.
    print(f"   cycle filter dropped {skipped['out_of_cycle']:,} out-of-window rows "
          f"and {skipped['undated']:,} undated rows", flush=True)
    return failures


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch, match and report without writing")
    ap.add_argument("--check", action="store_true",
                    help="dry run plus assertions; exits non-zero on failure")
    ap.add_argument("--cache-dir", help="reuse downloaded export ZIPs from here")
    args = ap.parse_args()

    writing = not (args.dry_run or args.check)
    if writing and (not SUPABASE_URL or not SERVICE_KEY):
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run)")
    if args.cache_dir:
        os.makedirs(args.cache_dir, exist_ok=True)

    as_of = datetime.now(timezone.utc).isoformat()
    officials = fetch_officials()
    print(f"== roster: {len(officials)} sitting MI legislators", flush=True)

    filers, totals, skipped = collect(args.cache_dir)
    print(f"== registry: {len(filers):,} committees "
          f"({sum(1 for f in filers.values() if f['committee_type'] == 'Candidate'):,} candidate)",
          flush=True)

    links, unmatched = match(officials, filers)
    methods = collections.Counter(l["match_method"] for l in links)
    print(f"== matched: {len(officials) - len(unmatched)}/{len(officials)} legislators, "
          f"{len(links)} committees {dict(methods)}", flush=True)
    for o in unmatched:
        print(f"   UNMATCHED {o['name']} ({o['chamber']}-{o.get('district')})", flush=True)

    rows = rollup(officials, links, filers, totals, as_of)
    print(f"== rollup: ${sum(r['raised'] for r in rows):,.0f} raised, "
          f"${sum(r['spent'] for r in rows):,.0f} spent across {len(rows)} legislators",
          flush=True)

    failures = run_checks(officials, rows, unmatched, skipped)
    if failures:
        for f in failures:
            print(f"CHECK FAILED: {f}", file=sys.stderr)
        sys.exit(1)
    print("== checks passed", flush=True)

    if not writing:
        return

    sb_write("cf_filers", list(filers.values()), "state,filer_id,cycle")
    sb_write("cf_filer_links",
             [{"state": STATE, "filer_id": l["filer_id"],
               "official_id": l["official"]["id"],
               "match_method": l["match_method"], "match_note": l["match_note"]}
              for l in links],
             "state,filer_id,official_id")
    sb_write("cf_official_finance", rows, "official_id,cycle")
    print(f"== wrote {len(filers)} filers, {len(links)} links, {len(rows)} rollups",
          flush=True)


if __name__ == "__main__":
    main()
