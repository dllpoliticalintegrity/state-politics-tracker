#!/usr/bin/env python3
"""
Field-by-field comparison of what the loader would write for a state with the
live cf_* rows that share an id — the check before a cutover that a merge
upsert won't rewrite names, types or categories the site shows.

    SUPABASE_URL=... SUPABASE_KEY=<anon key> \\
        python3 pipelines/load/compare_fields.py --state co [--slug phil-weiser]

Reads the state's SLCF cleaned output (run the SLCF sync first) and, per
cf_* table, counts the rows whose value differs in each column, with a few
examples. Reads only public tables; writes nothing. --slug limits it to one
candidate (the big campaigns take a minute each to read).
"""

import argparse
import collections
import sys

import load_cf
import rest

FIELDS = {
    "cf_contributions": ["contributor_type", "contributor_first_name", "contributor_last_name",
                         "employer", "occupation", "city", "state", "zip",
                         "contribution_date", "source_form_type", "amount"],
    "cf_expenditures": ["payee_last_name", "payee_first_name", "category", "description",
                        "payee_city", "payee_state", "payee_zip", "expenditure_date", "amount"],
    "cf_loans": ["lender_type", "lender_last_name", "lender_first_name", "loan_date", "amount"],
}


def norm(f, v):
    if v in ("", None):
        return None
    if f == "amount":
        return round(float(v), 2)
    return v


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--slug", action="append", help="only these candidates (repeatable)")
    ap.add_argument("--examples", type=int, default=4)
    args = ap.parse_args(argv)
    st = args.state.lower()
    entry = load_cf.manifest_entry(st)
    refs = load_cf.candidate_refs(st)
    clean = load_cf.cleaned_dir(st, load_cf.SLCF_DATA)
    if clean is None:
        sys.exit(f"{st}: no SLCF cleaned data — run the SLCF sync first")
    want = set(args.slug or [s for _, s in refs.values()])

    new = collections.defaultdict(dict)
    for t, slug, r in load_cf.rows_for_state(st, entry, clean, refs):
        if slug in want:
            new[t][r["source_txn_id"]] = r

    for t, fields in FIELDS.items():
        diff, ex, compared = collections.Counter(), collections.defaultdict(list), 0
        for cid, slug in sorted(set(refs.values())):
            if slug not in want:
                continue
            live = rest.get_keyset(
                f"{t}?select=id,source_txn_id,{','.join(f for f in fields if f != 'amount')},amount"
                f"&source=eq.slcf&candidate_id=eq.{cid}",
                by_amount=t == "cf_contributions")
            for row in live:
                n = new[t].get(row["source_txn_id"])
                if n is None:
                    continue
                compared += 1
                for f in fields:
                    a, b = norm(f, row.get(f)), norm(f, n.get(f))
                    if a != b:
                        diff[f] += 1
                        if len(ex[f]) < args.examples:
                            ex[f].append((a, b))
        print(f"{t}: {compared} rows with the same id")
        for f, c in diff.most_common():
            print(f"   {f:24} {c:7}  live -> slcf e.g. {ex[f]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
