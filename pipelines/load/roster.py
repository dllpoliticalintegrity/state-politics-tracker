"""
Rosters from the Local Politics Tracker (LPT) -> cf_candidates: every
legislative race, and the statewide races the tracker already covers.

Henry's LPT project lists every 2026 state-senate / state-representative race
(races.office_num = the real district number) with its participants and their
committee (candidates.state_filer_id). This seeds and refreshes those
candidates in the tracker for states with `"lpt_roster": true` in
states.json, so the SLCF loader picks up their money on the same run.

Committee ids are resolved against the ids our own scrape put on transaction
rows (the cleaned contributions/expenditures), because LPT's ids are not
always ours: Arizona, Florida, Ohio and Oregon agree; Georgia's LPT id is the
filer registration number where our transactions carry the Filing Entity ID;
Wisconsin's is the CFIS registrant id against Sunshine's entity id; Alaska
keys filers by name. Order: LPT id (leading zeros ignored), then the
candidate's committee name(s), then the candidate's own name (Alaska) --
all against the scrape. Unresolved candidates are still added (no money).

Idempotent by slug ("<first>-<last>-<st>-sd<N>" / "-hd<N>": the state is in
the slug because cf_candidates.slug is unique across states).
A new candidate is inserted; an existing one (matched by slug, or by its
committee within the same office, so a rename does not duplicate it) gets
only missing committee refs, and status / party when they are still unset --
never anything an admin may have curated. Nothing is ever deleted. A
committee id goes to one candidate only: ids resolved for two roster rows,
already held by another candidate, or used by the scrape for more than one
committee are refused and logged. An LPT failure skips the roster, never the
finance load.

Status: a candidate still "active" (no ballot listing has settled them)
takes LPT's settled status — off the ballot, lost the primary, or on the
November ballot — so Henry's ballot updates (The Green Papers, the states'
certified lists) reach us on the next run. A status anyone has set to
something other than "active" is never changed.

Statewide races (sync_statewide): only offices the state already has in
cf_candidates (LPT lists a few stray people under unrelated offices), plus
any states.json lists under `lpt_statewide` — how a state's new statewide
races get their first candidates (Iowa, 2026-10-18). An
existing candidate is matched by committee, then by surname within the
office ("Alex" vs "Alexander Kolodin"); a missing committee ref is filled.
A new candidate is added only when LPT has them on the ballot.

LPT is read with its publishable (anon) key; writes go through rest.py with
the tracker's service key.
"""

import json
import re
import unicodedata
from collections import defaultdict
from urllib import parse, request

import rest  # noqa: E402

LPT_URL = "https://rwiueylzgcgnzypdyszi.supabase.co"
LPT_KEY = "sb_publishable_c8uRhk8kjqwGc6yRXhFx1g_aCv1Bqq4"
OFFICES = {"state-senate": ("state-senate", "sd"), "state-representative": ("state-house", "hd")}
CYCLE = 2026

_PUNCT = re.compile(r"[^A-Z0-9 ]+")
_KNOWN_STATUS = {"active", "won_primary", "nominee", "lost_primary", "withdrawn",
                 "disqualified", "not_on_ballot"}
LEGISLATIVE = ("state-senate", "state-house")


def ballot_status(disposition, on_ballot, confirmed, cand_party):
    """The settled status LPT's ballot data supports, or "active" when it
    supports none. Only a race whose list came from a ballot source
    (`confirmed`) settles anyone, and a blank on_ballot never counts as off
    the ballot: an incomplete list must not knock a real candidate off."""
    if not confirmed:
        return "active"
    d = (disposition or "").strip().lower()
    if d in _KNOWN_STATUS and d != "active":
        return d
    if d == "eliminated":
        return "lost_primary"
    if d in ("dropped_out", "dropped out"):
        return "withdrawn"
    if on_ballot is True:
        return "won_primary" if cand_party in ("Democrat", "Republican") else "nominee"
    if on_ballot is False:
        return "not_on_ballot"
    return "active"


def settle(cur_status, new_status):
    """The status to write over cur_status, or None. Only an unset or
    "active" (unsettled) status is replaced, and only by a settled one."""
    if cur_status not in (None, "", "active"):
        return None
    if not new_status or new_status == "active" or new_status == cur_status:
        return None
    return new_status


def lpt_get(path, page=1000):
    """GET every row of an LPT REST query (Range paging)."""
    rows = []
    for start in range(0, 10**7, page):
        req = request.Request(f"{LPT_URL}/rest/v1/{path}", headers={
            "apikey": LPT_KEY, "Authorization": f"Bearer {LPT_KEY}",
            "Range-Unit": "items", "Range": f"{start}-{start + page - 1}"})
        with request.urlopen(req, timeout=120) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
    return rows


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return " ".join(_PUNCT.sub(" ", s.upper()).split())


def id_key(fid):
    """Comparison form of a committee id: case-folded, leading zeros dropped."""
    v = norm(fid).replace(" ", "")
    return v.lstrip("0") or v


def display_name(raw):
    """"BOTTOMS, KEISHA L." -> "Keisha L. Bottoms"; mixed case is kept."""
    name = " ".join(str(raw or "").split())
    if "," in name:
        last, _, first = name.partition(",")
        name = f"{first.strip()} {last.strip()}".strip()
    if name and name == name.upper():
        name = name.title()
        name = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), name)
        name = re.sub(r"\b(O|D)'([a-z])", lambda m: f"{m.group(1)}'{m.group(2).upper()}", name)
    return name


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")


def name_slug(display):
    """First and last word only: "Keisha L. Bottoms" -> "keisha-bottoms"."""
    words = [w for w in re.split(r"\s+", display.strip())
             if w.rstrip(".").upper() not in {"JR", "SR", "II", "III", "IV"}]
    if not words:
        return "candidate"
    return slugify(" ".join([words[0], words[-1]] if len(words) > 1 else words))


def party(raw):
    if isinstance(raw, list):
        raw = raw[0] if raw else ""
    p = (raw or "").strip().upper()
    if not p:
        return None
    if p.startswith("DEM"):
        return "Democrat"
    if p.startswith("REP"):
        return "Republican"
    if p.startswith("LIB"):
        return "Libertarian"
    if "GREEN" in p:
        return "Green"
    if p.startswith(("IND", "NON", "NPA", "UNAFF", "NO PARTY")):
        return "Independent"
    return p.title()


def status(disposition, on_ballot):
    d = (disposition or "").strip().lower()
    if d in _KNOWN_STATUS:
        return d
    if d == "eliminated":
        return "lost_primary"
    if d in ("dropped_out", "dropped out"):
        return "withdrawn"
    return "active" if on_ballot else "not_on_ballot"


class FilerResolver:
    """Committee ids our scrape actually uses, with a name index."""

    def __init__(self, rows, committees=()):
        self.by_id = {}          # id_key -> fid as the scrape writes it
        self.by_name = {}        # norm(committee_name or fid) -> fid
        # committees.csv: another id system's id -> its committee name
        # (Georgia: the filer registration number LPT uses -> "Paton for
        # Georgia", which the transactions carry under the Filing Entity ID).
        self.name_by_other_id = {}
        for c in committees:
            cid, cname = (c.get("state_filer_id") or "").strip(), c.get("committee_name")
            if cid and cname:
                self.name_by_other_id.setdefault(id_key(cid), cname)
        names_by_fid = defaultdict(set)
        for row in rows:
            fid = (row.get("state_filer_id") or "").strip()
            if not fid:
                continue
            if row.get("committee_name"):
                names_by_fid[fid].add(norm(row["committee_name"]))
            self.by_id.setdefault(id_key(fid), fid)
            for key in (row.get("committee_name"), fid):
                k = norm(key)
                if k:
                    self.by_name.setdefault(k, fid)
        # An id the scrape uses for more than one committee (Alaska keys
        # filers by surname: "Bauer" is two people) is never attached.
        self.ambiguous = {fid for fid, names in names_by_fid.items() if len(names) > 1}
        self.how = None          # "id" | "committee" | "candidate" after resolve()

    def resolve(self, lpt_fid, committee_names=(), candidate_name=None):
        fid, self.how = self._resolve(lpt_fid, committee_names, candidate_name)
        if fid in self.ambiguous:
            self.how = "ambiguous"
            return None
        return fid

    def _resolve(self, lpt_fid, committee_names, candidate_name):
        if lpt_fid and id_key(lpt_fid) in self.by_id:
            return self.by_id[id_key(lpt_fid)], "id"
        names = list(committee_names or ())
        if lpt_fid and id_key(lpt_fid) in self.name_by_other_id:
            names.append(self.name_by_other_id[id_key(lpt_fid)])
        for n in names:
            hit = self.by_name.get(norm(n))
            if hit:
                return hit, "committee"
        if candidate_name:
            hit = self.by_name.get(norm(display_name(candidate_name))) or \
                self.by_name.get(norm(candidate_name))
            if hit:
                return hit, "candidate"
        return None, None


def build_roster(st, races, participants, candidates, resolver):
    """cf_candidates rows for LPT's 2026 legislative participants."""
    race_by_id = {r["race_id"]: r for r in races}
    cand_by_id = {c["candidate_id"]: c for c in candidates}
    confirmed = {p["race_id"] for p in participants if p.get("source")}
    out = {}
    stats = defaultdict(int)
    for p in participants:
        race = race_by_id.get(p["race_id"])
        if not race or race.get("office_num") in (None, ""):
            continue
        office, prefix = OFFICES[race["office"]]
        district = str(int(race["office_num"]))
        cand = cand_by_id.get(p.get("candidate_id")) or {}
        raw_name = cand.get("candidate_name") or p.get("candidate_name")
        name = display_name(raw_name)
        if not name:
            stats["no_name"] += 1
            continue
        committees = cand.get("committee_name") or []
        if isinstance(committees, str):
            committees = [committees]
        fid = resolver.resolve(cand.get("state_filer_id"), committees, raw_name)
        stats["resolved" if fid else "unresolved"] += 1
        how = getattr(resolver, "how", None)
        if how:
            stats[f"by_{how}"] += 1
        slug = f"{name_slug(name)}-{st}-{prefix}{district}"
        if slug in out:                       # same person listed twice
            if fid and f"{st}:{fid}" not in out[slug]["filer_refs"]:
                out[slug]["filer_refs"].append(f"{st}:{fid}")
            continue
        out[slug] = {
            "state": st,
            "office": office,
            "district": district,
            "slug": slug,
            "name": name,
            "party": party(p.get("party") or cand.get("party")),
            "election_year": CYCLE,
            "status": status(p.get("disposition"), p.get("on_ballot")),
            "committee_name": committees[0] if committees else None,
            "filer_refs": [f"{st}:{fid}"] if fid else [],
            "featured": False,
            # What an existing row's unsettled status may move to (settle()).
            "_settled": ballot_status(p.get("disposition"), p.get("on_ballot"),
                                      p["race_id"] in confirmed,
                                      party(p.get("party") or cand.get("party"))),
        }
    return list(out.values()), dict(stats)


def fetch_lpt(st):
    """LPT's 2026 legislative races, participants and candidates for a state."""
    up = st.upper()
    races = lpt_get(f"races?select=race_id,office,office_num&state_id=eq.{up}&year=eq.{CYCLE}"
                    f"&office=in.(state-senate,state-representative)&order=race_id")
    ids = [r["race_id"] for r in races]
    participants = []
    for i in range(0, len(ids), 150):
        chunk = ",".join(ids[i:i + 150])
        participants += lpt_get(
            "race_participants?select=race_id,candidate_id,candidate_name,party,disposition,"
            f"on_ballot,source&race_id=in.({chunk})&order=race_id")
    cids = sorted({p["candidate_id"] for p in participants if p.get("candidate_id")})
    candidates = []
    for i in range(0, len(cids), 150):
        chunk = ",".join(cids[i:i + 150])
        candidates += lpt_get(
            "candidates?select=candidate_id,candidate_name,party,state_filer_id,committee_name"
            f"&candidate_id=in.({chunk})&order=candidate_id")
    return races, participants, candidates


def drop_conflicting_refs(roster, claimed, stats, log=print):
    """A committee id may belong to one candidate only. Refs resolved for
    more than one roster row, or already held by another candidate, are not
    attached (logged): the loader would otherwise give the money to
    whichever candidate sorts first."""
    counts = defaultdict(int)
    for row in roster:
        for ref in row["filer_refs"]:
            counts[ref] += 1
    for row in roster:
        kept = []
        for ref in row["filer_refs"]:
            owner = claimed.get(ref)
            if counts[ref] > 1 or (owner and owner != row["slug"]):
                stats["ref_conflict"] = stats.get("ref_conflict", 0) + 1
                log(f"   roster: {row['slug']}: {ref} not attached "
                    f"({'shared by ' + str(counts[ref]) + ' roster rows' if counts[ref] > 1 else 'held by ' + owner})")
                continue
            kept.append(ref)
        row["filer_refs"] = kept


def sync_state(st, scrape_rows, dry_run=False, log=print, committees=(), statewide_offices=()):
    """Seed / refresh one state's legislative roster. Returns the stats dict.
    Never raises on an LPT problem: the finance load must still run."""
    try:
        resolver = FilerResolver(scrape_rows, committees)
        races, participants, candidates = fetch_lpt(st)
    except Exception as e:  # noqa: BLE001 — LPT down must not cost a night's load
        log(f"   roster: skipped ({type(e).__name__}: {e})")
        return {"error": str(e)}
    roster, stats = build_roster(st, races, participants, candidates, resolver)
    live = rest.get_all(f"cf_candidates?state=eq.{st}&select=id,slug,office,district,party,status,filer_refs&order=id")
    claimed = {}
    for r in live:
        for ref in r.get("filer_refs") or []:
            claimed.setdefault(ref, r["slug"])
    by_slug = {r["slug"]: r for r in live}
    legis = [r for r in live if r.get("office") in ("state-senate", "state-house")]
    by_ref = {}
    for r in legis:
        for ref in r.get("filer_refs") or []:
            by_ref.setdefault((r["office"], ref), r)
    # A renamed candidate (nickname to legal name) keeps their committee: match
    # an existing row by (office, ref) before inventing a new slug.
    for row in roster:
        if row["slug"] not in by_slug:
            for ref in row["filer_refs"]:
                hit = by_ref.get((row["office"], ref))
                if hit:
                    row["slug"] = hit["slug"]
                    break
    drop_conflicting_refs(roster, claimed, stats, log)
    inserts, updates = [], []
    seen = set()
    for row in roster:
        if row["slug"] in seen:
            continue
        seen.add(row["slug"])
        cur = by_slug.get(row["slug"])
        settled = row.pop("_settled", None)
        if cur is None:
            inserts.append(row)
            continue
        # Party is editorial once a row exists (fill only when unset); status
        # moves only from unset / "active" to a settled one (settle()).
        patch = {}
        new_status = settle(cur.get("status"), settled)
        if new_status:
            patch["status"] = new_status
        if not cur.get("party") and row["party"]:
            patch["party"] = row["party"]
        refs = list(cur.get("filer_refs") or [])
        missing = [r for r in row["filer_refs"] if r not in refs]
        if missing:
            patch["filer_refs"] = refs + missing
        if patch:
            updates.append((cur["id"], patch))
    stats.update({"races": len(races), "lpt_candidates": len(roster),
                  "insert": len(inserts), "update": len(updates)})
    status_mix = defaultdict(int)
    for r in inserts:
        status_mix[r["status"]] += 1
    log(f"   roster: {len(races)} LPT races, {len(roster)} candidates "
        f"({stats.get('resolved', 0)} matched to a committee: {stats.get('by_id', 0)} by id, "
        f"{stats.get('by_committee', 0)} by committee name, {stats.get('by_candidate', 0)} by "
        f"candidate name; {stats.get('unresolved', 0)} unmatched, {stats.get('by_ambiguous', 0)} "
        f"ambiguous ids refused, {stats.get('ref_conflict', 0)} shared refs refused); "
        f"{len(inserts)} new {dict(status_mix)}, {len(updates)} updated"
        f"{' (dry run)' if dry_run else ''}")
    if not dry_run:
        for i in range(0, len(inserts), 200):
            rest.upsert("cf_candidates", inserts[i:i + 200], conflict="slug", resolution="ignore")
        patch_rows(updates)
    try:
        stats["statewide"] = sync_statewide(st, resolver, dry_run=dry_run, log=log,
                                             extra_offices=statewide_offices)
    except Exception as e:  # noqa: BLE001 — never cost the finance load
        log(f"   statewide roster: skipped ({type(e).__name__}: {e})")
    return stats


def patch_rows(updates):
    for cid, patch in updates:
        rest.http(f"{rest.SUPABASE_URL}/rest/v1/cf_candidates?id=eq.{parse.quote(cid)}",
                  data=json.dumps(patch).encode(), method="PATCH",
                  headers=rest._headers({"Content-Type": "application/json",
                                         "Prefer": "return=minimal"}))


# ─── Statewide races ──────────────────────────────────────────────────────

def name_key(name):
    """(surname, first initial) in comparison form: "Alex Kolodin" and
    "Alexander Kolodin" agree, two different Jacksons do not."""
    words = [w for w in norm(display_name(name) or name or "").split()
             if w not in {"JR", "SR", "II", "III", "IV"}]
    return (words[-1], words[0][:1]) if words else ("", "")


def fetch_lpt_statewide(st, offices):
    up = st.upper()
    office_list = ",".join(sorted(offices))
    races = lpt_get(f"races?select=race_id,office&state_id=eq.{up}&year=eq.{CYCLE}"
                    f"&office=in.({office_list})&order=race_id")
    ids = [r["race_id"] for r in races]
    participants, candidates = [], []
    if ids:
        participants = lpt_get(
            "race_participants?select=race_id,candidate_id,candidate_name,party,disposition,"
            f"on_ballot,source&race_id=in.({','.join(ids)})&order=race_id")
        cids = sorted({x["candidate_id"] for x in participants if x.get("candidate_id")})
        for i in range(0, len(cids), 150):
            candidates += lpt_get(
                "candidates?select=candidate_id,candidate_name,party,state_filer_id,committee_name"
                f"&candidate_id=in.({','.join(cids[i:i + 150])})&order=candidate_id")
    return races, participants, candidates


def plan_statewide(st, races, participants, candidates, live, resolver, claimed_rows=None):
    """(inserts, updates, stats) for one state's statewide races.
    live: the state's statewide cf_candidates rows; resolver: FilerResolver;
    claimed_rows: every cf_candidates row in the state (default `live`), so a
    committee already held by a legislative row is never given to a second
    candidate."""
    race_by_id = {r["race_id"]: r for r in races}
    cand_by_id = {c["candidate_id"]: c for c in candidates}
    # A race whose list came from a ballot source (The Green Papers, a state's
    # certified list) has settled who is on the ballot.
    confirmed = {x["race_id"] for x in participants if x.get("source")}
    claimed = {}
    for r in (claimed_rows if claimed_rows is not None else live):
        for ref in r.get("filer_refs") or []:
            claimed.setdefault(ref, r["slug"])
    all_slugs = {r["slug"] for r in (claimed_rows if claimed_rows is not None else live)}
    by_office = defaultdict(list)
    for r in live:
        by_office[r["office"]].append(r)
    inserts, updates = [], []
    stats = defaultdict(int)
    seen = set()
    for x in participants:
        race = race_by_id.get(x["race_id"])
        if not race:
            continue
        office = race["office"]
        cand = cand_by_id.get(x.get("candidate_id")) or {}
        raw = cand.get("candidate_name") or x.get("candidate_name")
        name = display_name(raw)
        if not name or (office, name) in seen:
            continue
        seen.add((office, name))
        committees = cand.get("committee_name") or []
        if isinstance(committees, str):
            committees = [committees]
        fid = resolver.resolve(cand.get("state_filer_id"), committees, raw)
        ref = f"{st}:{fid}" if fid else None
        on_ballot = x.get("on_ballot")
        cand_party = party(x.get("party") or cand.get("party"))
        lpt_status = ballot_status(x.get("disposition"), on_ballot, x["race_id"] in confirmed, cand_party)
        # Match an existing row: committee, then surname within the office.
        pool = by_office.get(office, [])
        hit = next((r for r in pool if ref and ref in (r.get("filer_refs") or [])), None)
        if hit is None:
            same = [r for r in pool if name_key(r["name"]) == name_key(name)]
            hit = same[0] if len(same) == 1 else None
        if hit is not None:
            patch = {}
            new_status = settle(hit.get("status"), lpt_status)
            if new_status:
                patch["status"] = new_status
            if not hit.get("party") and cand_party:
                patch["party"] = cand_party
            refs = list(hit.get("filer_refs") or [])
            if ref and ref not in refs:
                owner = claimed.get(ref)
                if owner and owner != hit["slug"]:
                    stats["ref_conflict"] += 1
                else:
                    patch["filer_refs"] = refs + [ref]
                    claimed[ref] = hit["slug"]
            if patch:
                updates.append((hit["id"], patch, hit["slug"]))
            continue
        if on_ballot is not True:
            stats["skipped_off_ballot"] += 1
            continue
        if (cand_party or "").replace("-", " ").lower() == "write in":
            stats["skipped_write_in"] += 1          # not printed on the ballot
            continue
        # Same surname as someone already in the race but a different first
        # initial ("Robert" vs "Brian Strickland", one committee): likely the
        # same person under another name. Never guess; leave it for review.
        twin = next((r for r in pool if name_key(r["name"])[0] == name_key(name)[0]), None)
        if twin is not None:
            stats["possible_duplicate"] += 1
            stats.setdefault("review", []).append(f"{name} ({office}) vs {twin['slug']}")
            continue
        if ref and claimed.get(ref):
            stats["ref_conflict"] += 1
            ref = None
        base = name_slug(name)
        slug = next(s for s in [f"{base}-{st}", f"{base}-{st}-{office}"]
                    + [f"{base}-{st}-{office}-{n}" for n in range(2, 100)] if s not in all_slugs)
        all_slugs.add(slug)
        if ref:
            claimed[ref] = slug
        inserts.append({
            "state": st, "office": office, "district": None, "slug": slug, "name": name,
            "party": cand_party, "election_year": CYCLE,
            "status": lpt_status, "committee_name": committees[0] if committees else None,
            "filer_refs": [ref] if ref else [], "featured": False,
        })
    return inserts, updates, dict(stats)


def sync_statewide(st, resolver, dry_run=False, log=print, extra_offices=()):
    live = rest.get_all(f"cf_candidates?state=eq.{st}&select=id,slug,name,office,party,status,filer_refs&order=id")
    statewide = [r for r in live if r.get("office") not in LEGISLATIVE]
    offices = {r["office"] for r in statewide} | {o for o in extra_offices if o not in LEGISLATIVE}
    if not offices:
        return {}
    races, participants, candidates = fetch_lpt_statewide(st, offices)
    inserts, updates, stats = plan_statewide(st, races, participants, candidates, statewide, resolver,
                                             claimed_rows=live)
    for row in inserts:
        log(f"   statewide roster: + {row['slug']} ({row['office']}, {row['party']}, {row['status']}, "
            f"refs {row['filer_refs']})")
    for _, patch, slug in updates:
        log(f"   statewide roster: ~ {slug}: {patch}")
    log(f"   statewide roster: {len(races)} LPT races over {sorted(offices)}; {len(inserts)} new, "
        f"{len(updates)} updated, {stats.get('skipped_off_ballot', 0)} off-ballot and "
        f"{stats.get('skipped_write_in', 0)} write-ins not added, "
        f"{stats.get('ref_conflict', 0)} refs refused, {stats.get('possible_duplicate', 0)} possible "
        f"duplicates held for review{' (dry run)' if dry_run else ''}")
    for item in stats.get("review", []):
        log(f"   statewide roster: review: {item}")
    if not dry_run:
        if inserts:
            rest.upsert("cf_candidates", inserts, conflict="slug", resolution="ignore")
        patch_rows([(cid, patch) for cid, patch, _ in updates])
    return {"insert": len(inserts), "update": len(updates), **stats}


# ─── Texas ────────────────────────────────────────────────────────────────
#
# Texas candidates live in tx_candidates (the TEC importer's seed table;
# publish_texas_to_cf() copies them to cf_candidates nightly). LPT's Texas ids
# are TEC filer idents with leading zeros, which the importer normalises the
# same way, so no scrape is needed to resolve them.

TX_OFFICE = {"state-senate": "STATESEN", "state-house": "STATEREP"}


class IdentResolver:
    """TEC: the LPT id is the filer ident (leading zeros dropped)."""

    def resolve(self, lpt_fid, committee_names=(), candidate_name=None):
        v = (lpt_fid or "").strip()
        return (v.lstrip("0") or v) if v.isdigit() else None


def sync_texas(dry_run=False, log=print):
    try:
        races, participants, candidates = fetch_lpt("tx")
    except Exception as e:  # noqa: BLE001 — LPT down must not block the TEC import
        log(f"   texas roster: skipped ({type(e).__name__}: {e})")
        return {"error": str(e)}
    rows, stats = build_roster("tx", races, participants, candidates, IdentResolver())
    live = rest.get_all("tx_candidates?select=id,slug,party,status,filer_ident&order=id")
    live_by_slug = {r["slug"]: r for r in live}
    live_idents = {r["filer_ident"] for r in live if r.get("filer_ident")}
    inserts, updates = [], []
    for r in rows:
        ident = r["filer_refs"][0].split(":", 1)[1] if r["filer_refs"] else None
        cur = live_by_slug.get(r["slug"])
        if cur is None:
            if not ident or ident in live_idents:
                stats["skipped_no_or_dup_ident"] = stats.get("skipped_no_or_dup_ident", 0) + 1
                continue                       # the importer keys on the ident
            inserts.append({
                "slug": r["slug"], "name": r["name"], "party": r["party"],
                "filer_ident": ident, "committee_name": r["committee_name"],
                "office": TX_OFFICE[r["office"]], "district": r["district"],
                "election_year": CYCLE, "status": r["status"], "featured": False,
            })
            live_idents.add(ident)
            continue
        patch = {k: r[k] for k in ("status", "party") if r[k] and not cur.get(k)}
        if patch:
            updates.append((cur["id"], patch))
    log(f"   texas roster: {len(races)} LPT races, {len(rows)} candidates; "
        f"{len(inserts)} new, {len(updates)} updated, "
        f"{stats.get('skipped_no_or_dup_ident', 0)} skipped (no or duplicate TEC ident)"
        f"{' (dry run)' if dry_run else ''}")
    if dry_run:
        return stats
    for i in range(0, len(inserts), 200):
        rest.upsert("tx_candidates", inserts[i:i + 200], conflict="slug", resolution="ignore")
    for cid, patch in updates:
        rest.http(f"{rest.SUPABASE_URL}/rest/v1/tx_candidates?id=eq.{parse.quote(cid)}",
                  data=json.dumps(patch).encode(), method="PATCH",
                  headers=rest._headers({"Content-Type": "application/json",
                                         "Prefer": "return=minimal"}))
    return stats


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Seed Texas legislative candidates into tx_candidates from LPT.")
    ap.add_argument("--texas", action="store_true", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sync_texas(dry_run=a.dry_run)
