"""
ops/data_sync.py — sync per-state data folders between the external drive
(cold/at-rest storage) and the local data/ directory (hot working copy used
during pipeline runs).

Design: data/{State}/ is a normal local directory, NOT a symlink onto the
external drive. The drive holds the persistent copy of everything; each
daemon run pulls the states it's about to touch onto the internal disk
first (load_states), runs the pipeline entirely against local storage —
fast for scrape/parse/tabulate, and critically keeps DuckDB's own spill-to-
disk I/O during aggregate.py off the external drive — then pushes the
updated folder back to the drive once the run succeeds (save_states).

By default save_states also deletes the local copy once it's safely on the
drive. State folders left sitting in data/ across many daemon runs are
exactly what eats into the internal disk's free space that aggregate.py's
DuckDB spill-to-disk needs — the wipe is what actually frees that room back
up, not just the push. Pass wipe_local=False to keep the local copy around
instead (e.g. for fast iterative reparse development, where re-pulling from
the slow external drive between iterations would be wasteful).

The external drive is a 5400rpm USB HDD: fine for this module's job (bulk
sequential copy in/out), bad for the random I/O a DB file or DuckDB temp
spill does, which is why those never touch it directly mid-run.

External root is set via CF_EXTERNAL_DATA_ROOT in .env, e.g.:
    CF_EXTERNAL_DATA_ROOT=/Volumes/easystore/state-cf-data

Both functions are no-ops (with a warning) if CF_EXTERNAL_DATA_ROOT isn't
set or the drive isn't mounted at that path — so the pipeline still runs
normally (against whatever's already local) if the drive is unplugged.

Usage (wired into ops/daemon.py around Step 1, the actual pipeline run):
    from ops import data_sync
    data_sync.load_states(state_abbrs)      # before the run
    ...run the pipeline...
    if agg_ok:
        data_sync.save_states(state_abbrs)  # after a successful run only —
                                             # wipes local by default; pass
                                             # wipe_local=False to keep it

Scope: per-state folders only (data/{State}/raw, cleaned, manifest.csv).
The top-level aggregate data/state-level-cf.db is deliberately untouched
here — it's actively queried locally (queries.py "all", ad hoc DuckDB
sessions) and isn't part of any single state's folder, so it isn't in
scope for a per-state load/save cycle.
"""

import csv
import os
import shutil
import subprocess
from pathlib import Path

from src.run_helpers import PROJECT_ROOT

DATA_DIR   = PROJECT_ROOT / "data"
STATES_CSV = PROJECT_ROOT / "src" / "aliases" / "states.csv"


def _external_root() -> Path | None:
    root = os.environ.get("CF_EXTERNAL_DATA_ROOT")
    return Path(root) if root else None


def _abbr_to_name() -> dict[str, str]:
    with open(STATES_CSV, newline="") as f:
        return {row["abbr"].upper(): row["name"] for row in csv.DictReader(f)}


def _state_names(state_abbrs: list[str]) -> list[str]:
    mapping = _abbr_to_name()
    names = []
    for abbr in state_abbrs:
        name = mapping.get(abbr.upper())
        if name:
            names.append(name)
        else:
            print(f"  [!] data_sync: unknown state abbr '{abbr}' (not in states.csv) — skipped")
    return names


def _rsync(src: Path, dst: Path) -> bool:
    dst.mkdir(parents=True, exist_ok=True)
    rc = subprocess.run(["rsync", "-a", "--delete", f"{src}/", f"{dst}/"]).returncode
    return rc == 0


def load_states(state_abbrs: list[str]) -> None:
    """Pull each state's folder from the external drive onto local data/,
    before a pipeline run touches it. Skips a state with no folder on the
    drive yet (brand new state — nothing to load; the run creates it
    locally, save_states will push it out afterward)."""
    root = _external_root()
    if root is None:
        return
    if not root.exists():
        print(f"  [!] data_sync: {root} not found — is the drive mounted? Running against local data as-is.")
        return

    for name in _state_names(state_abbrs):
        src = root / name
        if not src.exists():
            continue
        ok = _rsync(src, DATA_DIR / name)
        print(f"  {'✓' if ok else '[!]'} data_sync: loaded {name} ({src} -> data/{name})")


def save_states(state_abbrs: list[str], wipe_local: bool = True) -> None:
    """Push each state's local data/ folder back to the external drive,
    overwriting the at-rest copy. Only call this after a successful run —
    it makes the drive copy match local, deleting anything on the drive
    that's no longer present locally.

    wipe_local (default True): once a state's push succeeds, delete its
    local data/{name}/ folder. This is what actually frees internal disk
    space back up for aggregate.py's DuckDB spill — without it, state
    folders just keep accumulating locally across runs even though the
    drive already has an up-to-date copy of each one. Pass wipe_local=False
    to leave the local copy in place (e.g. mid-iteration on a parser, where
    you'd rather not re-pull the same raw files from the slow external
    drive on the next run)."""
    root = _external_root()
    if root is None:
        return
    if not root.exists():
        print(f"  [!] data_sync: {root} not found — is the drive mounted? Local changes were NOT backed up externally.")
        return

    for name in _state_names(state_abbrs):
        src = DATA_DIR / name
        if not src.exists():
            continue
        ok = _rsync(src, root / name)
        print(f"  {'✓' if ok else '[!]'} data_sync: saved {name} (data/{name} -> {root / name})")
        if ok and wipe_local:
            shutil.rmtree(src)
            print(f"    ↳ wiped local copy (data/{name} freed)")
