"""
Outside spending from SLCF's cleaned tables -> the cf_ie_* tables.

SLCF marks an independent expenditure on the SPENDING committee's expenditure
row: `support_oppose` ("S", "O", "U") and `affiliated_candidate_name`, the
target as the state publishes it -- usually the target's committee name
("Paton for Georgia", "Crowley for Wisconsin"), sometimes the candidate's
name ("ANAVITARTE, JASON", "RAMASWAMY"). Where a state's data carries no
per-row target (FL, MI), SLCF's enrich stage puts the affiliation on the
committee row in committees.csv instead (src/registries/committees/<st>.csv),
and every expenditure of that committee inherits it. Ohio's FEC enrichment
adds rows from the FEC with the same two fields.

The loader keeps the rows whose target resolves to one of the state's
tracked candidates (cf_candidates), writes the spender to cf_ie_committees,
the row to cf_independent_expenditures, and the spender's receipts to
cf_ie_contributions. Unmatched targets are counted and the largest are
printed, so a missing alias shows up in the run log instead of vanishing.

Spender identity: state_filer_id when the row has one; otherwise the
spender's name, resolved through committees.csv to its id, else hashed
("<st>:n:<hash>") -- Georgia's independent-expenditure export names the
spender but carries no filer id. Rows with neither are dropped and counted.

Some states list one expenditure once per target (Georgia repeats a buy for
every candidate it backed, sometimes the same candidate 60 times). Rows that
share a transaction id (or the hashed id of their other fields) are one
expenditure: the amount is split evenly across its DISTINCT targets, and a
repeated (expenditure, target) pair is kept once. Ids are assigned before
any filtering, as the main loader does, so they never depend on which rows
matched.

Pure functions where possible (pinned by tests/test_ie.py); the REST calls
live in load_ie().
"""

import csv
import hashlib
import re
from collections import defaultdict
from pathlib import Path

import mapping  # noqa: E402  (pipelines/load on sys.path, as load_cf does)
import rest  # noqa: E402

IE_STANCES = {"S", "O", "U"}
# cf_candidates.status values for someone out of the race (src/lib/candidateStatus.ts):
# those who ran this cycle and are out, and roster rows never on the ballot.
RAN_AND_OUT = {"withdrawn", "dropped_out", "eliminated", "lost_primary", "disqualified"}
NICKNAMES_CSV = Path(__file__).resolve().parents[1] / "slcf" / "src" / "aliases" / "nicknames.csv"

_PUNCT = re.compile(r"[^A-Z0-9 ]+")
_DROP_WORDS = {"INC", "LLC", "PAC", "THE", "FOR", "OF", "TO", "ELECT", "COMMITTEE",
               "FRIENDS", "CITIZENS", "PEOPLE", "CAMPAIGN", "FUND", "2026", "2025"}
_SUFFIXES = {"JR", "SR", "II", "III", "IV"}


def norm(s):
    """Upper-case, punctuation-free, filler words dropped: the comparison form
    of a committee or candidate name."""
    s = _PUNCT.sub(" ", (s or "").upper().replace("&", " AND "))
    return " ".join(w for w in s.split() if w not in _DROP_WORDS)


def name_parts(name):
    """("LAST", "FIRST") from "Last, First M." or "First M. Last" (suffixes
    dropped); ("", "") when there is no name."""
    raw = (name or "").strip()
    if not raw:
        return "", ""
    if "," in raw:
        last, _, first = raw.partition(",")
    else:
        words = [w for w in raw.replace(".", " ").split() if w.upper().strip(".") not in _SUFFIXES]
        if not words:
            return "", ""
        last, first = words[-1], " ".join(words[:-1])
    last = _PUNCT.sub("", last.upper().replace(".", "")).strip()
    first = _PUNCT.sub(" ", first.upper()).split()
    return last, (first[0] if first else "")


def load_nicknames(path=NICKNAMES_CSV):
    """{nickname: formal} from SLCF's alias file (RICK -> RICHARD), or {}."""
    try:
        with open(path, newline="", encoding="utf-8") as f:
            return {r["nickname"].strip().upper(): r["formal"].strip().upper()
                    for r in csv.DictReader(f) if r.get("nickname") and r.get("formal")}
    except OSError:
        return {}


class TargetIndex:
    """Resolves a target string to a tracked candidate's id.

    cands: [{"id", "name", "committee_name"}] from cf_candidates for the state.
    committees: SLCF committees.csv rows (committee_name -> candidate_name),
    which bridge "Paton for Georgia" -> "PATON, CHAD" -> cf_candidates.

    A person-name target must agree on the surname AND the first name (a
    nickname counts: Rick = Richard); a bare surname matches only when one
    tracked candidate carries it. Where several tracked rows fit (the same
    person on a statewide row and on a stale legislative row, as Arizona's
    Andy Biggs is for governor and for a 2016 SD12 seat), the row still in the
    race wins, then one who ran this cycle and is out (lost the primary,
    withdrew), then a roster row never on the ballot; within a tier the first
    row, as before. Before 2026-10-20 the first row always won, which put
    $8.6M of IEs for Biggs on his not-on-ballot SD12 row.

    A committee-style name that fails the committee lookups is never reduced to its last word, so "Friends of Jack
    Miller" cannot land on a tracked Miller.
    """

    def __init__(self, cands, committees=(), nicknames=None):
        self.nick = load_nicknames() if nicknames is None else nicknames
        self.by_committee = {}      # norm(committee_name) -> candidate id
        self.by_name = defaultdict(list)  # norm(name) -> candidate ids
        self.by_last = defaultdict(set)   # LAST -> ids
        self.first = {}             # id -> canonical first name
        self.tier = {}              # id -> 0 in the race, 1 ran and out, 2 never on the ballot
        for c in cands:
            cid = c["id"]
            status = c.get("status") or ""
            self.tier[cid] = 2 if status == "not_on_ballot" else 1 if status in RAN_AND_OUT else 0
            if c.get("committee_name"):
                self.by_committee.setdefault(norm(c["committee_name"]), cid)
            if cid not in self.by_name[norm(c["name"])]:
                self.by_name[norm(c["name"])].append(cid)
            last, first = name_parts(c["name"])
            if last:
                self.by_last[last].add(cid)
                self.first[cid] = self._canon(first)
        self.slcf_committee = {}    # norm(SLCF committee_name) -> candidate_name
        for row in committees:
            if row.get("candidate_name") and row.get("committee_name"):
                self.slcf_committee.setdefault(norm(row["committee_name"]), row["candidate_name"])

    def _canon(self, first):
        return self.nick.get(first, first)

    def _pick(self, ids):
        """The id among `ids` in the best tier (see the class docstring), the
        first of them on a tie; None for no ids."""
        ids = list(dict.fromkeys(ids))
        return min(ids, key=lambda cid: self.tier.get(cid, 0)) if ids else None

    def _by_person(self, name):
        last, first = name_parts(name)
        if not last:
            return None
        hit = self._pick(self.by_name.get(norm(name), ()))
        if hit:
            return hit
        ids = self.by_last.get(last, set())
        if first:
            want = self._canon(first)
            ids = {cid for cid in ids
                   if self.first.get(cid) == want
                   or (len(first) == 1 and self.first.get(cid, "").startswith(first))}
        if len(ids) == 1:
            return next(iter(ids))
        # Several rows by surname and first name: only a single best-tier row
        # is taken (Biggs's governor row over his SD12 one); a tie stays
        # unmatched, as any ambiguous surname match always has.
        best = min((self.tier.get(cid, 0) for cid in ids), default=None)
        top = [cid for cid in ids if self.tier.get(cid, 0) == best]
        return top[0] if len(top) == 1 else None

    def resolve(self, target):
        t = norm(target)
        if not t:
            return None
        hit = self.by_committee.get(t)
        if hit:
            return hit
        cand_name = self.slcf_committee.get(t)
        if cand_name:
            hit = self._by_person(cand_name)
            if hit:
                return hit
        hit = self._by_person(target)
        if hit:
            return hit
        person = committee_person(target)
        return self._by_person(person) if person else None


# A candidate committee named for its candidate: "BRIAN STRICKLAND FOR
# ATTORNEY GENERAL", "COMMITTEE TO ELECT CHANDRA C WRIGHT", "FRIENDS OF JACK
# MILLER, INC.". Georgia's IE export names the target that way, and a name
# with an office after it matched nothing -- $703K supporting Strickland for
# AG went unmatched (2026-10-20).
_COMMITTEE_PREFIX = re.compile(
    r"^(?:THE\s+)?(?:COMMITTEE\s+TO\s+(?:RE-?)?ELECT|(?:RE-?)?ELECT|FRIENDS\s+(?:OF|FOR)|"
    r"CITIZENS\s+FOR|TEAM)\s+", re.I)
_COMMITTEE_SUFFIX = re.compile(r"(?:,?\s+(?:INC|LLC|CORP)\.?)$|\s+FOR\s+.*$", re.I)
_TITLE = re.compile(r"^(?:JUDGE|JUSTICE|SENATOR|SEN|REP|REPRESENTATIVE|DR|MAYOR|SHERIFF)\.?\s+", re.I)


def committee_person(target):
    """The person a candidate committee's name names, or None. Only a name
    of at least two words comes back, so the person-name rules (surname AND
    first name) still apply: "FRIENDS FOR THORNE" and "JAIN FOR GEORGIA"
    give None, never a bare surname."""
    name = (target or "").strip()
    for _ in range(2):
        name = _COMMITTEE_SUFFIX.sub("", _COMMITTEE_PREFIX.sub("", name)).strip(" ,")
    name = _TITLE.sub("", name).strip()
    words = name.split()
    if len(words) < 2 or re.search(r"\d|\b(?:FOR|OF|THE|AND)\b", name, re.I):
        return None
    return name


def committee_affiliations(committees):
    """{state_filer_id: (target, stance)} for committees whose affiliation
    SLCF's enrich stage (registry or the state's own data) filled in."""
    out = {}
    for row in committees:
        fid = (row.get("state_filer_id") or "").strip()
        target = (row.get("affiliated_candidate_name") or "").strip()
        stance = (row.get("support_oppose") or "").strip().upper()
        if fid and target and stance in IE_STANCES:
            out[fid] = (target, stance)
    return out


def committees_by_name(committees):
    """{norm(committee_name): state_filer_id} from committees.csv."""
    out = {}
    for row in committees:
        fid = (row.get("state_filer_id") or "").strip()
        name = norm(row.get("committee_name"))
        if fid and name:
            out.setdefault(name, fid)
    return out


def spender_key(row, by_name):
    """The spender's id for a row: state_filer_id, else its committee name
    resolved through committees.csv, else a hash of the name ("n:..."),
    else None (no identity at all)."""
    fid = (row.get("state_filer_id") or "").strip()
    if fid:
        return fid
    name = norm(row.get("committee_name"))
    if not name:
        return None
    return by_name.get(name) or "n:" + hashlib.md5(name.encode()).hexdigest()[:12]


# Only a real independent expenditure counts as outside spending:
#  - a row the state itself marks with a target and a stance (Michigan's IE
#    rows, Georgia's IE export, Ohio's FEC rows) counts, unless it is money
#    handed to another committee (a contribution, transfer or refund): that
#    shows up in the recipient's own receipts, so counting it here would
#    count the same dollars twice;
#  - a row that only inherits its committee's affiliation (the hand-curated
#    registries, src/registries/committees/<st>.csv) counts only when the
#    state's own transaction type calls it an independent expenditure.
#    Florida's data never does, and its registry lists candidate-chaired
#    "Friends of" committees, whose spending (incl. $45.5M handed to the
#    Republican Party of Florida in 2025-26) is not independent; all of it
#    was counted before 2026-10-18.
_IE_TYPE = re.compile(r"independent\s+expenditure", re.I)
_PASS_THROUGH = re.compile(r"\b(contributions?|transfers?|refunds?)\b", re.I)


def is_ie_type(row):
    """True when the state's own transaction type names an IE."""
    return bool(_IE_TYPE.search(row.get("transaction_type") or ""))


def is_pass_through(row):
    """True for money handed to another committee rather than spent:
    a contribution, transfer or refund, by purpose or transaction type."""
    text = f"{row.get('purpose') or ''} {row.get('transaction_type') or ''}"
    return bool(_PASS_THROUGH.search(text)) and not _IE_TYPE.search(row.get("purpose") or "")


def ie_target(row, affiliations):
    """(target, stance) for a real independent expenditure, from the row
    itself or, for rows the state types as IEs, its committee's affiliation;
    None for anything else (see the rules above)."""
    stance = (row.get("support_oppose") or "").strip().upper()
    target = (row.get("affiliated_candidate_name") or "").strip()
    if stance in IE_STANCES and target:
        return None if is_pass_through(row) else (target, stance)
    fid = (row.get("state_filer_id") or "").strip()
    if fid in affiliations and is_ie_type(row) and not is_pass_through(row):
        return affiliations[fid]
    return None


def ie_txn_base(row, ids, filing_is_report=False):
    """The expenditure's own id: the source's transaction id (txn_id, or the
    filing_id Georgia's IE export keeps it in), else the hashed id.

    Where filing_id is the whole report (states.json "ie_filing_is_report":
    Ohio), it is not an expenditure's id: every IE on the report shared it, so
    the report's rows were taken for one buy listed per target. V-PAC's
    report 512315395 has a $7,963,282 buy against Acton and other lines; the
    big buy was halved "across 2 targets" and its $20,515 neighbour against
    Acton dropped as a repeat, so Acton showed $3.98M opposed of ~$8M
    (2026-10-19). Those rows take the hashed id."""
    sid = (row.get("txn_id") or "").strip()
    if not sid and not filing_is_report:
        sid = (row.get("filing_id") or "").strip()
    return ids.source("expenditures", sid) if sid else ids.hashed("expenditures", row)


def _superseded(row):
    return (row.get("superseded") or "").strip().lower() in ("1", "y", "yes", "true")


def _id_key(s):
    """Sort key putting numeric ids in numeric order ("99" < "100")."""
    s = (s or "").strip()
    return (0, int(s), "") if s.isdigit() else (1, 0, s)


def drop_refiled(picked):
    """Drop the same buy disclosed again on a later report.

    States re-disclose IEs (a 24-hour notice, then the periodic report, then
    any amendment), each copy with its own transaction id: Georgia's Defend
    Arizona's az:101712 buys in three transaction-id batches, Wisconsin's
    same buy under two report ids. Rows that agree on spender, target,
    stance, amount, date, payee and purpose are one buy when they sit on
    different reports, and only the latest report's copy is kept. Identical
    rows on the same report are separate line items (three mailers at the
    same price) and all stay. Arizona's IE rows carry no report id, so its
    identical rows always collapse to the latest transaction id.
    Only for states whose IE filing_id is the report (states.json
    "ie_refiled"): Georgia's and Michigan's are per-transaction ids, and their
    identical rows sit on one report (Georgia REALTORS' 2 x $91,514 on report
    2036), so collapsing them there would delete real buys.
    Returns (kept, dropped_count)."""
    groups = defaultdict(list)
    for i, (row, base, target, stance, cand, spender) in enumerate(picked):
        key = (spender, cand, stance, mapping.money(row.get("amount")),
               mapping.iso_date(row.get("date")), norm(row.get("payee_name")),
               norm(row.get("purpose") or row.get("transaction_type")))
        groups[key].append(i)
    drop = set()
    for idx in groups.values():
        if len(idx) < 2:
            continue
        filings = [(picked[i][0].get("filing_id") or "").strip() for i in idx]
        if all(filings):
            latest = max(filings, key=_id_key)
            drop.update(i for i, f in zip(idx, filings) if f != latest)
        else:
            keep = max(idx, key=lambda i: _id_key((picked[i][0].get("txn_id") or "").strip()))
            # Copies of the keeper's own transaction are ie_rows' "repeated".
            drop.update(i for i in idx if picked[i][1] != picked[keep][1])
    return [p for i, p in enumerate(picked) if i not in drop], len(drop)


def ie_rows(st, rows, index, affiliations, ids, since, cycle, by_name=None, log=print,
            refiled=False, filing_is_report=False):
    """Yield cf_independent_expenditures rows for the expenditure rows whose
    target resolves; the stats dict says what did not."""
    by_name = by_name or {}
    stats = {"ie_rows": 0, "matched": 0, "unmatched": 0, "before_since": 0,
             "superseded": 0, "no_spender": 0, "repeated": 0, "refiled": 0}
    unmatched = defaultdict(float)
    picked = []                 # (row, base, target, stance, candidate_id, spender)
    targets = defaultdict(set)  # base -> distinct normalised targets
    for row in rows:
        hit = ie_target(row, affiliations)
        if not hit:
            continue
        stats["ie_rows"] += 1
        target, stance = hit
        # Ids first, before any filter, so they never depend on what matched.
        base = ie_txn_base(row, ids, filing_is_report)
        targets[base].add(norm(target))
        if _superseded(row):
            stats["superseded"] += 1
            continue
        date = mapping.iso_date(row.get("date"))
        if not date or date < since:
            stats["before_since"] += 1
            continue
        spender = spender_key(row, by_name)
        if not spender:
            stats["no_spender"] += 1
            continue
        cand = index.resolve(target)
        if not cand:
            stats["unmatched"] += 1
            unmatched[target] += mapping.money(row.get("amount")) or 0
            continue
        stats["matched"] += 1
        picked.append((row, base, target, stance, cand, spender))
    if refiled:
        picked, stats["refiled"] = drop_refiled(picked)

    out = []
    seen = set()
    for row, base, target, stance, cand, spender in picked:
        amount = mapping.money(row.get("amount"))
        n = len(targets[base])
        txn = f"{base}:{hashlib.sha1(norm(target).encode()).hexdigest()[:8]}"
        if txn in seen:
            stats["repeated"] += 1       # the same buy listed again for the same target
            continue
        seen.add(txn)
        purpose = mapping.text(row.get("purpose")) or mapping.text(row.get("transaction_type"))
        desc = purpose
        if n > 1:
            desc = f"{purpose or 'Independent expenditure'} · 1 of {n} targets, amount split"
        out.append({
            "ie_filer_ident": f"{st}:{spender}",
            "target_candidate_id": cand,
            "source_txn_id": txn,
            "support_oppose": stance,
            "amount": round(amount / n, 2),
            "expenditure_date": mapping.iso_date(row.get("date")),
            "description": desc,
            "cycle": cycle,
            "source": "slcf",
            "_spender_name": mapping.text(row.get("committee_name")),
        })
    stats["unmatched_targets"] = len(unmatched)
    top = sorted(unmatched.items(), key=lambda kv: -kv[1])[:8]
    if top:
        log("   unmatched IE targets (top by $): " +
            "; ".join(f"{t} ${v:,.0f}" for t, v in top))
    return out, stats


def ie_committees(st, ie_out, committees):
    """cf_ie_committees rows for every spender with a kept expenditure."""
    meta_by_fid = {(r.get("state_filer_id") or "").strip(): r for r in committees}
    out = {}
    for rec in ie_out:
        fid = rec["ie_filer_ident"].split(":", 1)[1]
        if fid in out:
            continue
        meta = meta_by_fid.get(fid) or {}
        name = mapping.text(meta.get("committee_name")) or rec.get("_spender_name") or f"Filer {fid}"
        out[fid] = {
            "filer_ident": rec["ie_filer_ident"],
            "state": st,
            "name": name,
            "committee_type": mapping.text(meta.get("committee_type")),
        }
    return list(out.values())


def strip_private(rows):
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]


def ie_contributions(st, rows, spender_fids, ids, since, cycle, individual_types=None,
                     entity_words=None, type_from_name_parts=False):
    """cf_ie_contributions rows: the spenders' own receipts (spenders known
    by a real state_filer_id only; a name-hashed spender has no receipts
    the state attributes to it)."""
    out = []
    seen = set()
    wanted = {f for f in spender_fids if f and not f.startswith("n:")}
    for row in rows:
        fid = (row.get("state_filer_id") or "").strip()
        if not fid or fid not in wanted:
            continue
        if _superseded(row):
            continue
        date = mapping.iso_date(row.get("date"))
        if not date or date < since:
            continue
        mapped = mapping.to_cf("contributions", row, individual_types, None, None,
                               entity_words=entity_words,
                               type_from_name_parts=type_from_name_parts)
        if not mapped or mapped[0] != "cf_contributions":
            continue
        rec = mapped[1]
        txn = ids.make("contributions", row)
        if txn in seen:
            continue
        seen.add(txn)
        out.append({
            "ie_filer_ident": f"{st}:{fid}",
            "source_txn_id": txn,
            "contributor_type": rec["contributor_type"],
            "contributor_last_name": rec["contributor_last_name"],
            "contributor_first_name": rec["contributor_first_name"],
            "employer": rec["employer"],
            "occupation": rec["occupation"],
            "amount": rec["amount"],
            "contribution_date": rec["contribution_date"],
            "city": rec["city"],
            "state": rec["state"],
            "cycle": cycle,
            "source": "slcf",
        })
    return out


def _prefix_filter(st):
    return f"ie_filer_ident=like.{st}:*&source=eq.slcf"


def load_ie(st, entry, clean_dir, cands, dry_run, since, cycle, ids, open_table, log=print,
            do_prune=False, min_share=0.9):
    """Run the outside-spending stage for one state. Returns the stats dict.

    Prune (do_prune, from the state's `prune` and run_state's --no-prune)
    deletes this state's slcf rows the run did not produce, and refuses when
    the run produced fewer than min_share of what is live -- the main
    loader's guard, so a partial scrape never empties a race."""
    comm_reader = open_table(clean_dir, "committees")
    if comm_reader is None:
        raise SystemExit(f"{st}: committees missing from {clean_dir} — the outside-spending "
                         f"stage needs the entities scrape (run_state passes --entities)")
    committees = list(comm_reader)
    affiliations = committee_affiliations(committees)
    by_name = committees_by_name(committees)
    index = TargetIndex(cands, committees)
    exp_reader = open_table(clean_dir, "expenditures")
    if exp_reader is None:
        raise SystemExit(f"{st}: expenditures missing from {clean_dir}")
    ie_out, stats = ie_rows(st, exp_reader, index, affiliations, ids, since, cycle, by_name, log,
                            refiled=bool(entry.get("ie_refiled")),
                            filing_is_report=bool(entry.get("ie_filing_is_report")))
    spenders = {rec["ie_filer_ident"].split(":", 1)[1] for rec in ie_out}
    comm_out = ie_committees(st, ie_out, committees)
    ie_out = strip_private(ie_out)
    contrib_rows = open_table(clean_dir, "contributions") or []
    contrib_out = ie_contributions(st, contrib_rows, spenders, ids, since, cycle,
                                   entry.get("individual_types"), entry.get("entity_words"),
                                   bool(entry.get("type_from_name_parts")))
    by_cand = defaultdict(lambda: defaultdict(float))
    for rec in ie_out:
        by_cand[rec["target_candidate_id"]][rec["support_oppose"]] += rec["amount"]
    log(f"   outside spending: {stats['ie_rows']} IE rows, {stats['matched']} matched to "
        f"{len(by_cand)} tracked candidates ({len(ie_out)} kept, {stats['repeated']} repeats, {stats['refiled']} re-filed), "
        f"{stats['unmatched']} unmatched ({stats['unmatched_targets']} targets), "
        f"{stats['no_spender']} without a spender; {len(comm_out)} spenders, "
        f"{len(contrib_out)} spender receipts{' (dry run)' if dry_run else ''}")
    names = {c["id"]: c.get("slug") or c["name"] for c in cands}
    for cid, sides in sorted(by_cand.items(), key=lambda kv: -sum(kv[1].values())):
        log(f"     {names.get(cid, cid):<28} " +
            "  ".join(f"{k} ${v:,.0f}" for k, v in sorted(sides.items())))
    stats.update({"committees": len(comm_out), "contributions": len(contrib_out)})
    if dry_run:
        return stats

    if comm_out:
        rest.upsert("cf_ie_committees", comm_out, conflict="filer_ident")
    for table, rows in (("cf_independent_expenditures", ie_out), ("cf_ie_contributions", contrib_out)):
        # What was live before this run writes anything, as load_cf does: read
        # after the upsert, a run whose ids changed counts its own new rows
        # beside the old ones (Ohio 2026-10-20: 30 new + 6 old = 36 live, and
        # 30 < 90% of 36 refused the prune, leaving the halved V-PAC row up
        # beside the corrected one).
        live = rest.get_all(f"{table}?select=id,source_txn_id&{_prefix_filter(st)}&order=id") \
            if do_prune else []
        for i in range(0, len(rows), 500):
            rest.upsert(table, rows[i:i + 500])
        if not do_prune:
            log(f"   {table}: loaded {len(rows)} (no prune)")
            continue
        keep = {r["source_txn_id"] for r in rows}
        if live and len(keep) < min_share * len(live):
            raise SystemExit(f"{st}: refusing to prune {table} — this run produced {len(keep)} "
                             f"rows against {len(live)} live (below {min_share:.0%})")
        stale = [r["id"] for r in live if r["source_txn_id"] not in keep]
        for i in range(0, len(stale), 200):
            rest.delete(f"{table}?{_prefix_filter(st)}&id=in.({','.join(stale[i:i + 200])})")
        log(f"   {table}: loaded {len(rows)}, pruned {len(stale)}")
    return stats
