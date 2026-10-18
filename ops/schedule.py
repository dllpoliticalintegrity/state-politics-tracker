"""
ops/schedule.py -- reads the live cron schedule (ops/crontab, the actual
source of truth per its own header) to answer "which states are currently
scheduled for automated runs?"

Built for the public status page (see project memory status_page_design.md):
the state grid should only show states currently in rotation, and should
automatically shrink/grow whenever ops/crontab is edited (e.g. the planned
trim down to swing states) without needing a second config to keep in sync.

Deliberately a regex parse of the crontab text, not a "real" cron parser --
the file's structure is simple and constrained (see ops/install_cron.sh):
one `... ops/daemon.py <ABBR ABBR ...> [flags] > ...` invocation per active
line. A commented-out line (leading '#', after stripping whitespace) is
never scheduled and is skipped.
"""

import csv
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CRONTAB_PATH = PROJECT_ROOT / "ops" / "crontab"
STATES_CSV   = PROJECT_ROOT / "src" / "aliases" / "states.csv"

_DAEMON_INVOCATION = re.compile(r"ops/daemon\.py\s+(.*?)(?:\s*>|\s*$)")
_ABBR_TOKEN        = re.compile(r"^[A-Z]{2}$")


def _valid_abbrs() -> set[str]:
    with open(STATES_CSV, newline="", encoding="utf-8") as f:
        return {row["abbr"].upper() for row in csv.DictReader(f)}


def _daemon_state_tokens(line: str, valid: set[str]) -> list[str]:
    m = _DAEMON_INVOCATION.search(line)
    if not m:
        return []
    out = []
    for token in m.group(1).split():
        if token.startswith("-"):
            continue
        token = token.upper()
        if _ABBR_TOKEN.match(token) and token in valid:
            out.append(token)
    return out


def scheduled_states(crontab_path: Path = CRONTAB_PATH) -> set[str]:
    """Return the flattened set of state abbreviations currently scheduled
    via any active (non-commented) `ops/daemon.py` line in `crontab_path`.
    Flags like --reparse are ignored. A token is only counted if it's a
    known abbreviation in src/aliases/states.csv -- this way a typo or a
    future non-state flag in a cron line can't leak a bogus "state" onto
    the public page."""
    valid = _valid_abbrs()
    states: set[str] = set()
    if not crontab_path.exists():
        return states
    for raw_line in crontab_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        states.update(_daemon_state_tokens(line, valid))
    return states


def scheduled_groups(crontab_path: Path = CRONTAB_PATH) -> list[list[str]]:
    """Same source, but returns each active daemon.py invocation's state
    list separately (one list per cron line) instead of a flattened set --
    useful if the status page ever wants to show "these states run
    together" grouping instead of just membership."""
    valid = _valid_abbrs()
    groups: list[list[str]] = []
    if not crontab_path.exists():
        return groups
    for raw_line in crontab_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        group = _daemon_state_tokens(line, valid)
        if group:
            groups.append(group)
    return groups


if __name__ == "__main__":
    states = sorted(scheduled_states())
    print(f"{len(states)} state(s) currently scheduled: {', '.join(states)}")
    for g in scheduled_groups():
        print(" ", ", ".join(g))
