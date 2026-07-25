#!/usr/bin/env python3
"""
Open States officeholder importer: openstates/people -> cf_officials.

Open States (https://openstates.org) curates a public-domain (CC0) dataset of
everyone currently holding state office. It can be read two ways, and this
script supports both:

  --source bulk (default)  the published bulk artifacts — no API key, no quota.
  --source api             the Open States API v3 (https://docs.openstates.org/
                           api-v3/), which needs an OPENSTATES_API_KEY. Fresher
                           between bulk publishes, and the same call returns
                           legislators and executives together. It does *not*
                           return constitutional term dates, so rows loaded this
                           way keep whatever term_start/term_end a previous bulk
                           run stored (see api_rows()).

The bulk path reads two artifacts:

  executives   data/{state}/executive/*.yml in the openstates/people git repo —
               governors, lieutenant governors, attorneys general, secretaries
               of state, and other statewide constitutional officers, with term
               dates, portraits, official links, and contact details.
  legislators  https://data.openstates.org/people/current/{state}.csv — the
               published roster of every sitting state senator and
               representative, with party, district, portrait, and contact info.

The git repo is the only source for executives (there is no CSV export for
them), so it is cloned shallow + sparse — blobs are filtered and only the
requested states' `executive` directories are checked out, which keeps the
clone to a few hundred KB.

Rows land in cf_officials keyed by (os_person_id, role_type). Roles that map to
a race the site tracks get the registry's office slug (governor,
attorney-general, secretary-of-state, lt-governor) so the race dashboards can
look up "who holds this office now" with one indexed query. Roles Open States
covers but the registry doesn't race-track (treasurer, auditor, chief election
officer, and every legislator) are still imported with office = null — they
power the legislature page and are there when new races get curated.

Only *current* roles are imported: a role whose end_date is in the past is
skipped, and after each state loads, rows the run didn't touch are deleted, so
people who leave office drop out instead of lingering.

Auth: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (GitHub Actions secret).
The API path additionally needs OPENSTATES_API_KEY (register at
https://open.pluralpolicy.com/accounts/profile/).

Usage:
    python3 import_openstates_people.py --states fl ga mi
    python3 import_openstates_people.py --states mi --people-repo ~/src/people
    python3 import_openstates_people.py --states mi --source api
    python3 import_openstates_people.py --states mi --dry-run
"""

import argparse
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib import error, parse, request

try:
    import yaml
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("PyYAML is required: pip install pyyaml")

UA = ("Mozilla/5.0 (compatible; statepoliticstracker-importer/1.0; "
      "+https://github.com/dllpoliticalintegrity/state-politics-tracker)")

PEOPLE_REPO = "https://github.com/openstates/people.git"
LEGISLATOR_CSV = "https://data.openstates.org/people/current/{state}.csv"
API_BASE = "https://v3.openstates.org"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENSTATES_API_KEY = os.environ.get("OPENSTATES_API_KEY", "")

# Open States role type -> this site's registry office slug (see
# src/states/registry.ts). Roles absent from this map import with office=null.
# Open States has no equivalent for Florida's CFO or Agriculture Commissioner,
# so those races render without an incumbent card — by design, not a bug.
ROLE_TO_OFFICE = {
    "governor": "governor",
    "lt_governor": "lt-governor",
    "attorney general": "attorney-general",
    "secretary of state": "secretary-of-state",
}

# Legislative role types, which carry a chamber instead of a statewide office.
CHAMBER_ROLES = {"upper": "upper", "lower": "lower"}

# API v3 reports executives by human-readable title ("Lieutenant Governor")
# where the YAML files use a role type ("lt_governor"). Normalize to the YAML
# vocabulary so both sources write the same (os_person_id, role_type) key and a
# state can be re-synced through either path without duplicating rows.
API_TITLE_TO_ROLE = {
    "governor": "governor",
    "lieutenant governor": "lt_governor",
    "lt. governor": "lt_governor",
    "lt governor": "lt_governor",
    "attorney general": "attorney general",
    "secretary of state": "secretary of state",
    "chief election officer": "chief election officer",
    "treasurer": "treasurer",
    "auditor": "auditor",
}


# --------------------------------------------------------------------------
# HTTP / Supabase
# --------------------------------------------------------------------------

def http(url, data=None, headers=None, method=None, timeout=120):
    req = request.Request(url, data=data, headers=headers or {}, method=method)
    with request.urlopen(req, timeout=timeout) as r:
        return r.read()


def sb_headers(extra=None):
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    h.update(extra or {})
    return h


def sb_upsert(table, rows, conflict):
    """Idempotent batch upsert via PostgREST."""
    if not rows:
        return
    http(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={parse.quote(conflict)}",
        data=json.dumps(rows).encode(),
        headers=sb_headers({
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }),
    )


def sb_delete(table, query):
    http(
        f"{SUPABASE_URL}/rest/v1/{table}?{query}",
        method="DELETE",
        headers=sb_headers({"Prefer": "return=minimal"}),
    )


# --------------------------------------------------------------------------
# openstates/people checkout
# --------------------------------------------------------------------------

def clone_people_repo(states, workdir):
    """Shallow + sparse clone of openstates/people, executives only."""
    dest = Path(workdir) / "openstates-people"
    if dest.exists():
        subprocess.run(["git", "-C", str(dest), "fetch", "--depth", "1", "origin", "main"],
                       check=True)
        subprocess.run(["git", "-C", str(dest), "reset", "--hard", "origin/main"], check=True)
    else:
        subprocess.run(
            ["git", "clone", "--depth", "1", "--filter=blob:none", "--no-checkout",
             PEOPLE_REPO, str(dest)],
            check=True,
        )
    patterns = [f"data/{st}/executive" for st in states]
    subprocess.run(["git", "-C", str(dest), "sparse-checkout", "set", "--no-cone", *patterns],
                   check=True)
    subprocess.run(["git", "-C", str(dest), "checkout"], check=True)
    return dest


# --------------------------------------------------------------------------
# Transforms
# --------------------------------------------------------------------------

def parse_date(value):
    """Open States dates are ISO strings, sometimes partial ('2027')."""
    if not value:
        return None
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            d = datetime.strptime(s, fmt).date()
            return d.isoformat()
        except ValueError:
            continue
    return None


def is_current(role, today):
    """A role is current unless it already ended. Undated roles count as current."""
    end = parse_date(role.get("end_date"))
    if end and end < today.isoformat():
        return False
    start = parse_date(role.get("start_date"))
    if start and start > today.isoformat():
        return False
    return True


def first_office(offices, classification=None):
    for o in offices or []:
        if classification is None or o.get("classification") == classification:
            return o
    return (offices or [None])[0]


def executive_rows(repo, state, today):
    """One row per current statewide-executive role in data/{state}/executive."""
    directory = Path(repo) / "data" / state / "executive"
    if not directory.is_dir():
        print(f"   no executive directory for {state}", flush=True)
        return []

    rows = []
    for path in sorted(directory.glob("*.yml")):
        person = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        parties = person.get("party") or []
        party = None
        for p in parties:
            # Party entries can carry their own end_date when someone switches.
            if is_current(p, today):
                party = p.get("name")
                break
        office = first_office(person.get("offices"), "capitol")

        for role in person.get("roles") or []:
            role_type = (role.get("type") or "").strip()
            if not role_type or not is_current(role, today):
                continue
            # Legislative roles inside an executive file (a Lt. Gov who also
            # sits in the senate) are left to the legislator CSV, which carries
            # the district and chamber contact details.
            if role_type in CHAMBER_ROLES:
                continue
            rows.append({
                "os_person_id": person.get("id"),
                "state": state,
                "role_type": role_type,
                "office": ROLE_TO_OFFICE.get(role_type),
                "chamber": None,
                "district": role.get("district"),
                "name": person.get("name"),
                "given_name": person.get("given_name"),
                "family_name": person.get("family_name"),
                "party": party,
                "image_url": person.get("image"),
                "email": person.get("email"),
                "phone": (office or {}).get("voice"),
                "capitol_address": (office or {}).get("address"),
                "links": [
                    {k: v for k, v in link.items() if k in ("url", "note")}
                    for link in (person.get("links") or [])
                    if link.get("url")
                ],
                "sources": [
                    {"url": s["url"]} for s in (person.get("sources") or []) if s.get("url")
                ],
                "term_start": parse_date(role.get("start_date")),
                "term_end": parse_date(role.get("end_date")),
            })
    return rows


def split_multi(value):
    """Open States CSVs pack repeated fields into ';'-separated strings."""
    return [v.strip() for v in (value or "").split(";") if v.strip()]


def legislator_rows(state):
    """One row per sitting legislator, from the published per-state CSV."""
    url = LEGISLATOR_CSV.format(state=state)
    try:
        raw = http(url, headers={"User-Agent": UA}).decode("utf-8-sig", "replace")
    except error.HTTPError as e:
        if e.code == 404:
            print(f"   no legislator CSV for {state}", flush=True)
            return []
        raise

    rows = []
    for r in csv.DictReader(io.StringIO(raw)):
        chamber = (r.get("current_chamber") or "").strip()
        if chamber not in CHAMBER_ROLES:
            continue
        rows.append({
            "os_person_id": r.get("id"),
            "state": state,
            "role_type": chamber,
            "office": None,
            "chamber": chamber,
            "district": (r.get("current_district") or "").strip() or None,
            "name": r.get("name"),
            "given_name": r.get("given_name") or None,
            "family_name": r.get("family_name") or None,
            "party": (r.get("current_party") or "").strip() or None,
            "image_url": (r.get("image") or "").strip() or None,
            "email": (r.get("email") or "").strip() or None,
            "phone": (r.get("capitol_voice") or r.get("district_voice") or "").strip() or None,
            "capitol_address": (r.get("capitol_address") or "").strip() or None,
            "links": [{"url": u} for u in split_multi(r.get("links"))],
            "sources": [{"url": u} for u in split_multi(r.get("sources"))],
            "term_start": None,
            "term_end": None,
        })
    return rows


# --------------------------------------------------------------------------
# API v3 (https://docs.openstates.org/api-v3/)
# --------------------------------------------------------------------------

def api_get(path, params):
    url = f"{API_BASE}{path}?{parse.urlencode(params, doseq=True)}"
    raw = http(url, headers={"User-Agent": UA, "X-API-KEY": OPENSTATES_API_KEY})
    return json.loads(raw)


def api_people(state, classification):
    """Page through /people for one jurisdiction, newest roster first."""
    page = 1
    while True:
        payload = api_get("/people", {
            "jurisdiction": state.upper(),
            "org_classification": classification,
            "include": ["links", "sources", "offices"],
            "per_page": 50,
            "page": page,
        })
        for person in payload.get("results") or []:
            yield person
        pagination = payload.get("pagination") or {}
        if page >= int(pagination.get("max_page") or page):
            return
        page += 1
        # The API is a shared, key-metered service — don't hammer it.
        time.sleep(1)


def api_rows(state):
    """Every current officeholder for a state, via API v3.

    Deliberately omits term_start/term_end: the API's current_role carries no
    term dates, and PostgREST only updates columns present in the payload, so
    leaving them out preserves whatever the bulk path last stored instead of
    blanking it.
    """
    if not OPENSTATES_API_KEY:
        sys.exit("--source api needs OPENSTATES_API_KEY "
                 "(https://open.pluralpolicy.com/accounts/profile/)")

    rows = []
    for classification in ("legislature", "executive"):
        for person in api_people(state, classification):
            role = person.get("current_role") or {}
            org = (role.get("org_classification") or "").strip()
            title = (role.get("title") or "").strip()
            if org in CHAMBER_ROLES:
                role_type, chamber = org, org
            else:
                role_type = API_TITLE_TO_ROLE.get(title.lower())
                chamber = None
                if not role_type:
                    # An office Open States tracks but this map doesn't know
                    # yet — skip rather than invent a role key that would
                    # collide with the YAML vocabulary on the next bulk run.
                    print(f"   skipping unmapped role: {title or org} "
                          f"({person.get('name')})", flush=True)
                    continue
            office = first_office(person.get("offices"), "capitol")
            district = role.get("district")
            rows.append({
                "os_person_id": person.get("id"),
                "state": state,
                "role_type": role_type,
                "office": ROLE_TO_OFFICE.get(role_type),
                "chamber": chamber,
                "district": str(district) if district not in (None, "") else None,
                "name": person.get("name"),
                "given_name": person.get("given_name") or None,
                "family_name": person.get("family_name") or None,
                "party": person.get("party") or None,
                "image_url": person.get("image") or None,
                "email": person.get("email") or None,
                "phone": (office or {}).get("voice"),
                "capitol_address": (office or {}).get("address"),
                "links": [
                    {k: v for k, v in link.items() if k in ("url", "note")}
                    for link in (person.get("links") or [])
                    if link.get("url")
                ],
                "sources": [
                    {"url": s["url"]} for s in (person.get("sources") or []) if s.get("url")
                ],
            })
    return rows


def dedupe(rows):
    """Collapse to the table's (os_person_id, role_type) key.

    A single POST can't carry two rows with the same conflict key — PostgREST
    rejects the batch ("ON CONFLICT DO UPDATE command cannot affect row a
    second time"). Last write wins; executives load after legislators only in
    the rare overlap, and the keys differ there anyway.
    """
    out = {}
    for r in rows:
        if not r.get("os_person_id") or not r.get("role_type"):
            continue
        out[(r["os_person_id"], r["role_type"])] = r
    return list(out.values())


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", nargs="+", default=["fl", "ga", "mi"],
                    help="lowercase two-letter state codes")
    ap.add_argument("--people-repo",
                    help="path to an existing openstates/people checkout "
                         "(skips the clone)")
    ap.add_argument("--workdir", default=None,
                    help="where to cache the sparse clone (default: a temp dir)")
    ap.add_argument("--source", choices=["bulk", "api"], default="bulk",
                    help="bulk: git repo + published CSVs (no key). "
                         "api: Open States API v3 (needs OPENSTATES_API_KEY)")
    ap.add_argument("--dry-run", action="store_true",
                    help="transform and summarize without writing to Supabase")
    args = ap.parse_args()

    states = [s.lower() for s in args.states]
    if not args.dry_run and (not SUPABASE_URL or not SERVICE_KEY):
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")

    repo = None
    if args.source == "bulk":
        workdir = args.workdir or tempfile.mkdtemp(prefix="openstates-")
        repo = Path(args.people_repo) if args.people_repo else clone_people_repo(states, workdir)

    today = date.today()
    # Recorded before the first write so the prune below only removes rows this
    # run genuinely didn't touch.
    started = datetime.now(timezone.utc).isoformat()
    totals = {}

    for state in states:
        if args.source == "api":
            rows = dedupe(api_rows(state))
        else:
            rows = dedupe(legislator_rows(state) + executive_rows(repo, state, today))
        for r in rows:
            r["synced_at"] = started
            r["updated_at"] = started
        execs = [r for r in rows if not r["chamber"]]
        legs = [r for r in rows if r["chamber"]]
        offices = sorted({r["office"] for r in rows if r["office"]})
        print(f"== {state}: {len(execs)} executive roles "
              f"({', '.join(offices) or 'none mapped to a tracked race'}), "
              f"{len(legs)} legislators", flush=True)
        totals[state] = len(rows)

        if args.dry_run:
            continue
        for i in range(0, len(rows), 500):
            sb_upsert("cf_officials", rows[i:i + 500], "os_person_id,role_type")
        # Prune anyone who left office between syncs.
        sb_delete("cf_officials",
                  f"state=eq.{state}&synced_at=lt.{parse.quote(started)}"
                  "&source=eq.openstates")

    print("done:", totals)


if __name__ == "__main__":
    main()
