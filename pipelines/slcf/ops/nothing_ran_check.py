"""
ops/nothing_ran_check.py -- emails when a live state has gone too long
without new data reaching the site. Silent when everything is fine.

    python3 ops/nothing_ran_check.py            # the daily cron job: email only if something is stale
    python3 ops/nothing_ran_check.py --print    # show every state's status, send nothing

WHY (2026-10-04). Two failures went unnoticed for weeks: Arizona's scraper
failed every run from Aug 26 (each night's email said so, among a dozen other
states' noise), and the Friday 2am job never started for nine weeks (no run,
so no email at all). The nightly emails can only report on a run that
happened. This asks the opposite question once a day: for each state on the
site, when did new data last get there?

WHAT COUNTS. A state is fresh as of its last collection that PASSED and was
then pushed to Supabase. A run that failed and pushed the restored last-good
copy does not count (the site did not get anything new), nor does a push by
hand of data already on disk, nor a dry run, nor a push to the local
database. Reads the same log.jsonl events the nightly emails are built from,
from scheduled runs (logs/daemon) and manual ones (logs/prod, logs/dev).

WHICH STATES. Every state in serving/cloud/supabase/mappings/
reviewed_candidates.csv -- the states live on the site. Not the crontab:
a state whose cron line was removed or broken is exactly the case to catch.

GRACE. Time before ops/crontab was last changed is not counted, so a new
schedule gets a full MAX_AGE_DAYS before anything is reported (Texas and
Wisconsin had never run on a schedule when this was written). The cost is
that editing the crontab quiets this check for up to that long.
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOG_ROOTS = [PROJECT_ROOT / "logs" / d for d in ("daemon", "prod", "dev")]
STATES_CSV = PROJECT_ROOT / "src" / "aliases" / "states.csv"
MAP_CSV = PROJECT_ROOT / "serving" / "cloud" / "supabase" / "mappings" / "reviewed_candidates.csv"
CRONTAB = PROJECT_ROOT / "ops" / "crontab"
HEARTBEAT = PROJECT_ROOT / "logs" / "cron_heartbeat.log"

MAX_AGE_DAYS = 8          # weekly schedule + one day of slack
LOOKBACK_DAYS = 120       # how far back to read logs for "last fresh"


def live_states(map_csv: Path = MAP_CSV) -> list[str]:
    seen: list[str] = []
    with open(map_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            abbr = (row.get("state") or "").strip().upper()
            if abbr and abbr not in seen:
                seen.append(abbr)
    return sorted(seen)


def name_to_abbr(states_csv: Path = STATES_CSV) -> dict[str, str]:
    with open(states_csv, encoding="utf-8") as f:
        return {row["name"].strip().lower(): row["abbr"].strip().upper() for row in csv.DictReader(f)}


def _parse_ts(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def read_events(log_roots=None, since: datetime | None = None) -> list[dict]:
    """The few event types this check needs, from every log file new enough
    to matter, oldest first."""
    out = []
    for root in (LOG_ROOTS if log_roots is None else log_roots):
        if not root.exists():
            continue
        files = list(root.glob("*/log.jsonl")) + list(root.glob("*.jsonl"))
        for path in files:
            if since and datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) < since:
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if '"state_duration"' not in line and '"push_completed"' not in line:
                            continue
                        try:
                            e = json.loads(line)
                        except ValueError:
                            continue
                        e["_ts"] = _parse_ts(e.get("ts"))
                        if e["_ts"]:
                            out.append(e)
            except OSError:
                continue
    out.sort(key=lambda e: e["_ts"])
    return out


def last_fresh(events: list[dict], names: dict[str, str]) -> dict[str, datetime]:
    """{ABBR: when the newest data now on the site was collected}.

    Walks events in time order. A passed collection is 'waiting' until a
    completed Supabase push follows it; a failed collection cancels the wait,
    because what is on disk afterwards is the restored old copy."""
    waiting: dict[str, datetime] = {}
    fresh: dict[str, datetime] = {}
    for e in events:
        abbr = names.get((e.get("state") or "").lower())
        if not abbr:
            continue
        if e.get("type") == "state_duration":
            if e.get("status") == "passed":
                waiting[abbr] = e["_ts"]
            else:
                waiting.pop(abbr, None)
        elif (e.get("type") == "push_completed" and e.get("operation") == "push-supabase"
              and e.get("status") == "completed" and e.get("target") != "local"):
            if abbr in waiting:
                fresh[abbr] = waiting[abbr]
    return fresh


def stale_states(states: list[str], fresh: dict[str, datetime], now: datetime,
                 counting_from: datetime | None = None,
                 max_age_days: int = MAX_AGE_DAYS) -> list[tuple[str, datetime | None, float]]:
    """[(ABBR, last fresh or None, days counted)] for states over the limit,
    worst first. `counting_from` is the grace line: no state is charged for
    time before it."""
    out = []
    for abbr in states:
        last = fresh.get(abbr)
        start = max(x for x in (last, counting_from) if x) if (last or counting_from) else None
        days = (now - start).total_seconds() / 86400 if start else float("inf")
        if days > max_age_days:
            out.append((abbr, last, days))
    out.sort(key=lambda r: -r[2])
    return out


def missed_2am(heartbeat: Path = HEARTBEAT, days: int = 8, today=None) -> list[str] | None:
    """Dates in the last `days` with no 02:00 heartbeat line (cron did not
    fire then: Mac asleep or off). Only dates after the heartbeat log began
    are judged. None if there is no heartbeat log."""
    if not heartbeat.exists():
        return None
    have = set()
    first = None
    for line in heartbeat.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            first = first or parts[0]
            if parts[1].startswith("02:"):
                have.add(parts[0])
    today = today or datetime.now().date()
    wanted = [(today - timedelta(days=i)).isoformat() for i in range(days, 0, -1)]
    return [d for d in wanted if first and d > first and d not in have]


def _fmt(dt: datetime | None) -> str:
    return dt.astimezone().strftime("%a %b %-d") if dt else "never"


def build(now: datetime | None = None):
    now = now or datetime.now(timezone.utc)
    states = live_states()
    fresh = last_fresh(read_events(since=now - timedelta(days=LOOKBACK_DAYS)), name_to_abbr())
    grace = (datetime.fromtimestamp(CRONTAB.stat().st_mtime, timezone.utc)
             if CRONTAB.exists() else None)
    return states, fresh, stale_states(states, fresh, now, grace), grace, now


def main() -> int:
    states, fresh, stale, grace, now = build()
    missed = missed_2am()

    if "--print" in sys.argv:
        bad = {s[0] for s in stale}
        print(f"limit {MAX_AGE_DAYS} days; time before {_fmt(grace)} (crontab last changed) is not counted")
        for abbr in states:
            last = fresh.get(abbr)
            age = f"{(now - last).days} day(s) ago" if last else ""
            print(f"  {abbr}  last new data collected {_fmt(last):12} {age:15} {'STALE' if abbr in bad else 'ok'}")
        if missed is not None:
            print(f"  2am cron in the last 8 days: {'no misses since the heartbeat log began' if not missed else 'did NOT fire on ' + ', '.join(missed)}")
        return 0

    if not stale:
        print(f"{now:%Y-%m-%d %H:%M} nothing-ran check: all {len(states)} states fresh")
        return 0

    rows = "".join(
        f"<tr><td style='padding:4px 12px 4px 0'><b>{abbr}</b></td>"
        f"<td style='padding:4px 12px 4px 0'>{_fmt(last)}</td>"
        f"<td style='padding:4px 0'>{'no passed run on record' if last is None else f'{(now - last).days} days ago'}</td></tr>"
        for abbr, last, _days in stale)
    cron_line = ""
    if missed:
        cron_line = (f"<p>The 2am cron slot did not fire on: {', '.join(missed)} "
                     f"(the Mac was asleep or off). That alone can explain a missed state.</p>")
    elif missed is not None:
        cron_line = "<p>Cron has not missed a 2am slot this week (as far back as the heartbeat log goes), so the job started and something in it failed, or the state has no cron line.</p>"
    html = (f"<p>No new data has reached the site for these states in more than {MAX_AGE_DAYS} days.</p>"
            f"<table style='border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px'>"
            f"<tr><th align='left'>State</th><th align='left'>Last new data collected</th><th align='left'></th></tr>"
            f"{rows}</table>{cron_line}"
            f"<p>Check <code>crontab -l</code>, <code>logs/cron_group*.log</code> and that state's last nightly email. "
            f"Full picture: <code>python3 ops/nothing_ran_check.py --print</code></p>")
    subject = "[CF] NOT UPDATING: " + ", ".join(
        f"{abbr} ({'never' if last is None else str((now - last).days) + 'd'})" for abbr, last, _ in stale)

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import emailer
    emailer._send(subject, html, [])
    print(f"{now:%Y-%m-%d %H:%M} nothing-ran check: {subject}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
