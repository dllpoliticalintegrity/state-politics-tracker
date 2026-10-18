"""
ops/daemon.py — scheduling wrapper for the pipeline.

Runs each state through the full pipeline (with fallback), then pushes that
state (with --live, to R2 and Supabase) and refreshes the dashboard views
before the next state starts, so a slow or stuck state does not hold back
the ones before it. A live run sends one pipeline email and one push email
at the end. Called from cron (ops/crontab) with --live, one line per night;
can also be run by hand.

AGGREGATION IS CURRENTLY PAUSED (see AGGREGATE_ENABLED below): the combined
master data/state-level-cf.db is not rebuilt and not pushed to R2 by this
script right now. Per-state data/pushes are unaffected. Flip
AGGREGATE_ENABLED to True to restore both.

Usage:
    python3 ops/daemon.py GA MI --live            # what cron runs
    python3 ops/daemon.py GA MI                   # dry run: nothing written
    python3 ops/daemon.py OH --local              # the local database
    python3 ops/daemon.py OH --live --start-year 2025
    python3 ops/daemon.py TX --skip-push          # collect only
    python3 ops/daemon.py --reparse AZ --live

Without --live or --local the push is a dry run: each state is collected,
its rows are built and the totals check is printed against the live
project; nothing is written to R2 or a database, the views are not
refreshed and no email is sent.

--live          push to R2 and the live database, refresh the live views,
                update the status page and send both emails.
--local         push to Supabase running on this machine (`supabase start
                --workdir cloud/supabase`, from serving/) and refresh its
                views. No R2, no status page, no emails. Checks first that
                the database is up. CF_DB_TARGET=local in the environment
                does the same. Push events carry target "local", so
                ops/nothing_ran_check.py does not count the run as new data
                on the site.
--start-year / --end-year YYYY
                passed to the sync (the scrapers' year window).
--skip-push     collect only; no push and no dry run.
--reparse       reparse instead of sync.

One run folder per call: logs/daemon/{YYYYMMDD_HHMMSS}_{command}_{STATES}/.
Every main.py call and every push writes its events to that folder's
log.jsonl (orc.py keeps a CF_RUN_ID that is already set).

Exit codes:
    0  — at least one state produced usable data (fresh or restored)
    1  — no state produced usable data (nothing pushed), or the aggregate
         failed while AGGREGATE_ENABLED is on
"""

import csv
import os
import subprocess
import sys
import time
from pathlib import Path

# Bootstrap: make project root importable before anything else
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# 2026-09-19: cloud/ moved under serving/ (serving/cloud/) so it can live in
# its own git repo alongside serving/web/ -- src/ stays put, so the root
# insert above still covers `from src... import`, but `cloud` itself is no
# longer a top-level package from PROJECT_ROOT alone, hence this second
# entry. See serving/cloud/r2/_shared.py's own module docstring.
_SERVING_ROOT = _PROJECT_ROOT / "serving"
if str(_SERVING_ROOT) not in sys.path:
    sys.path.insert(0, str(_SERVING_ROOT))

from src.run_helpers import PROJECT_ROOT, generate_report
from ops import emailer

PYTHON = sys.executable

# Aggregation (the combined master data/state-level-cf.db across all
# states) and its R2 push are paused project-wide. True runs
# src/pipeline/aggregate.py once after every state's pipeline, then pushes
# the master db to R2; per-state pipelines and pushes are the same either
# way.
AGGREGATE_ENABLED = False


def _run(*cmd: str) -> int:
    return subprocess.run(list(cmd), cwd=PROJECT_ROOT).returncode


def _unrestorable_states(run_dir) -> set[str]:
    """Abbreviations that failed this run AND could not be restored from the
    last good copy (main.py's fallback_summary events, `fallback_fail`; the
    run has one per state, and the result is their union).
    A state that failed and WAS restored is fine to push: its local data is
    the last version that passed. One in this set has only the failed run's
    output on disk (or nothing), so it must not be published. Empty set when
    the run has no fallback_summary (older runs, or a crash before it)."""
    out: set[str] = set()
    try:
        import json
        with open(Path(run_dir) / "log.jsonl", encoding="utf-8") as f:
            for line in f:
                if '"fallback_summary"' in line:
                    out |= {a.upper() for a in json.loads(line).get("fallback_fail", [])}
    except Exception as e:
        print(f"\n[!] Could not read fallback results from {run_dir}: {e}")
    return out


def _abbr_to_name() -> dict[str, str]:
    """{abbr: full name} from src/aliases/states.csv (e.g. 'NH' -> 'New
    Hampshire'), used to resolve state_abbrs into the (abbr, name) pairs
    push_state() takes.

    2026-09-19: own copy, not imported from anywhere -- this used to be
    handled inside cloud/dispatch.py's push(), called from here via
    dispatch.push(state_abbrs, backend=r2/supabase_backend, ...). Now that
    dispatch.py is retired (see cloud/r2/r2.py's module docstring), the
    push loop lives directly in run() below and needs its own name lookup.
    Deliberately duplicated rather than centralized -- cloud/r2/r2.py and
    cloud/r2/regenerate_manifest.py each keep their own copy of this same
    small function too; not enough other shared material between the
    cloud/ backends and ops/ to justify a new shared module for it."""
    states_csv = PROJECT_ROOT / "src" / "aliases" / "states.csv"
    if not states_csv.exists():
        return {}
    with open(states_csv, encoding="utf-8") as f:
        return {row["abbr"].strip().upper(): row["name"].strip() for row in csv.DictReader(f)}


def _new_run_id(command: str, state_abbrs: list[str]) -> str:
    """Same shape as orc.py's run ids, so emailer.py and log_report.py read
    the folder the same way."""
    ts = time.strftime("%Y%m%d_%H%M%S")
    return f"{ts}_{command}_{'-'.join(a.upper() for a in state_abbrs)}"


def _backends(mode: str):
    """(r2, supabase) modules for a push in `mode` ('live', 'local' or 'dry').
    Supabase writes only for 'live' and 'local'; a dry run builds the rows and
    prints the totals check against the live project without writing.
    Imported here, not at the top: a --skip-push run does not need them."""
    from cloud.r2 import r2
    from cloud.supabase import _shared as supabase_shared
    from cloud.supabase import supabase as supabase_backend
    supabase_shared.set_target("local" if mode == "local" else "live")
    # supabase.py sets LIVE from its own CLI; in-process it is set here.
    supabase_backend.LIVE = mode in ("live", "local")
    return r2, supabase_backend


def _local_db_is_up() -> bool:
    """True when local Supabase answers on its API port. Any HTTP reply
    counts (the API answers 401 without a key); only a refused or timed-out
    connection means it is down."""
    import urllib.error
    import urllib.request
    url = os.environ.get("CF_LOCAL_SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
    try:
        urllib.request.urlopen(url + "/rest/v1/", timeout=5)
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False
    return True


def _refresh_views(local: bool) -> None:
    """Refreshes the dashboard materialized views. Every page reads its
    totals from them, so without this a push leaves the site on the old
    numbers. Runs from serving/, the way the tool is run by hand. A failure
    is printed and does not stop the run."""
    cmd = [PYTHON, "cloud/supabase/tools/refresh_dashboard_views.py"]
    if local:
        cmd.append("--local")
    try:
        rc = subprocess.run(cmd, cwd=_SERVING_ROOT).returncode
        if rc != 0:
            print(f"\n[!] Dashboard view refresh exited {rc} — site totals may be stale.")
    except Exception as e:
        print(f"\n[!] Dashboard view refresh failed: {e}")


def _push_one(abbr: str, name: str, mode: str, r2, supabase_backend) -> bool:
    """R2 (live only), then Supabase, then the view refresh when the Supabase
    push wrote and succeeded. The two pushes are independent: an R2 failure
    does not stop the Supabase push. Returns True when the Supabase push (or
    dry run) succeeded."""
    if mode == "live":
        try:
            if not r2.push_state(abbr, name, PROJECT_ROOT):
                print(f"\n[!] State push (R2) had errors for {abbr} — check logs.")
        except Exception as e:
            print(f"\n[!] State push (R2) failed for {abbr}: {e}")

    try:
        pushed = bool(supabase_backend.push_state(abbr, name, PROJECT_ROOT))
    except Exception as e:
        print(f"\n[!] State push (Supabase) failed for {abbr}: {e}")
        pushed = False

    if mode == "dry":
        pass
    elif pushed:
        print(f"\n  Refreshing dashboard views (pushed: {abbr})...")
        _refresh_views(mode == "local")
    else:
        print(f"\n  Supabase push for {abbr} did not succeed — views not refreshed.")
    return pushed


def run(state_abbrs: list[str], command: str = "sync", skip_push: bool = False,
        live: bool = False, local: bool = False,
        sync_flags: list[str] | None = None) -> None:
    """Pipeline then push, one state at a time; emails at the end of a live
    run. See the module docstring for the flags."""
    main = str(PROJECT_ROOT / "src" / "main.py")
    sync_flags = sync_flags or []
    state_abbrs = [a.upper() for a in state_abbrs]
    local = local or os.environ.get("CF_DB_TARGET", "").strip().lower() == "local"
    mode = "skip" if skip_push else "local" if local else "live" if live else "dry"
    t_daemon = time.perf_counter()

    run_id = _new_run_id(command, state_abbrs)
    os.environ["CF_RUN_ID"] = run_id
    os.environ["CF_DAEMON"] = "1"
    run_dir = PROJECT_ROOT / "logs" / "daemon" / run_id
    label = {"live": "LIVE (R2 + Supabase, emails)", "local": "LOCAL database",
             "dry": "dry run (nothing written; --live to push)",
             "skip": "collect only"}[mode]
    print(f"  run folder: logs/daemon/{run_id}   push: {label}")

    usable: list[str] = []      # pipeline left data to publish (fresh or restored)
    agg_ok = False
    pipeline_s = 0.0

    r2 = supabase_backend = None
    abbr_to_name = _abbr_to_name()
    if mode != "skip":
        # Checked before any state is collected: a --local run whose
        # database is down would otherwise spend the whole sync first.
        if mode == "local" and not _local_db_is_up():
            print("\n[!] Local Supabase is not running. Start it from serving/ with\n"
                  "      supabase start --workdir cloud/supabase\n"
                  "    or add --skip-push to collect only. Nothing was run.")
            sys.exit(1)
        r2, supabase_backend = _backends(mode)

    try:
        for abbr in state_abbrs:
            t_state = time.perf_counter()
            rc = _run(PYTHON, main, "--daemon", command, abbr, "--fallback",
                      "--no-aggregate", *sync_flags)
            pipeline_s += time.perf_counter() - t_state

            # rc 0: main.py left usable data on disk (passed, or failed and
            # restored from the last good copy). A state that failed and
            # could not be restored, or a main.py that crashed, is not
            # published.
            if rc != 0 or abbr in _unrestorable_states(run_dir):
                print(f"\n[!] Not pushing {abbr}: failed this run and no last good copy "
                      f"could be restored.")
                continue
            usable.append(abbr)

            if mode == "skip":
                continue
            name = abbr_to_name.get(abbr)
            if not name:
                print(f"\n[!] Unknown state: {abbr} — skipping its push.")
                continue
            _push_one(abbr, name, mode, r2, supabase_backend)

        agg_ok = bool(usable)
        if mode == "skip":
            print("\n  [--skip-push] Pipeline only; nothing pushed.")

        # Aggregate (paused): rebuilt once, after every state's pipeline,
        # from what is on disk; its R2 push only on a live run.
        if not AGGREGATE_ENABLED:
            print("\n  [AGGREGATE_ENABLED=False] Skipping aggregate and master-db push "
                  "(aggregation paused).")
        elif agg_ok:
            agg_ok = _run(PYTHON, str(PROJECT_ROOT / "src" / "pipeline" / "aggregate.py")) == 0
            if not agg_ok:
                print("\n  [!] Aggregate failed — DB push skipped.")
            elif mode == "live":
                try:
                    r2.push_db(PROJECT_ROOT)
                except Exception as e:
                    print(f"\n[!] DB push failed: {e}")

        generate_report(run_id)

        # Public status page (its builder is currently missing; the import
        # fails and is reported). Own try/except: a status page problem never
        # takes down the run.
        if mode == "live":
            try:
                from src.reporting import status_page
                from cloud.r2 import status_upload
                status_page.update_status(run_id)
                status_upload.publish(run_id)
            except Exception as e:
                print(f"\n[!] Status page update failed: {e}")
    finally:
        # A live run's emails go out even when it crashed part-way.
        total_s = round(time.perf_counter() - t_daemon, 1)
        if mode == "live":
            emailer.send_pipeline_summary(
                command=command, state_abbrs=state_abbrs, sync_run_dir=run_dir,
                agg_ok=agg_ok, duration_s=round(pipeline_s, 1),
            )
            emailer.send_push_summary(
                command=command, state_abbrs=state_abbrs,
                push_run_dir=run_dir, push_db_run_dir=run_dir,
                agg_ok=agg_ok, duration_s=round(total_s - pipeline_s, 1),
            )

    if not agg_ok:
        sys.exit(1)


def _parse_args(argv: list[str]):
    import argparse
    ap = argparse.ArgumentParser(
        prog="ops/daemon.py",
        description="Pipeline, push and view refresh for each state, one state at a time. "
                    "Without --live or --local the push is a dry run.")
    ap.add_argument("states", nargs="+", metavar="STATE", help="state abbreviations, e.g. GA MI")
    ap.add_argument("--live", action="store_true",
                    help="push to R2 and the live database, refresh the views, send the emails")
    ap.add_argument("--local", action="store_true",
                    help="push to the local Supabase database; no R2, no emails")
    ap.add_argument("--skip-push", action="store_true", help="collect only; no push or dry run")
    ap.add_argument("--reparse", action="store_true", help="reparse instead of sync")
    ap.add_argument("--start-year", type=int, metavar="YYYY", help="passed to the sync")
    ap.add_argument("--end-year", type=int, metavar="YYYY", help="passed to the sync")
    args = ap.parse_intermixed_args(argv)   # flags may sit between state names
    if args.live and args.local:
        ap.error("--live and --local are two different databases; pick one")
    sync_flags: list[str] = []
    if args.start_year:
        sync_flags += ["--start-year", str(args.start_year)]
    if args.end_year:
        sync_flags += ["--end-year", str(args.end_year)]
    return args, sync_flags


if __name__ == "__main__":
    args, sync_flags = _parse_args(sys.argv[1:])
    try:
        run(args.states, "reparse" if args.reparse else "sync",
            skip_push=args.skip_push, live=args.live, local=args.local,
            sync_flags=sync_flags)
    except KeyboardInterrupt:
        sys.exit(130)
