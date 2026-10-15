#!/usr/bin/env python3
"""
Turn finance-sync.yml's `states` input into the run's two job lists, from
pipelines/states.json:

    pilot=<space-separated codes>   one job: scripts/data-import/pilot (Michigan, and
                                    the states not yet cut over to SLCF)
    slcf=["oh", ...]                a matrix: SLCF scrape + parse + loader, one job each

    python3 pipelines/plan_matrix.py [codes...] [--dry-run] >> "$GITHUB_OUTPUT"

No codes = every state whose `nightly` isn't false (the schedule). Named codes
run whatever their nightly flag says. With --dry-run every named state goes
to the SLCF matrix — a dry run is the reconciliation of a state's SLCF output
against its live rows, pilot state or not — and none to the pilot.

Unknown codes, Texas (its own tx-finance-sync.yml), `none` states and a
non-dry run of a `dry_run_only` state fail here, before any job starts.
"""

import json
import sys
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "states.json"
RUNNABLE = ("pilot", "slcf")


def plan(codes, dry_run=False, states=None):
    states = states if states is not None else json.loads(MANIFEST.read_text())["states"]
    codes = [c.lower() for c in codes]
    errors = []
    for c in codes:
        e = states.get(c)
        if e is None:
            errors.append(f"{c}: not in states.json")
        elif e["pipeline"] == "tec":
            errors.append(f"{c}: Texas runs in tx-finance-sync.yml")
        elif e["pipeline"] not in RUNNABLE:
            errors.append(f"{c}: pipeline is '{e['pipeline']}' ({e.get('note', 'no source')})")
        elif dry_run and c == "mi":
            errors.append("mi: Michigan stays on its own importer; there is no SLCF dry run")
        elif not dry_run and e.get("dry_run_only"):
            errors.append(f"{c}: dry runs only until its SLCF output has reconciled "
                          f"(states.json dry_run_only) — dispatch with dry_run on")
    if errors:
        raise ValueError("; ".join(errors))
    if not codes:
        if dry_run:
            raise ValueError("a dry run needs named states")
        codes = [c for c, e in states.items()
                 if e["pipeline"] in RUNNABLE and e.get("nightly", True)
                 and not e.get("dry_run_only")]
    if dry_run:
        return [], codes
    pilot = [c for c in codes if states[c]["pipeline"] == "pilot"]
    slcf = [c for c in codes if states[c]["pipeline"] == "slcf"]
    return pilot, slcf


def main(argv):
    dry_run = "--dry-run" in argv
    codes = [a for a in argv if a != "--dry-run"]
    try:
        pilot, slcf = plan(codes, dry_run)
    except ValueError as ex:
        print(f"::error::{ex}", file=sys.stderr)
        return 1
    print(f"pilot={' '.join(pilot)}")
    print(f"slcf={json.dumps(slcf)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
