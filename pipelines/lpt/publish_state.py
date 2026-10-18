#!/usr/bin/env python3
"""
Publish one of the hub's own states (Michigan, Texas, California) from the
tracker's settled cf_* rows into the Local Politics Tracker project's
<st>_* tables — the bridge in docs/lpt-frontend-plan.md.

    python3 pipelines/lpt/publish_state.py --state tx --dry-run
    python3 pipelines/lpt/publish_state.py --state tx --limit 500
    python3 pipelines/lpt/publish_state.py --state tx

Reads the tracker (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_KEY =
the anon key: every cf_* table is public-read) and writes LPT
(LPT_SUPABASE_URL, default the production project, + LPT_SERVICE_ROLE_KEY).
A dry run reads everything, reports what it would write and writes nothing.

Idempotent: every row keeps the tracker's uuid as its key and is upserted;
races and polls get deterministic uuids (uuid5 of their natural key). Rows
LPT holds for the state that the tracker no longer has are deleted (prune)
unless --limit or --no-prune. The run ends by refreshing LPT's hub caches
for the state (hub_refresh_cache) unless --no-refresh.

Standard library only, like pipelines/load/.
"""

import argparse
import json
import os
import re
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from urllib import error, parse, request

STATE_NAME = {"mi": "michigan", "tx": "texas", "ca": "california"}
LPT_OFFICE = {"state-house": "state-representative"}
OFF_BALLOT = {"withdrawn", "dropped_out", "eliminated", "lost_primary", "disqualified", "not_on_ballot"}
SUFFIXES = {"JR", "JR.", "SR", "SR.", "II", "III", "IV", "V"}
NS = uuid.UUID("6f1e3a9c-2b7d-4c1e-9d3a-5b8f2e7c4a10")  # the hub's namespace for derived ids
BATCH = 500


# ---------------------------------------------------------------------------
# PostgREST, for two projects
# ---------------------------------------------------------------------------

class Rest:
    def __init__(self, url, key, label):
        self.url, self.key, self.label = url.rstrip("/"), key, label

    def _headers(self, extra=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        h.update(extra or {})
        return h

    def http(self, path, data=None, headers=None, method=None, timeout=300, tries=3):
        last = None
        for i in range(tries):
            req = request.Request(f"{self.url}/rest/v1/{path}", data=data,
                                  headers=self._headers(headers), method=method)
            try:
                with request.urlopen(req, timeout=timeout) as r:
                    return r.read()
            except error.HTTPError as ex:
                body = ex.read()[:2000].decode("utf-8", "replace") if ex.fp else ""
                print(f"   {self.label} HTTP {ex.code} {path.split('?')[0]}: {body}", file=sys.stderr, flush=True)
                if ex.code < 500:
                    raise
                last = ex
            except (error.URLError, TimeoutError, ConnectionError) as ex:
                last = ex
            if i + 1 < tries:
                time.sleep(5 * (i + 1))
        raise last

    def get_all(self, path, key="id", page=1000, limit=None):
        """Every row, keyset-paged on `key` (the path must not carry order/limit)."""
        rows, last = [], None
        while True:
            cursor = f"&{key}=gt.{last}" if last is not None else ""
            chunk = json.loads(self.http(f"{path}{cursor}&order={key}.asc&limit={page}"))
            rows.extend(chunk)
            if len(chunk) < page or (limit and len(rows) >= limit):
                return rows[:limit] if limit else rows
            last = chunk[-1][key]

    def get_keyset(self, path, col, page=1000, limit=None):
        """Every row of `path` (a filter + select that includes id and `col`),
        paged on (col desc nulls last, id asc) so each page walks an index on
        (filter, col) instead of sorting every row of the filter — the
        tracker's anon role cancels statements after 3 s. Rows with a null
        `col` come last, paged on id alone."""
        rows, last, nulls = [], None, False
        order = f"{col}.desc.nullslast,id.asc"
        while True:
            if last is None:
                cursor = ""
            elif nulls:
                cursor = f"&{col}=is.null&id=gt.{last['id']}"
            else:
                v, i = last[col], last["id"]
                cursor = f"&or=({col}.lt.{v},and({col}.eq.{v},id.gt.{i}),{col}.is.null)"
            chunk = json.loads(self.http(f"{path}{cursor}&order={order}&limit={page}"))
            rows.extend(chunk)
            if len(chunk) < page or (limit and len(rows) >= limit):
                return rows[:limit] if limit else rows
            last = chunk[-1]
            nulls = last[col] is None

    def rpc(self, fn, args):
        return self.http(f"rpc/{fn}", data=json.dumps(args).encode(),
                         headers={"Content-Type": "application/json"}, timeout=1800)

    def upsert(self, table, rows, conflict):
        for i in range(0, len(rows), BATCH):
            batch = rows[i:i + BATCH]
            keys = sorted({k for r in batch for k in r})
            batch = [{k: r.get(k) for k in keys} for r in batch]
            self.http(f"{table}?on_conflict={parse.quote(conflict)}", data=json.dumps(batch).encode(),
                      headers={"Content-Type": "application/json",
                               "Prefer": "resolution=merge-duplicates,return=minimal"})

    def delete_ids(self, table, col, ids):
        ids = list(ids)
        for i in range(0, len(ids), 200):
            chunk = ",".join('"' + str(v) + '"' for v in ids[i:i + 200])
            self.http(f"{table}?{col}=in.({parse.quote(chunk)})", method="DELETE",
                      headers={"Prefer": "return=minimal"})


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------

def uid(*parts):
    return str(uuid.uuid5(NS, ":".join(str(p) for p in parts)))


def split_name(name):
    parts = [p for p in (name or "").strip().split() if p.upper() not in SUFFIXES]
    if not parts:
        return None, None
    return parts[0], parts[-1]


def filed_name(last, first):
    """'LAST, FIRST' as state filings and LPT carry it; organizations have no first name."""
    last, first = (last or "").strip(), (first or "").strip()
    if last and first:
        return f"{last}, {first}"
    return last or first or None


def person(ctype):
    return (ctype or "").upper() == "INDIVIDUAL"


def year_of(cycle, default=2026):
    m = re.search(r"(20\d\d)", cycle or "")
    return int(m.group(1)) if m else default


def to_lpt_office(office):
    return LPT_OFFICE.get(office, office)


def race_key(st, office, district, year):
    return uid("race", st, to_lpt_office(office), int(district) if district else 0, year)


class Bridge:
    def __init__(self, st, tracker, lpt, limit=None):
        self.st, self.ST, self.p = st, st.upper(), st
        self.tracker, self.lpt, self.limit = tracker, lpt, limit
        self.out = defaultdict(list)   # lpt table -> rows
        self.cands = {}

    # -- read -------------------------------------------------------------
    def candidates(self):
        rows = self.tracker.get_all(f"cf_candidates?state=eq.{self.st}&select=*")
        self.cands = {r["id"]: r for r in rows}
        print(f"   tracker: {len(rows)} candidates")
        return rows

    # The indexed column each table is paged on, per candidate (the tracker
    # has (candidate_id, amount) on contributions and (candidate_id, date)
    # on the others).
    PAGE_COL = {"cf_contributions": "amount", "cf_expenditures": "expenditure_date",
                "cf_independent_expenditures": "expenditure_date", "cf_loans": "loan_date",
                "cf_ie_contributions": "contribution_date"}

    def by_candidate(self, table, col="candidate_id", select="*"):
        rows = []
        for cid in self.cands:
            rows.extend(self.tracker.get_keyset(f"{table}?{col}=eq.{cid}&select={select}", self.PAGE_COL[table], limit=self.limit))
            if self.limit and len(rows) >= self.limit:
                break
        print(f"   tracker: {len(rows)} {table}")
        return rows

    # -- shape ------------------------------------------------------------
    def build(self):
        cands = self.candidates()
        year = 2026
        races = {}
        for c in cands:
            first, last = split_name(c["name"])
            filer = (c.get("filer_refs") or [None])[0]
            filer = filer.split(":", 1)[1] if filer and ":" in filer else filer
            self.out[f"{self.p}_candidates"].append({
                "candidate_id": c["id"], "candidate_name": c["name"],
                "candidate_first_name": first, "candidate_last_name": last,
                "state_id": self.ST, "office": to_lpt_office(c["office"]),
                "party": [c["party"]] if c.get("party") else None,
                "committee_name": [c["committee_name"]] if c.get("committee_name") else None,
                "status": c.get("status"), "title": c.get("title"), "bio": c.get("bio"),
                "photo_url": c.get("photo_url"), "photo_url_large": c.get("photo_url_large"),
                "photo_url_medium": c.get("photo_url_medium"), "photo_url_thumb": c.get("photo_url_thumb"),
                "website": c.get("website"), "featured": bool(c.get("featured")),
                "state_filer_id": filer, "slug": c["slug"],
                "created_at": c.get("created_at"), "updated_at": c.get("updated_at"),
            })
            y = c.get("election_year") or year
            rid = race_key(self.st, c["office"], c.get("district"), y)
            if rid not in races:
                office = to_lpt_office(c["office"])
                num = int(c["district"]) if c.get("district") else 0
                races[rid] = {"race_id": rid, "state_id": self.ST, "office": office, "office_num": num, "year": y,
                              "slug": f"{office}-{num}-{y}" if num else f"{office}-{y}"}
            self.out[f"{self.p}_race_participants"].append({
                "race_id": rid, "state_id": self.ST, "candidate_id": c["id"], "candidate_name": c["name"],
                "on_ballot": (c.get("status") or "active") not in OFF_BALLOT,
                "disposition": c.get("status"), "is_incumbent": None, "party": c.get("party"),
            })
            # Curated fields the admin keeps outside his tables (photos and
            # socials are not in the mirrored candidate shape).
            if any(c.get(k) for k in ("twitter_user", "instagram_user", "facebook_user", "youtube_user")):
                self.out["hub_candidate_overrides"].append({
                    "candidate_id": c["id"], "state_id": self.ST, "slug": c["slug"],
                    "twitter_user": c.get("twitter_user"), "instagram_user": c.get("instagram_user"),
                    "facebook_user": c.get("facebook_user"), "youtube_user": c.get("youtube_user"),
                    "updated_via": "publish_state",
                })
        self.out[f"{self.p}_races"] = list(races.values())
        self.races = races

        for r in self.by_candidate("cf_contributions"):
            c = self.cands[r["candidate_id"]]
            ind = person(r.get("contributor_type"))
            self.out[f"{self.p}_contributions"].append({
                "contribution_id": r["id"], "state_id": self.ST, "committee_id": r.get("committee_id"),
                "committee_name": c.get("committee_name"), "candidate_id": r["candidate_id"], "candidate_name": c["name"],
                "contributor_name": filed_name(r.get("contributor_last_name"), r.get("contributor_first_name")),
                "amount": r.get("amount"), "contribution_date": r.get("contribution_date"),
                "contribution_type": r.get("source_form_type"),
                "contributor_type": "Individual" if ind else "Other organizations",
                "contributor_kind": "individual" if ind else "other_org",
                "contributor_city": r.get("city"), "contributor_state": r.get("state"), "contributor_zip": r.get("zip"),
                "contributor_employer": r.get("employer"), "contributor_occupation": r.get("occupation"),
                "election_year": year_of(r.get("cycle")), "cycle": r.get("cycle"),
                "source_txn_id": r.get("source_txn_id"), "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
                "receipt_type": "contribution",
            })
        for r in self.by_candidate("cf_loans"):
            if r.get("is_guarantor"):
                continue
            c = self.cands[r["candidate_id"]]
            ind = person(r.get("lender_type"))
            self.out[f"{self.p}_contributions"].append({
                "contribution_id": r["id"], "state_id": self.ST, "committee_id": r.get("committee_id"),
                "committee_name": c.get("committee_name"), "candidate_id": r["candidate_id"], "candidate_name": c["name"],
                "contributor_name": filed_name(r.get("lender_last_name"), r.get("lender_first_name")),
                "amount": r.get("amount"), "contribution_date": r.get("loan_date"), "contribution_type": "Loan",
                "contributor_type": "Individual" if ind else "Other organizations",
                "contributor_kind": "individual" if ind else "other_org",
                "election_year": year_of(r.get("cycle")), "cycle": r.get("cycle"),
                "source_txn_id": r.get("source_txn_id"), "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
                "receipt_type": "loan",
            })
        for r in self.by_candidate("cf_expenditures"):
            c = self.cands[r["candidate_id"]]
            self.out[f"{self.p}_expenditures"].append({
                "expenditure_id": r["id"], "state_id": self.ST, "committee_id": r.get("committee_id"),
                "candidate_id": r["candidate_id"], "spender_name": c.get("committee_name") or c["name"],
                "amount": r.get("amount"), "expenditure_date": r.get("expenditure_date"),
                "payee_name": " ".join(p for p in (r.get("payee_first_name"), r.get("payee_last_name")) if p) or None,
                "purpose": r.get("description"), "category": r.get("category"),
                "payee_city": r.get("payee_city"), "payee_state": r.get("payee_state"), "payee_zip": r.get("payee_zip"),
                "election_year": year_of(r.get("cycle")), "cycle": r.get("cycle"), "support_oppose": None,
                "source_txn_id": r.get("source_txn_id"), "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
                "disbursement_type": "operating", "counts_as_spent": True,
            })
        committees = {m["filer_ident"]: m for m in self.tracker.get_all(f"cf_ie_committees?state=eq.{self.st}&select=*", key="filer_ident")}
        print(f"   tracker: {len(committees)} cf_ie_committees")
        for r in self.by_candidate("cf_independent_expenditures", col="target_candidate_id"):
            m = committees.get(r.get("ie_filer_ident")) or {}
            self.out[f"{self.p}_expenditures"].append({
                "expenditure_id": r["id"], "state_id": self.ST, "committee_id": r.get("ie_filer_ident"),
                "candidate_id": r["target_candidate_id"], "spender_name": m.get("name") or f"Filer {r.get('ie_filer_ident')}",
                "amount": r.get("amount"), "expenditure_date": r.get("expenditure_date"), "purpose": r.get("description"),
                "election_year": year_of(r.get("cycle")), "cycle": r.get("cycle"),
                "support_oppose": (r.get("support_oppose") or "").upper()[:1] or None,
                "source_txn_id": r.get("source_txn_id"), "created_at": r.get("created_at"),
                "disbursement_type": "independent_expenditure", "counts_as_spent": False,
            })
        n = 0
        for ident, m in committees.items():
            for r in self.tracker.get_keyset(f"cf_ie_contributions?ie_filer_ident=eq.{parse.quote(ident)}&select=*", self.PAGE_COL["cf_ie_contributions"], limit=self.limit):
                ind = person(r.get("contributor_type"))
                self.out[f"{self.p}_ie_contributions"].append({
                    "id": r["id"], "state_id": self.ST, "committee_id": ident, "committee_name": m.get("name"),
                    "contributor_name": filed_name(r.get("contributor_last_name"), r.get("contributor_first_name")),
                    "contributor_type": "Individual" if ind else "Other organizations",
                    "contributor_kind": "individual" if ind else "other_org",
                    "contributor_employer": r.get("employer"), "contributor_occupation": r.get("occupation"),
                    "contributor_city": r.get("city"), "contributor_state": r.get("state"),
                    "amount": r.get("amount"), "contribution_date": r.get("contribution_date"),
                    "cycle": r.get("cycle"), "source_txn_id": r.get("source_txn_id"),
                })
                n += 1
            if self.limit and n >= self.limit:
                break
        print(f"   tracker: {n} cf_ie_contributions")
        self.polls()

    def polls(self):
        """FiftyPlusOne per-poll rows and the race average, from the tracker."""
        prefix = STATE_NAME[self.st]
        races = self.tracker.get_all(f"races?slug=like.{prefix}-*&select=race_id,slug,year", key="race_id")
        by_surname = defaultdict(dict)   # office -> surname -> candidate_id
        for c in self.cands.values():
            if not c.get("district"):
                _, last = split_name(c["name"])
                by_surname[c["office"]][(last or "").lower()] = c["id"]
        for race in races:
            office = race["slug"][len(prefix) + 1:].rsplit("-", 1)[0]
            year = race.get("year") or 2026
            rid = race_key(self.st, office, None, int(year))
            if rid not in self.races:
                continue
            rows = self.tracker.get_all(
                f"race_polls?race_id=eq.{race['race_id']}&source=eq.fiftyplusone&select=*")
            polls = {}
            for r in rows:
                key = (r.get("pollster"), r.get("field_end"), r.get("matchup") or "general")
                pid = uid("poll", self.st, rid, *key)
                polls.setdefault(pid, {
                    "poll_id": pid, "race_id": rid, "source": r.get("pollster") or "unknown",
                    "poll_date": r.get("field_end"), "sample_size": r.get("sample_size"),
                    "sample_type": r.get("sample_kind"), "margin_of_error": None,
                    "matchup": r.get("matchup") or "general", "source_url": r.get("source_url"),
                })
                _, last = split_name(r.get("candidate_name"))
                self.out[f"{self.p}_race_poll_results"].append({
                    "poll_id": pid, "candidate_id": by_surname[office].get((last or "").lower()),
                    "label": r.get("candidate_name"), "party": r.get("candidate_party"), "pct": r.get("pct"),
                })
            self.out[f"{self.p}_race_polls"].extend(polls.values())
            for a in self.tracker.get_all(
                    f"race_polling?race_id=eq.{race['race_id']}&source=eq.fiftyplusone&select=*"):
                avg = [{"label": x.get("name"), "party": x.get("party"), "pct": x.get("avg_pct"),
                        "candidate_id": by_surname[office].get((split_name(x.get("name"))[1] or "").lower())}
                       for x in ((a.get("raw_data") or {}).get("all_candidates") or [])]
                self.out["hub_poll_averages"].append({
                    "state_id": self.ST, "race_slug": self.races[rid]["slug"], "source": "fiftyplusone",
                    "source_url": a.get("source_url") or a.get("rcp_url"), "as_of": a.get("as_of"),
                    "spread": a.get("spread"), "last_updated": a.get("last_updated"), "averages": avg,
                })
        print(f"   tracker: {len(self.out[self.p + '_race_polls'])} polls, {len(self.out['hub_poll_averages'])} averages")

    # -- write ------------------------------------------------------------
    KEYS = {
        "candidates": "candidate_id", "races": "race_id", "race_participants": "race_id,candidate_id",
        "contributions": "contribution_id", "expenditures": "expenditure_id", "ie_contributions": "id",
        "race_polls": "poll_id", "race_poll_results": "poll_id,label",
    }

    def write(self, dry_run, prune):
        for table, rows in self.out.items():
            if table.startswith(self.p + "_"):
                kind = table[len(self.p) + 1:]
                conflict = self.KEYS[kind]
            elif table == "hub_candidate_overrides":
                conflict = "candidate_id"
            else:
                conflict = "state_id,race_slug"
            print(f"   {'would write' if dry_run else 'writing'} {len(rows):>8} rows -> {table}", flush=True)
            if dry_run:
                continue
            self.lpt.upsert(table, rows, conflict)
        if prune and not dry_run:
            # Children first (poll results, participants), then their parents.
            for kind in ("race_poll_results", "race_polls", "race_participants", "contributions",
                         "expenditures", "ie_contributions", "candidates", "races"):
                table, key = f"{self.p}_{kind}", self.KEYS[kind].split(",")[0]
                if kind == "race_poll_results":
                    continue   # keyed by (poll_id, label); they go with their poll's upsert and are few
                keep = {r[key] for r in self.out[table]}
                have = {r[key] for r in self.lpt.get_all(f"{table}?state_id=eq.{self.ST}&select={key}", key=key)} \
                    if kind not in ("race_polls",) else \
                    {r[key] for r in self.lpt.get_all(f"{table}?select={key}", key=key)
                     if r[key] in keep or True}
                stale = have - keep
                if stale:
                    print(f"   pruning {len(stale)} stale rows from {table}", flush=True)
                    self.lpt.delete_ids(table, key, stale)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--state", required=True, choices=sorted(STATE_NAME))
    ap.add_argument("--dry-run", action="store_true", help="read and report; write nothing")
    ap.add_argument("--limit", type=int, help="first N transaction rows per table (implies --no-prune)")
    ap.add_argument("--no-prune", action="store_true", help="keep LPT rows the tracker no longer has")
    ap.add_argument("--no-refresh", action="store_true", help="skip hub_refresh_cache afterwards")
    a = ap.parse_args(argv)

    t_url = os.environ.get("SUPABASE_URL", "https://lohxdfrxnxuxjdvvyfjc.supabase.co")
    t_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY", "")
    l_url = os.environ.get("LPT_SUPABASE_URL", "https://rwiueylzgcgnzypdyszi.supabase.co")
    l_key = os.environ.get("LPT_SERVICE_ROLE_KEY", "")
    if not t_key:
        sys.exit("Set SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY = the tracker's anon key)")
    if not a.dry_run and not l_key:
        sys.exit("Set LPT_SERVICE_ROLE_KEY to write, or pass --dry-run")

    print(f"== publish {a.state.upper()} -> LPT {'(dry run)' if a.dry_run else ''} {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    b = Bridge(a.state, Rest(t_url, t_key, "tracker"), Rest(l_url, l_key, "lpt"), limit=a.limit)
    b.build()
    b.write(a.dry_run, prune=not (a.no_prune or a.limit))
    if not a.dry_run and not a.no_refresh:
        print("   refreshing hub caches", flush=True)
        b.lpt.rpc("hub_refresh_cache", {"p_states": [a.state.upper()]})
    print("== done")


if __name__ == "__main__":
    main()
