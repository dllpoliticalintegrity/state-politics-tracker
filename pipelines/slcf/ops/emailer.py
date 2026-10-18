"""
ops/emailer.py — Run-summary email, sent by daemon.py after every daemon invocation.

NOTE: deliberately not named email.py — `python3 ops/daemon.py` causes Python
to prepend ops/ itself to sys.path, and a module named email.py there shadows
the stdlib email package for every other library that imports it (urllib3,
smtplib, etc.), breaking the whole venv. Keep this name.

Reads the JSONL event logs already written by orc.py / src/pipeline/validate.py /
cloud/s3.py / src/pipeline/aggregate.py for the run (no new instrumentation
needed beyond what src/main.py's _run_with_fallback now emits for rollback
tracking), builds a compact HTML summary, attaches the run's report.html
file(s), and sends it via the Resend API.

Env vars (see .env):
    RESEND_API_KEY   required to actually send; if unset, the composed email
                     is printed to stdout instead (safe local/dry-run default).
    RESEND_FROM      sender, e.g. "Campaign Finance <onboarding@resend.dev>".
                     onboarding@resend.dev only delivers to the Resend
                     account's own signup address until a domain is verified
                     — see https://resend.com/docs/dashboard/domains/introduction
    EMAIL_TO         recipient address (comma-separated for multiple).

Two separate emails per daemon run (called from daemon.py, not standalone):
    from ops import emailer
    run_dir = emailer.find_run_dir("sync", ["IN"], after=t0)
    # sent right after sync + aggregate — validation table + aggregate line:
    emailer.send_pipeline_summary("sync", ["IN"], run_dir, agg_ok=True, duration_s=142.3)
    # sent after the pushes — one row per target, result rightmost:
    emailer.send_push_summary("sync", ["IN"], push_dir, push_db_dir, agg_ok=True)
"""

import base64
import html as _html
import csv
import os
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.reporting.log_report import load_events

PROJECT_ROOT = Path(__file__).resolve().parents[1]
# emailer.py is only ever called from daemon.py (see docstring below), and
# daemon.py always sets CF_DAEMON — so every run it triggers lands in
# logs/daemon/, not logs/prod/ (which is reserved for manual main.py runs).
LOGS_DAEMON  = PROJECT_ROOT / "logs" / "daemon"
STATES_CSV   = PROJECT_ROOT / "src" / "aliases" / "states.csv"

# Load .env directly rather than relying on caller import order — daemon.py
# and main.py both trigger this via run_helpers already, but emailer.py should
# work standalone too (e.g. `python3 -m ops.emailer` for a manual test send).
try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    pass

RESEND_API_URL = "https://api.resend.com/emails"

# abbr → lowercase full name — read directly rather than importing orc.py,
# which drags in aggregate.py (and duckdb) just for this lookup table.
with open(STATES_CSV, encoding="utf-8") as _f:
    ABBR_TO_NAME: dict[str, str] = {
        row["abbr"]: row["name"].lower() for row in csv.DictReader(_f)
    }


# ============================ Run-dir lookup ==============================

def _expected_states_suffix(state_abbrs: list[str]) -> str:
    if len(state_abbrs) == 1 and state_abbrs[0].lower() == "all":
        return "all"
    return "-".join(a.upper() for a in state_abbrs)


def find_run_dir(command_word: str, state_abbrs: list[str],
                 after: float | None = None) -> Path | None:
    """Most recent logs/daemon/{ts}_{command_word}[_force]_{STATES} dir.

    `after` (epoch seconds, e.g. from time.time() at the start of the daemon
    step) restricts the match to dirs created at/after that point, so a stale
    prior run with the same state combo isn't picked up by mistake.
    """
    if not LOGS_DAEMON.exists():
        return None
    suffix  = re.escape(_expected_states_suffix(state_abbrs))
    pattern = re.compile(rf"^\d{{8}}_\d{{6}}_{re.escape(command_word)}(_force)?_{suffix}$")
    candidates = [
        d for d in LOGS_DAEMON.iterdir()
        if d.is_dir() and pattern.match(d.name)
        and (after is None or d.stat().st_mtime >= after)
    ]
    return max(candidates, key=lambda d: d.name) if candidates else None


# ============================ Event extraction =============================

def _events(run_dir: Path | None) -> list[dict]:
    if not run_dir:
        return []
    log_path = run_dir / "log.jsonl"
    if not log_path.exists():
        return []
    return load_events(log_path)


def _gather_sync_data(sync_events: list[dict]) -> dict:
    """state_abbr → {name, passed, tier1_failures, tier2_warnings,
    drift_warnings, newest_record, row_counts, rolled_back, rollback_status}"""
    states: dict[str, dict] = {}

    for e in sync_events:
        t = e.get("type")

        if t == "state_duration":
            name = e.get("state")
            states.setdefault(name, {"name": name})["passed"] = (e.get("status") == "passed")
            states[name]["duration_s"] = e.get("duration_s")

        elif t == "validate_completed" and e.get("operation") == "validate":
            name = e.get("state")
            d = states.setdefault(name, {"name": name})
            d["tier1_failures"] = e.get("tier1_failures", 0)
            d["tier2_warnings"] = e.get("tier2_warnings", 0)
            d["drift_warnings"] = e.get("drift_warnings", 0)
            d["newest_record"]  = e.get("newest_record")
            d["row_counts"]     = e.get("row_counts", {})

        elif t == "state_completed" and e.get("status") == "failed":
            # which stage stopped this state (scrape / parse / validate / tabulate)
            name = e.get("state")
            states.setdefault(name, {"name": name})["failed_stage"] = e.get("stage")

        elif t in ("scrape_completed", "parse_completed") and e.get("status") == "error":
            name = e.get("state")
            err = " ".join(x for x in (e.get("error_type"), e.get("error")) if x)
            if err:
                states.setdefault(name, {"name": name})["error"] = err[:160]

        elif t == "fallback_restore":
            abbr = e.get("state_abbr")
            name = ABBR_TO_NAME.get(abbr, abbr)
            d = states.setdefault(name, {"name": name})
            d["rolled_back"]     = (e.get("status") == "ok")
            d["rollback_status"] = e.get("status")

    return states


def _gather_aggregate(sync_events: list[dict]) -> dict | None:
    for e in reversed(sync_events):
        if e.get("type") == "aggregate_completed":
            return {
                "status":     e.get("status"),
                "duration_s": e.get("duration_s"),
                "totals":     e.get("totals", {}),
                "tables_err": e.get("tables_err", 0),
            }
    return None


def _gather_push_data(push_events: list[dict]) -> dict:
    """state name (or 'db' for the aggregate db push) → {status, files_ok,
    files_err, bytes_total, delta_mb_total}"""
    states: dict[str, dict] = {}

    for e in push_events:
        t = e.get("type")
        key = e.get("state") or "db"

        if t == "push_completed":
            d = states.setdefault(key, {"bytes_total": 0, "delta_mb_total": 0.0})
            # A state is pushed twice, to R2 and to Supabase, and both emit
            # push_completed. Keep each destination's own result (2026-10-04):
            # this used to keep only whichever came last, so a failed R2 push
            # was overwritten by a good Supabase one and the reverse.
            op = (e.get("operation") or "push").replace("push-", "")
            d.setdefault("by_dest", {})[op] = e.get("status")
            statuses = list(d["by_dest"].values())
            d["status"]     = ("completed" if all(s == "completed" for s in statuses)
                               else next(s for s in statuses if s != "completed"))
            d["files_ok"]   = d.get("files_ok", 0) + (e.get("files_ok", 0) or 0)
            d["files_err"]  = d.get("files_err", 0) + (e.get("files_err", 0) or 0)
            d["duration_s"] = (d.get("duration_s") or 0) + (e.get("duration_s") or 0)

        elif t == "file_pushed" and e.get("status") == "ok":
            d = states.setdefault(key, {"bytes_total": 0, "delta_mb_total": 0.0})
            d["bytes_total"]     += e.get("bytes") or 0
            d["delta_mb_total"]  += e.get("delta_mb") or 0.0

    return states


# ============================ Formatting helpers ===========================

def _fmt_date(iso_str) -> str:
    if not iso_str:
        return "—"
    return iso_str

def _fmt_bytes(n) -> str:
    if not n:
        return "—"
    mb = n / 1_048_576
    return f"{mb:.1f} MB" if mb >= 1 else f"{n/1024:.1f} KB"

def _fmt_delta(mb) -> str:
    if not mb:
        return "—"
    sign = "+" if mb > 0 else ""
    return f"{sign}{mb:.2f} MB"

def _fmt_dur(s) -> str:
    if s is None:
        return "—"
    if s >= 60:
        return f"{int(s)//60}m {s - (int(s)//60)*60:.0f}s"
    return f"{s:.1f}s"


# =============================== HTML body ==================================

def _row(cells: list[str], bold: bool = False) -> str:
    style = "font-weight:600;" if bold else ""
    tds = "".join(
        f'<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;'
        f'font-size:13px;{style}">{c}</td>'
        for c in cells
    )
    return f"<tr>{tds}</tr>"


def build_pipeline_html(command: str, state_abbrs: list[str],
                        sync_states: dict, aggregate: dict | None,
                        agg_ok: bool, duration_s: float) -> tuple[str, str]:
    """Returns (subject, html_body) for the pipeline (sync/reparse + aggregate)
    summary email. Push results live in a separate push email — see
    build_push_html — so this table is purely sync/validation."""
    ordered = sorted(sync_states.values(), key=lambda d: d.get("name") or "")

    n_pass = sum(1 for s in ordered if s.get("passed"))
    n_fail = sum(1 for s in ordered if s.get("passed") is False)
    n_rollback = sum(1 for s in ordered if s.get("rolled_back"))

    status_word = "OK" if (n_fail == 0 and agg_ok) else ("PARTIAL" if agg_ok else "FAILED")
    subject = (f"[Campaign Finance] {command} {'-'.join(a.upper() for a in state_abbrs)} "
               f"— {status_word} ({n_pass} passed, {n_fail} failed"
               f"{f', {n_rollback} rolled back' if n_rollback else ''})")

    header = f'''
    <h2 style="font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0 0 4px">
      {command} {'-'.join(a.upper() for a in state_abbrs)} — {status_word}
    </h2>
    <p style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#666;font-size:13px;margin:0 0 16px">
      pipeline runtime {_fmt_dur(duration_s)} · aggregate {"passed" if agg_ok else "failed"}
    </p>'''

    # -- per-state table (sync / validation only) -------------------------
    head_cells = ["State", "Sync", "Duration", "Rolled back", "Newest record",
                  "Tier-1 / Tier-2 / Drift"]
    rows = [_row(head_cells, bold=True)]
    for s in ordered:
        name = (s.get("name") or "").title()
        passed = s.get("passed")
        stage = s.get("failed_stage")
        failed_text = "✗ failed" + (f" at {stage}" if stage else "")
        if s.get("error"):
            failed_text += f"<br><span style='font-size:11px'>{_html.escape(s['error'])}</span>"
        sync_cell = ("<span style='color:#1a7f37'>✓ passed</span>" if passed
                     else f"<span style='color:#c0392b'>{failed_text}</span>" if passed is False
                     else "—")
        rb = s.get("rollback_status")
        rb_cell = ({"ok": "<span style='color:#b8860b'>↩ last good copy restored — the site keeps OLD data</span>",
                    "no_data": "<span style='color:#c0392b'>✗ no last good copy — NOT pushed</span>",
                    "error": "<span style='color:#c0392b'>✗ restore failed — NOT pushed</span>"}
                   .get(rb, "—"))
        tiers = (f"{s.get('tier1_failures', '—')} / "
                 f"{s.get('tier2_warnings', '—')} / "
                 f"{s.get('drift_warnings', '—')}") if "tier1_failures" in s else "—"

        rows.append(_row([name, sync_cell, _fmt_dur(s.get("duration_s")), rb_cell,
                          _fmt_date(s.get("newest_record")), tiers]))

    table = (f'<table style="border-collapse:collapse;width:100%;'
             f'font-family:-apple-system,Helvetica,Arial,sans-serif">{"".join(rows)}</table>')

    # -- aggregate line ----------------------------------------------------
    agg_parts = []
    if aggregate:
        totals = ", ".join(f"{k} {v:,}" for k, v in aggregate.get("totals", {}).items())
        agg_parts.append(
            f'<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px">'
            f'<strong>Aggregate:</strong> {aggregate.get("status")} '
            f'({_fmt_dur(aggregate.get("duration_s"))}) — {totals or "no totals"}</p>')

    html = header + table + "".join(agg_parts) + (
        '<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;'
        'color:#999;font-size:11px;margin-top:16px">'
        'Full report attached. Raw logs under logs/daemon/ on the Mac Mini.</p>'
    )
    return subject, html


def build_push_html(command: str, state_abbrs: list[str],
                    push_states: dict, agg_ok: bool,
                    duration_s: float | None = None,
                    sync_states: dict | None = None) -> tuple[str, str]:
    """Returns (subject, html_body) for the push summary email. One row per
    push target (each state, plus 'db' for the aggregate database push), with
    the success/fail result in the rightmost column."""
    # State targets first (alphabetical), then the aggregate 'db' push last.
    state_keys = sorted(k for k in push_states if k not in ("db", "all", "global"))
    tail_keys  = [k for k in ("all", "db", "global") if k in push_states]
    ordered    = state_keys + tail_keys

    def _ok(td: dict) -> bool:
        return td.get("status") == "completed" and not td.get("files_err")

    n_ok  = sum(1 for k in ordered if _ok(push_states[k]))
    n_err = len(ordered) - n_ok
    status_word = "OK" if n_err == 0 and ordered else ("PARTIAL" if n_ok else "FAILED")

    # What the pipeline did to each state before this push. A state that
    # failed and was restored still pushes cleanly -- but it pushed the last
    # good copy, not new data, and the row and subject have to say so. This
    # is how Arizona's scraper could fail for six weeks behind push emails
    # that all read "pushed".
    sync_states = sync_states or {}
    rolled_back = {n for n, s in sync_states.items() if s.get("rollback_status") == "ok"}
    not_pushed  = sorted(n for n, s in sync_states.items()
                         if s.get("rollback_status") in ("no_data", "error") and n not in push_states)
    n_old = sum(1 for k in ordered if k in rolled_back)
    if (n_old or not_pushed) and status_word == "OK":
        status_word = "PARTIAL"

    subject = (f"[Campaign Finance] push {'-'.join(a.upper() for a in state_abbrs)} "
               f"— {status_word} ({n_ok} pushed, {n_err} failed"
               f"{f', {n_old} pushed OLD data' if n_old else ''}"
               f"{f', {len(not_pushed)} held back' if not_pushed else ''})")

    runtime = f" · runtime {_fmt_dur(duration_s)}" if duration_s is not None else ""
    header = f'''
    <h2 style="font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0 0 4px">
      push {'-'.join(a.upper() for a in state_abbrs)} — {status_word}
    </h2>
    <p style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#666;font-size:13px;margin:0 0 16px">
      {n_ok} pushed, {n_err} failed{runtime}
    </p>'''

    head_cells = ["Target", "Duration", "Size", "Result"]
    rows = [_row(head_cells, bold=True)]
    for k in ordered:
        td     = push_states[k]
        label  = "DB" if k == "db" else k.title()
        dests = td.get("by_dest") or {}
        detail = " · ".join(f"{d.upper() if d == 'r2' else d.title()} {'✓' if s == 'completed' else '✗ ' + str(s)}"
                            for d, s in sorted(dests.items()))
        detail = f"<br><span style='font-size:11px;color:#666'>{detail}</span>" if len(dests) > 1 else ""
        if not _ok(td):
            result = f"<span style='color:#c0392b'>✗ {td.get('status') or 'error'}</span>"
        elif k in rolled_back:
            result = ("<span style='color:#b8860b'>↩ pushed the last good copy — "
                      "this run FAILED, no new data</span>")
        else:
            result = "<span style='color:#1a7f37'>✓ pushed</span>"
        rows.append(_row([label, _fmt_dur(td.get("duration_s")),
                          _fmt_bytes(td.get("bytes_total")), result + detail]))
    for name in not_pushed:
        rows.append(_row([name.title(), "—", "—",
                          "<span style='color:#c0392b'>✗ held back — this run failed and no "
                          "last good copy could be restored</span>"]))

    if not ordered:
        rows.append(_row(["—", "—", "—", "nothing pushed"]))

    table = (f'<table style="border-collapse:collapse;width:100%;'
             f'font-family:-apple-system,Helvetica,Arial,sans-serif">{"".join(rows)}</table>')

    note = ""
    if not agg_ok:
        note = ('<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;'
                'font-size:13px;color:#c0392b">DB push skipped — aggregate did not pass.</p>')

    html = header + table + note + (
        '<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;'
        'color:#999;font-size:11px;margin-top:16px">'
        'Push report attached. Raw logs under logs/daemon/ on the Mac Mini.</p>'
    )
    return subject, html


# ================================ Sending ===================================

def _attachment(path: Path) -> dict:
    content = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"filename": path.name, "content": content}


def _collect_attachments(run_dirs: list[Path | None],
                         glob_pat: str = "report*.html") -> list[dict]:
    """Attach report files matching glob_pat from each run dir. The pipeline
    email passes "report.html" (the sync/reparse report); the push email passes
    "report_*.html" (report_push.html / report_pull.html). generate_report
    writes these to distinct filenames, so each email carries only its own."""
    atts = []
    seen: set[Path] = set()
    for run_dir in run_dirs:
        if not run_dir or run_dir in seen:
            continue
        seen.add(run_dir)
        for report in sorted(run_dir.glob(glob_pat)):
            att = _attachment(report)
            # Disambiguate by run dir name so reports from different run dirs
            # don't collide (e.g. sync_run_dir vs a separate push_run_dir).
            att["filename"] = f"{run_dir.name}_{report.name}"
            atts.append(att)
    return atts


def _send(subject: str, html: str, attachments: list[dict]) -> None:
    api_key = os.environ.get("RESEND_API_KEY")
    sender  = os.environ.get("RESEND_FROM", "Campaign Finance <onboarding@resend.dev>")
    to_env  = os.environ.get("EMAIL_TO", "")
    to      = [a.strip() for a in to_env.split(",") if a.strip()]

    if not api_key or not to:
        print("\n[email] RESEND_API_KEY or EMAIL_TO not set — printing summary instead of sending:")
        print(f"  Subject: {subject}")
        print(f"  ({len(attachments)} attachment(s) would be sent)")
        return

    payload = {"from": sender, "to": to, "subject": subject, "html": html}
    if attachments:
        payload["attachments"] = attachments

    try:
        resp = requests.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"[email] Resend API error {resp.status_code}: {resp.text}")
        else:
            print(f"[email] sent — {resp.json().get('id', '?')}")
    except Exception as e:
        print(f"[email] failed to send: {e}")


# =============================== Public API =================================

def send_pipeline_summary(command: str, state_abbrs: list[str],
                          sync_run_dir: Path | None,
                          agg_ok: bool, duration_s: float) -> None:
    """Build and send (or print, if unconfigured) the pipeline email — the
    sync/reparse per-state validation table plus the aggregate line. Push
    results are a separate email (send_push_summary). Never raises; a broken
    email shouldn't fail an otherwise-successful daemon run."""
    try:
        events      = _events(sync_run_dir)
        sync_states = _gather_sync_data(events)
        aggregate   = _gather_aggregate(events)

        subject, html = build_pipeline_html(
            command, state_abbrs, sync_states, aggregate, agg_ok, duration_s,
        )
        attachments = _collect_attachments([sync_run_dir], glob_pat="report.html")
        _send(subject, html, attachments)
    except Exception as e:
        print(f"[email] pipeline summary failed to build: {e}")


def send_push_summary(command: str, state_abbrs: list[str],
                      push_run_dir: Path | None, push_db_run_dir: Path | None,
                      agg_ok: bool, duration_s: float | None = None) -> None:
    """Build and send (or print, if unconfigured) the push email — one row per
    push target (each state + 'db'), with the success/fail result rightmost.

    push_run_dir covers the per-state push(es); push_db_run_dir covers the
    aggregate db push. daemon.py points CF_RUN_ID at the sync run, so in the
    normal case both are the same directory as the sync run — dedupe by path
    before loading so push events aren't double-counted. Never raises."""
    try:
        run_dirs = list(dict.fromkeys(
            d for d in (push_run_dir, push_db_run_dir) if d
        ))
        events      = [e for d in run_dirs for e in _events(d)]
        push_states = _gather_push_data(events)

        subject, html = build_push_html(command, state_abbrs, push_states,
                                        agg_ok, duration_s,
                                        sync_states=_gather_sync_data(events))
        attachments = _collect_attachments(run_dirs, glob_pat="report_*.html")
        _send(subject, html, attachments)
    except Exception as e:
        print(f"[email] push summary failed to build: {e}")
