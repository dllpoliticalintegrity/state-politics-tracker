"""
PostgREST helpers for the cf_* loader — the pilot importer's http / sb_get_all
/ sb_upsert, lifted unchanged in behaviour (standard library only, so the
loader runs in any environment).

Auth: SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY for writes. A dry run only
reads publicly readable tables (cf_candidates and the cf_* transaction tables
all have public-select RLS), so SUPABASE_KEY may hold the anon key instead.
"""

import json
import os
import sys
import time
from urllib import error, parse, request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY", "")


def _headers(extra=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
    h.update(extra or {})
    return h


def http(url, data=None, headers=None, timeout=300, method=None, tries=3):
    """One request with retries on transport errors and 5xx. PostgREST's error
    body is printed on failure — urllib's own message is just the status."""
    last = None
    for i in range(tries):
        req = request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except error.HTTPError as ex:
            body = ex.read()[:2000].decode("utf-8", "replace") if ex.fp else ""
            print(f"   HTTP {ex.code} {url.split('?')[0]}: {body}", file=sys.stderr, flush=True)
            if ex.code < 500:
                raise
            last = ex
        except (error.URLError, TimeoutError, ConnectionError) as ex:
            last = ex
        if i + 1 < tries:
            time.sleep(5 * (i + 1))
    raise last


def get_all(path, page=1000):
    """GET across PostgREST's 1,000-row cap, paging with Range headers until a
    short page. `path` must carry an order= so pages are stable."""
    rows, start = [], 0
    while True:
        chunk = json.loads(http(
            f"{SUPABASE_URL}/rest/v1/{path}",
            headers=_headers({"Range-Unit": "items",
                              "Range": f"{start}-{start + page - 1}"}),
        ))
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def get_keyset(path, page=1000, by_amount=False):
    """GET every row of `path` (filters + select, which must include id — and
    amount when by_amount), paging on the last row seen instead of an OFFSET,
    so a page's cost doesn't grow with its depth and stays inside the anon
    role's 3 s statement timeout.

    by_amount pages on (amount desc, id): for a candidate_id filter on
    cf_contributions that walks idx_cf_contributions_candidate_amount, where
    paging on id alone makes Postgres sort every one of the candidate's rows
    for every page (60k+ for a governor's race)."""
    rows, last = [], None
    order = "amount.desc,id.asc" if by_amount else "id.asc"
    while True:
        if last is None:
            cursor = ""
        elif by_amount:
            a, i = last["amount"], last["id"]
            cursor = f"&or=(amount.lt.{a},and(amount.eq.{a},id.gt.{i}))"
        else:
            cursor = f"&id=gt.{last['id']}"
        chunk = json.loads(http(
            f"{SUPABASE_URL}/rest/v1/{path}{cursor}&order={order}&limit={page}",
            headers=_headers()))
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        last = chunk[-1]


def upsert(table, rows, conflict="source,source_txn_id", resolution="merge"):
    """Idempotent batch upsert. resolution "merge" updates an existing row in
    place (an amended amount reaches the site, the row keeps its uuid);
    "ignore" leaves it alone, as the pilot importer does."""
    if not rows:
        return
    # PostgREST rejects a bulk insert whose objects don't all share one key
    # set (400 PGRST102) — pad every row to the batch's keys, as the pilot does.
    keys = sorted({k for r in rows for k in r})
    rows = [{k: r.get(k) for k in keys} for r in rows]
    prefer = "merge-duplicates" if resolution == "merge" else "ignore-duplicates"
    http(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={parse.quote(conflict)}",
        data=json.dumps(rows).encode(),
        headers=_headers({"Content-Type": "application/json",
                          "Prefer": f"resolution={prefer},return=minimal"}),
    )


def delete(path):
    http(f"{SUPABASE_URL}/rest/v1/{path}", method="DELETE",
         headers=_headers({"Prefer": "return=minimal"}))


def in_list(values):
    """PostgREST in.(...) operand, values quoted so commas and spaces survive."""
    return "(" + ",".join('"' + str(v).replace('"', '\\"') + '"' for v in values) + ")"
