#!/usr/bin/env python3
"""
Run one SLCF state end to end — what each finance-sync.yml matrix job does:

    python3 pipelines/run_state.py oh [--dry-run]

1. SLCF scrape + parse for the state, transactions only, from the year of the
   state's `since` (states.json), without the FEC outside-spending pull:
       pipelines/slcf/src/main.py --no-report sync OH --start-year 2025
           --no-aggregate [--no-fec-ie] --transactions [--entities] [slcf_args...]
   (not --daemon: that silences the scrapers' own messages, and a blocked
   source's "HTTP Error 403" then shows only in the log.jsonl artifact)
   The loader needs only the transaction tables; the committee and candidate
   sweeps are slow in several states and nothing here reads them, so SLCF's
   own validation reports those two tables empty — expected, and ignored.
2. A check of what SLCF wrote. SLCF's CLI exits 0 even when a state fails
   (orc prints "1 state(s) failed" and returns), so success is judged here:
   the cleaned contributions file must exist and hold rows.
3. pipelines/load/load_cf.py --state XX [--dry-run --report ...].

A state with `soft_fail` in states.json reports a failure as a warning and
exits 0, as the pilot importer does for Kansas.

Prune guard: a scraper that loses a file or a date window logs the error and
carries on (Wisconsin skips a window that fails all retries), so a run can
look complete while a month is missing — and the loader's prune would delete
that month's live rows. When the run's log holds any scrape error, the load
goes ahead without prune, with a warning; the next clean run prunes.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

PIPELINES = Path(__file__).resolve().parent
sys.path.insert(0, str(PIPELINES / "load"))
import load_cf  # noqa: E402  (reuses the manifest and cleaned-dir lookups)


def run(cmd, **kw):
    print("$ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, **kw).returncode


def cleaned_rows(clean_dir, table):
    reader = load_cf.open_table(clean_dir, table) if clean_dir else None
    if reader is None:
        return 0
    return sum(1 for _ in reader)


def scrape_errors(run_id):
    """file_download / page_scrape errors in SLCF's log for this run."""
    log = PIPELINES / "slcf" / "logs" / "prod" / run_id / "log.jsonl"
    if not log.exists():
        return ["no SLCF run log at " + str(log)]
    errors = []
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("operation") == "scrape" and ev.get("status") == "error":
            errors.append(f"{ev.get('filename') or ev.get('entity') or '?'}: {ev.get('error', '')}")
    return errors


def sync(st, entry):
    """Run SLCF for the state; return the run's scrape errors."""
    if entry.get("playwright"):
        if run([sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"]):
            raise RuntimeError("playwright install failed")
    start_year = load_cf.since_of(entry)[:4]
    # A known run id, so this run's log can be read back (orc keeps one that
    # is already set; logs/prod/<run id>/log.jsonl).
    run_id = f"run_state_{st}_{time.strftime('%Y%m%d_%H%M%S')}"
    env = dict(os.environ, CF_RUN_ID=run_id)
    env.pop("CF_DAEMON", None)
    # "ie": entities too, so committees.csv (and SLCF's registry enrichment)
    # exist for the outside-spending stage; "fec_ie": keep SLCF's FEC
    # nonfederal-IE enrichment on (Ohio), which reads FEC_API_KEY from the env.
    scope = ["--transactions", "--entities"] if entry.get("ie") else ["--transactions"]
    fec = [] if entry.get("fec_ie") else ["--no-fec-ie"]
    run([sys.executable, str(PIPELINES / "slcf" / "src" / "main.py"), "--no-report",
         "sync", st.upper(), "--start-year", start_year, "--no-aggregate", *fec,
         *scope, *entry.get("slcf_args", [])], cwd=PIPELINES / "slcf", env=env)
    clean_dir = load_cf.cleaned_dir(st, load_cf.SLCF_DATA)
    n = cleaned_rows(clean_dir, "contributions")
    if not n:
        raise RuntimeError(f"SLCF wrote no contributions for {st.upper()} — the scrape or "
                           f"parse failed; see the log above")
    print(f"   SLCF: {n:,} contributions in {clean_dir}", flush=True)
    return scrape_errors(run_id)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run one SLCF state: sync, check, load.")
    ap.add_argument("state")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", help="reconciliation CSV path (dry run)")
    args = ap.parse_args(argv)
    st = args.state.lower()
    entry = load_cf.manifest_entry(st)
    if not args.dry_run and entry["pipeline"] != "slcf":
        sys.exit(f"{st}: pipeline is '{entry['pipeline']}', not slcf — "
                 f"only a --dry-run runs SLCF for it")
    if not args.dry_run and entry.get("dry_run_only"):
        sys.exit(f"{st}: dry_run_only in states.json — run with --dry-run")
    try:
        errors = sync(st, entry)
        load_args = ["--state", st]
        if errors and not args.dry_run:
            print(f"::warning::{st}: {len(errors)} scrape error(s) — loading without prune "
                  f"this run, so a missing file can't delete live rows. First: {errors[0]}",
                  flush=True)
            load_args.append("--no-prune")
        if args.dry_run:
            load_args.append("--dry-run")
        if args.report:
            load_args += ["--report", args.report]
        rc = load_cf.main(load_args)
        if rc:
            raise RuntimeError(f"loader exited {rc}")
    except (Exception, SystemExit) as ex:  # noqa: BLE001 — soft-fail decides below
        if isinstance(ex, SystemExit) and ex.code in (0, None):
            return 0
        reason = entry.get("soft_fail")
        if reason:
            print(f"::warning::{st} skipped — {reason} ({ex})", flush=True)
            return 0
        print(f"::error::{st}: {ex}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
