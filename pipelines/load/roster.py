"""
Legislative rosters from the Local Politics Tracker (LPT) -> cf_candidates.

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

Idempotent by slug ("<first>-<last>-sd<N>" / "-hd<N>", Michigan's form).
A new candidate is inserted; an existing one gets only its status, party and
any missing committee ref updated -- never its name, photo or other fields an
admin may have curated. Nothing is ever deleted.

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
        for row in rows:
            fid = (row.get("state_filer_id") or "").strip()
            if not fid:
                continue
            self.by_id.setdefault(id_key(fid), fid)
            for key in (row.get("committee_name"), fid):
                k = norm(key)
                if k:
                    self.by_name.setdefault(k, fid)

    def resolve(self, lpt_fid, committee_names=(), candidate_name=None):
        if lpt_fid and id_key(lpt_fid) in self.by_id:
            return self.by_id[id_key(lpt_fid)]
        names = list(committee_names or ())
        if lpt_fid and id_key(lpt_fid) in self.name_by_other_id:
            names.append(self.name_by_other_id[id_key(lpt_fid)])
        for n in names:
            hit = self.by_name.get(norm(n))
            if hit:
                return hit
        if candidate_name:
            return self.by_name.get(norm(display_name(candidate_name))) or \
                self.by_name.get(norm(candidate_name))
        return None


def build_roster(st, races, participants, candidates, resolver):
    """cf_candidates rows for LPT's 2026 legislative participants."""
    race_by_id = {r["race_id"]: r for r in races}
    cand_by_id = {c["candidate_id"]: c for c in candidates}
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
        slug = f"{name_slug(name)}-{prefix}{district}"
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
            f"on_ballot&race_id=in.({chunk})&order=race_id")
    cids = sorted({p["candidate_id"] for p in participants if p.get("candidate_id")})
    candidates = []
    for i in range(0, len(cids), 150):
        chunk = ",".join(cids[i:i + 150])
        candidates += lpt_get(
            "candidates?select=candidate_id,candidate_name,party,state_filer_id,committee_name"
            f"&candidate_id=in.({chunk})&order=candidate_id")
    return races, participants, candidates


def sync_state(st, scrape_rows, dry_run=False, log=print, committees=()):
    """Seed / refresh one state's legislative roster. Returns the stats dict."""
    resolver = FilerResolver(scrape_rows, committees)
    races, participants, candidates = fetch_lpt(st)
    roster, stats = build_roster(st, races, participants, candidates, resolver)
    live = rest.get_all(f"cf_candidates?state=eq.{st}&office=in.(state-senate,state-house)"
                        f"&select=id,slug,party,status,filer_refs&order=id")
    live_by_slug = {r["slug"]: r for r in live}
    inserts, updates = [], []
    for row in roster:
        cur = live_by_slug.get(row["slug"])
        if cur is None:
            inserts.append(row)
            continue
        patch = {}
        if row["status"] != cur.get("status"):
            patch["status"] = row["status"]
        if row["party"] and row["party"] != cur.get("party"):
            patch["party"] = row["party"]
        refs = list(cur.get("filer_refs") or [])
        missing = [r for r in row["filer_refs"] if r not in refs]
        if missing:
            patch["filer_refs"] = refs + missing
        if patch:
            updates.append((cur["id"], patch))
    stats.update({"races": len(races), "lpt_candidates": len(roster),
                  "insert": len(inserts), "update": len(updates)})
    log(f"   roster: {len(races)} LPT races, {len(roster)} candidates "
        f"({stats.get('resolved', 0)} with a committee in the scrape, "
        f"{stats.get('unresolved', 0)} without); {len(inserts)} new, {len(updates)} updated"
        f"{' (dry run)' if dry_run else ''}")
    if dry_run:
        return stats
    for i in range(0, len(inserts), 200):
        rest.upsert("cf_candidates", inserts[i:i + 200], conflict="slug", resolution="ignore")
    for cid, patch in updates:
        rest.http(f"{rest.SUPABASE_URL}/rest/v1/cf_candidates?id=eq.{parse.quote(cid)}",
                  data=json.dumps(patch).encode(), method="PATCH",
                  headers=rest._headers({"Content-Type": "application/json",
                                         "Prefer": "return=minimal"}))
    return stats
