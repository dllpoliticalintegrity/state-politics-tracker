#!/usr/bin/env python3
"""
Load one state's SLCF output into the cf_* tables the site reads.

    python3 pipelines/load/load_cf.py --state co [--dry-run] [--report out.csv]

Reads pipelines/slcf/data/<State>/cleaned/{contributions,expenditures,
loans_debts}.csv(.gz) — written by `pipelines/slcf/src/main.py sync <ST>` —
and keeps the rows of committees tracked on the site:

  * committee -> candidate comes from cf_candidates.filer_refs ("co:<CO_ID>"),
    the same refs the pilot importer keeps in step with its COMMITTEES map.
    Nothing else decides which money a candidate gets.
  * rows dated before the state's `since` (pipelines/states.json; default
    1 January of the year before the cycle) are skipped, as the pilot does.
  * rows SLCF marks `superseded` (replaced by a later amendment) are skipped.

Ids: the source's transaction id where SLCF carries one, formatted per state
so it can match the pilot's existing source_txn_id; a deterministic hash
otherwise (mapping.TxnIds). Rows upsert on (source, source_txn_id) with
source = 'slcf' — the value every pilot row already has.

--dry-run writes nothing. It compares what would load with the live cf_*
rows for the same candidates (rows, dollars, date range, and how many of the
ids already exist) — the reconciliation the cutover of a pilot state needs.
Reads only public tables, so SUPABASE_KEY may be the anon key.

The loader never refreshes the matviews; the workflow does that once at the
end of the run.
"""

import argparse
import csv
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

import ie
import mapping
import roster
import rest

PIPELINES = Path(__file__).resolve().parents[1]
MANIFEST = PIPELINES / "states.json"
SLCF_DATA = PIPELINES / "slcf" / "data"
STATES_CSV = PIPELINES / "slcf" / "src" / "aliases" / "states.csv"
TABLES = ("contributions", "expenditures", "loans_debts")
DATE_COL = {"cf_contributions": "contribution_date", "cf_expenditures": "expenditure_date",
            "cf_loans": "loan_date"}
BATCH = 1000
PRUNE_MIN_SHARE = 0.9


def manifest_entry(st):
    states = json.loads(MANIFEST.read_text())["states"]
    if st not in states:
        sys.exit(f"{st}: not in {MANIFEST.name}")
    return states[st]


def since_of(entry):
    return entry.get("since") or f"{int(entry.get('cycle', '2026')) - 1}-01-01"


def cleaned_dir(st, data_dir):
    """SLCF's own lookup (utils.resolve_clean_dir): data/<State name>, with
    underscores or spaces, matched case-insensitively."""
    names = {r["abbr"].lower(): r["name"] for r in csv.DictReader(STATES_CSV.open())}
    want = " ".join(names.get(st, st).lower().split())
    for d in sorted(Path(data_dir).iterdir()) if Path(data_dir).exists() else []:
        if d.is_dir() and " ".join(d.name.replace("_", " ").lower().split()) == want:
            if (d / "cleaned").is_dir():
                return d / "cleaned"
    return None


def open_table(clean_dir, table):
    for name, opener in ((f"{table}.csv.gz", gzip.open), (f"{table}.csv", open)):
        p = clean_dir / name
        if p.exists():
            return csv.DictReader(opener(p, "rt", encoding="utf-8", newline=""))
    return None


def candidate_refs(st):
    """{"co:<id>": (candidate uuid, slug)} from cf_candidates.filer_refs."""
    rows = rest.get_all(f"cf_candidates?state=eq.{st}&select=id,slug,filer_refs&order=id")
    refs = {}
    for c in rows:
        for ref in c.get("filer_refs") or []:
            if isinstance(ref, str) and ref.startswith(f"{st}:"):
                if ref in refs and refs[ref][1] != c["slug"]:
                    print(f"   warning: {ref} is on both {refs[ref][1]} and {c['slug']}; "
                          f"its money loads to {refs[ref][1]}", flush=True)
                refs.setdefault(ref, (c["id"], c["slug"]))
    return refs


def is_flag_set(v):
    return (v or "").strip().lower() in ("1", "y", "yes", "true")


def _report_key(r):
    s = (r or "").strip()
    return (0, int(s), "") if s.isdigit() else (1, 0, s)


def rereport_latest(clean_dir, refs, st):
    """For states whose filing_id is the report a receipt came on
    (states.json "rereports"): {gift: latest report} for every gift (same
    committee, contributor, amount, date) listed on more than one report.
    A pre-election 24-hour report and the regular report that follows both
    list the same gift (Alaska: Claire Zabel's $90,000 to Kreiss-Tomkins on
    2026-08-11, once bare, once with address and employer; Wisconsin's late
    contribution reports); only the latest report's copy is kept. Identical
    rows on one report are separate gifts and all stay."""
    reports = defaultdict(set)
    for row in open_table(clean_dir, "contributions") or []:
        fid = (row.get("state_filer_id") or "").strip()
        if not fid or f"{st}:{fid}" not in refs:
            continue
        reports[gift_key(row)].add((row.get("filing_id") or "").strip())
    return {k: max(v, key=_report_key) for k, v in reports.items() if len(v) > 1 and all(v)}


def gift_key(row):
    return ((row.get("state_filer_id") or "").strip(),
            " ".join((row.get("contributor_name") or "").upper().split()),
            mapping.money(row.get("amount")), mapping.iso_date(row.get("date")))


def rows_for_state(st, entry, clean_dir, refs):
    """Yield (cf_table, slug, row) for every tracked row, with its ids and
    candidate set."""
    since = since_of(entry)
    cycle = entry.get("cycle", "2026")
    ids = mapping.TxnIds(st, entry.get("id_format"))
    individual_types = entry.get("individual_types")
    category_field = entry.get("category_field", "category")     # null = no category
    inkind_types = {v.lower() for v in entry.get("inkind_types", [])}
    entity_words = entry.get("entity_words")
    type_from_name_parts = bool(entry.get("type_from_name_parts"))
    unitemized = entry.get("unitemized")
    # skip_types: per SLCF table, transaction types the pilot never imported
    # (AL's Other Receipts extract: bank interest, vendor refunds).
    skip_types = {t: {v.lower() for v in vs} for t, vs in entry.get("skip_types", {}).items()}
    # loan_records: loans_debts record types the pilot imported as
    # contributions or expenditures (mapping.loan_record_target).
    loan_records = {k.strip().lower(): v for k, v in entry.get("loan_records", {}).items()}
    bad = {v for v in loan_records.values() if v not in mapping.LOAN_RECORD_TABLES}
    if bad:
        raise SystemExit(f"{st}: loan_records maps to {sorted(bad)}; "
                         f"use one of {mapping.LOAN_RECORD_TABLES}")
    seen = set()
    counts = defaultdict(int)
    latest = rereport_latest(clean_dir, refs, st) if entry.get("rereports") else {}
    for table in TABLES:
        reader = open_table(clean_dir, table)
        if reader is None:
            if table == "loans_debts":
                continue                     # not every state publishes loans
            raise SystemExit(f"{st}: {table} missing from {clean_dir}")
        if "state_filer_id" not in (reader.fieldnames or []):
            raise SystemExit(f"{st}: {table} has no state_filer_id column — "
                             f"re-run the SLCF parser (columns.py, TRANSACTION_IDS)")
        for row in reader:
            fid = (row.get("state_filer_id") or "").strip()
            hit = refs.get(f"{st}:{fid}") if fid else None
            t = table
            if hit and table == "loans_debts":
                target = mapping.loan_record_target(row, loan_records)
                if target:
                    t, row = target, mapping.loan_record_as(target, row)
            # The id is assigned before any filtering below, so a row's hashed
            # id doesn't depend on which of its twins were filtered out.
            txn = ids.make(t, row) if hit else None
            if not hit:
                continue
            if is_flag_set(row.get("superseded")):
                counts["superseded"] += 1
                continue
            if latest and table == "contributions":
                want = latest.get(gift_key(row))
                if want is not None and (row.get("filing_id") or "").strip() != want:
                    counts["rereported"] += 1
                    continue
            if "FEC_NONFEDERAL_IE" in (row.get("transaction_type"), row.get("category")):
                continue                     # FEC outside spending, not the committee's own
            if (row.get("transaction_type") or "").strip().lower() in skip_types.get(t, ()):
                counts["skip_type"] += 1
                continue
            date = mapping.iso_date(row.get("date"))
            if not date or date < since:
                counts["before_since"] += 1
                continue
            out = mapping.to_cf(t, row, individual_types, category_field, unitemized,
                                loan_record=t != table, inkind_types=inkind_types,
                                entity_words=entity_words,
                                type_from_name_parts=type_from_name_parts)
            if out is None:
                counts["unmapped"] += 1
                continue
            cf_table, rec = out
            if (cf_table, txn) in seen:      # overlapping source files repeat a row
                counts["duplicate_id"] += 1
                continue
            seen.add((cf_table, txn))
            cand_id, slug = hit
            rec.update({"candidate_id": cand_id, "committee_id": f"{st}:{fid}",
                        "source_txn_id": txn, "cycle": cycle, "source": "slcf"})
            yield cf_table, slug, rec
    print(f"   skipped: {dict(counts)}", flush=True)


def new_stat():
    # ids: source_txn_id -> (amount, date)
    return {"rows": 0, "dollars": 0.0, "min": None, "max": None, "ids": {}}


def add(stat, amount, date, txn=None):
    stat["rows"] += 1
    stat["dollars"] += amount or 0
    if date:
        stat["min"] = min(stat["min"] or date, date)
        stat["max"] = max(stat["max"] or date, date)
    if txn:
        stat["ids"][txn] = (amount or 0, date)


def live_stats(st, refs):
    """The live cf_* rows (source 'slcf') of the same candidates, per
    (slug, table) — what a dry run reconciles against."""
    stats = defaultdict(new_stat)
    for cid, slug in sorted(set(refs.values())):
        for cf_table, dcol in DATE_COL.items():
            rows = rest.get_keyset(
                f"{cf_table}?select=id,source_txn_id,amount,{dcol}"
                f"&source=eq.slcf&candidate_id=eq.{cid}",
                by_amount=cf_table == "cf_contributions")
            for r in rows:
                add(stats[(slug, cf_table)], float(r["amount"] or 0), r[dcol],
                    r["source_txn_id"])
    return stats


def stale_ids(new, live, since):
    """Live rows in the loaded window whose id SLCF no longer has: superseded
    by an amendment, or deleted at the source. (slug, table) -> {id: amount}.
    Rows dated before `since` (or undated) are outside what a run reloads and
    are never stale."""
    out = {}
    for k, lv in live.items():
        loaded = new.get(k, new_stat())["ids"]
        out[k] = {t: a for t, (a, d) in lv["ids"].items()
                  if t not in loaded and d and d >= since}
    return out


def write_report(path, new, live, since):
    keys = sorted(set(new) | set(live))
    stale = stale_ids(new, live, since)
    fields = ["slug", "table", "slcf_rows", "live_rows", "slcf_dollars", "live_dollars",
              "dollar_diff_pct", "ids_already_live", "new_rows", "new_dollars",
              "stale_live_rows", "stale_live_dollars", "amount_changed_rows",
              "slcf_min_date", "slcf_max_date", "live_min_date", "live_max_date"]
    out = []
    for k in keys:
        n, lv = new.get(k, new_stat()), live.get(k, new_stat())
        diff = ((n["dollars"] - lv["dollars"]) / lv["dollars"] * 100) if lv["dollars"] else None
        both = n["ids"].keys() & lv["ids"].keys()
        only_new = n["ids"].keys() - lv["ids"].keys()
        st = stale.get(k, {})
        out.append({
            "slug": k[0], "table": k[1], "slcf_rows": n["rows"], "live_rows": lv["rows"],
            "slcf_dollars": round(n["dollars"], 2), "live_dollars": round(lv["dollars"], 2),
            "dollar_diff_pct": None if diff is None else round(diff, 2),
            "ids_already_live": len(both),
            "new_rows": len(only_new),
            "new_dollars": round(sum(n["ids"][t][0] for t in only_new), 2),
            "stale_live_rows": len(st), "stale_live_dollars": round(sum(st.values()), 2),
            "amount_changed_rows": sum(1 for t in both
                                       if abs(n["ids"][t][0] - lv["ids"][t][0]) > 0.005),
            "slcf_min_date": n["min"], "slcf_max_date": n["max"],
            "live_min_date": lv["min"], "live_max_date": lv["max"],
        })
    if path:
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(out)
    print(f"   {'slug':<24} {'table':<16} {'slcf rows':>9} {'live rows':>9} "
          f"{'slcf $':>12} {'live $':>12} {'diff %':>7} {'new':>5} {'stale':>5} "
          f"{'stale $':>10} {'amt chg':>7}")
    for r in out:
        d = "" if r["dollar_diff_pct"] is None else f"{r['dollar_diff_pct']:.2f}"
        print(f"   {r['slug']:<24} {r['table']:<16} {r['slcf_rows']:>9} {r['live_rows']:>9} "
              f"{r['slcf_dollars']:>12,.0f} {r['live_dollars']:>12,.0f} {d:>7} "
              f"{r['new_rows']:>5} {r['stale_live_rows']:>5} "
              f"{r['stale_live_dollars']:>10,.0f} {r['amount_changed_rows']:>7}")
    return out


def prune(st, refs, new, live, since, min_share=PRUNE_MIN_SHARE):
    """Delete the stale live rows (see stale_ids) after a complete load.

    Refuses when the load looks truncated — fewer rows than min_share
    (PRUNE_MIN_SHARE, or the state's `prune_min_share` for a first run that
    removes many duplicates) of what is live in the window — since a cut-off
    download would otherwise delete real money. Deletes filter on source = 'slcf' and the
    candidate, so Texas's 'tec' rows and other states can never be touched."""
    live_in_window = sum(1 for lv in live.values() for _, d in lv["ids"].values()
                         if d and d >= since)
    loaded = sum(v["rows"] for v in new.values())
    if live_in_window and loaded < min_share * live_in_window:
        raise SystemExit(f"{st}: refusing to prune — loaded {loaded} rows, "
                         f"{live_in_window} live in the window (< {min_share:.0%})")
    by_slug = {slug: cid for cid, slug in refs.values()}
    removed = defaultdict(int)
    for (slug, cf_table), ids in stale_ids(new, live, since).items():
        ids = sorted(ids)
        for i in range(0, len(ids), 200):
            rest.delete(f"{cf_table}?source=eq.slcf&candidate_id=eq.{by_slug[slug]}"
                        f"&source_txn_id=in.{rest.in_list(ids[i:i + 200])}")
        removed[cf_table] += len(ids)
    print(f"   pruned stale rows: {dict(removed)}", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    ap.add_argument("--state", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", help="write the reconciliation CSV here (dry run or prune)")
    ap.add_argument("--data-dir", default=str(SLCF_DATA))
    ap.add_argument("--resolution", choices=("merge", "ignore"), default="merge")
    ap.add_argument("--prune", action=argparse.BooleanOptionalAction, default=None,
                    help="after loading, delete live rows in the window that SLCF no "
                         "longer has (default: the state's `prune` in states.json)")
    ap.add_argument("--prune-ie", action=argparse.BooleanOptionalAction, default=None,
                    help="prune the outside-spending tables too (default: same as --prune); "
                         "run_state.py passes --no-prune-ie when only an IE file failed")
    args = ap.parse_args(argv)
    st = args.state.lower()

    if not rest.SUPABASE_URL or not rest.KEY:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY "
                 "(or SUPABASE_KEY = the anon key, for --dry-run)")
    entry = manifest_entry(st)
    since = since_of(entry)
    do_prune = entry.get("prune", False) if args.prune is None else args.prune
    do_prune_ie = do_prune if args.prune_ie is None else (do_prune and args.prune_ie)
    clean_dir = cleaned_dir(st, args.data_dir)
    if clean_dir is None:
        sys.exit(f"{st}: no SLCF cleaned data under {args.data_dir} — run "
                 f"`python3 pipelines/slcf/src/main.py sync {st.upper()}` first")

    # Legislative roster from LPT (states.json "lpt_roster"), before the refs
    # are read so new candidates' money loads on this same run (roster.py).
    if entry.get("lpt_roster"):
        def scrape_rows():
            for table in ("contributions", "expenditures"):
                for row in open_table(clean_dir, table) or []:
                    yield row
        roster.sync_state(st, scrape_rows(), dry_run=args.dry_run,
                          committees=list(open_table(clean_dir, "committees") or []),
                          statewide_offices=entry.get("lpt_statewide") or (),
                          unconfirmed_offices=entry.get("lpt_unconfirmed") or ())

    refs = candidate_refs(st)
    print(f"== loading {st} from {clean_dir} ({len(refs)} tracked committees, "
          f"since {since}{', dry run' if args.dry_run else ''}"
          f"{', prune' if do_prune and not args.dry_run else ''}) ==", flush=True)
    if not refs:
        print(f"   {st}: no cf_candidates.filer_refs — nothing to load")
        return 0

    # What is live before this run writes anything. The prune guard and the
    # stale rows are judged against it: read after the upsert, a hashed-id
    # state's first run would count its new rows beside the pilot's (twice
    # the live rows, so the guard refuses and both copies stay live).
    live = live_stats(st, refs) if (args.dry_run or do_prune or args.report) else None

    stats = defaultdict(new_stat)
    batches = defaultdict(list)
    totals = defaultdict(int)
    for cf_table, slug, rec in rows_for_state(st, entry, clean_dir, refs):
        add(stats[(slug, cf_table)], rec["amount"], rec.get(DATE_COL[cf_table]),
            rec["source_txn_id"])
        totals[cf_table] += 1
        if args.dry_run:
            continue
        batches[cf_table].append(rec)
        if len(batches[cf_table]) >= BATCH:
            rest.upsert(cf_table, batches[cf_table], resolution=args.resolution)
            batches[cf_table].clear()
    for cf_table, rows in batches.items():
        rest.upsert(cf_table, rows, resolution=args.resolution)
    print(f"   {'would load' if args.dry_run else 'loaded'}: {dict(totals)}", flush=True)

    if live is not None:
        write_report(args.report, stats, live, since)
        if do_prune and not args.dry_run:
            prune(st, refs, stats, live, since,
                  entry.get("prune_min_share", PRUNE_MIN_SHARE))

    # Outside spending (states.json "ie": true): independent expenditures
    # targeting the tracked candidates, their spenders and the spenders'
    # receipts -> cf_ie_* (pipelines/load/ie.py). Needs committees.csv, so
    # run_state scrapes entities as well for these states.
    if entry.get("ie"):
        cands = rest.get_all(f"cf_candidates?state=eq.{st}&select=id,slug,name,committee_name&order=id")
        ie.load_ie(st, entry, clean_dir, cands, args.dry_run, since, entry.get("cycle", "2026"),
                   mapping.TxnIds(st, entry.get("id_format")), open_table,
                   do_prune=do_prune_ie, min_share=entry.get("prune_min_share", PRUNE_MIN_SHARE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
