#!/usr/bin/env python3
"""
Run one SLCF state end to end — what each finance-sync.yml matrix job does:

    python3 pipelines/run_state.py oh [--dry-run]

1. SLCF scrape + parse for the state, transactions only, from the year of the
   state's `since` (states.json), without the FEC outside-spending pull:
       pipelines/slcf/src/main.py --daemon --no-report sync OH --start-year 2025
           --no-aggregate --no-fec-ie --transactions [slcf_args...]
   The loader needs only the transaction tables; the committee and candidate
   sweeps are slow in several states and nothing here reads them, so SLCF's
   own validation reports those two tables empty — expected, and ignored.
2. A check of what SLCF wrote. SLCF's CLI exits 0 even when a state fails
   (orc prints "1 state(s) failed" and returns), so success is judged here:
   the cleaned contributions file must exist and hold rows.
3. pipelines/load/load_cf.py --state XX [--dry-run --report ...].

A state with `soft_fail` in states.json reports a failure as a warning and
exits 0, as the pilot importer does for Kansas.
"""

import argparse
import subprocess
import sys
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


def sync(st, entry):
    if entry.get("playwright"):
        if run([sys.executable, "-m", "playwright", "install", "--with-deps", "chromium"]):
            raise RuntimeError("playwright install failed")
    start_year = load_cf.since_of(entry)[:4]
    run([sys.executable, str(PIPELINES / "slcf" / "src" / "main.py"), "--daemon", "--no-report",
         "sync", st.upper(), "--start-year", start_year, "--no-aggregate", "--no-fec-ie",
         "--transactions", *entry.get("slcf_args", [])], cwd=PIPELINES / "slcf")
    clean_dir = load_cf.cleaned_dir(st, load_cf.SLCF_DATA)
    n = cleaned_rows(clean_dir, "contributions")
    if not n:
        raise RuntimeError(f"SLCF wrote no contributions for {st.upper()} — the scrape or "
                           f"parse failed; see the log above")
    print(f"   SLCF: {n:,} contributions in {clean_dir}", flush=True)


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
        sync(st, entry)
        load_args = ["--state", st]
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
