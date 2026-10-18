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
adds rows whose transaction_type is FEC_NONFEDERAL_IE.

The loader keeps the rows whose target resolves to one of the state's
tracked candidates (cf_candidates), writes the spender to cf_ie_committees,
the row to cf_independent_expenditures, and the spender's receipts to
cf_ie_contributions. Unmatched targets are counted and the largest are
printed, so a missing alias shows up in the run log instead of vanishing.

Some states list one expenditure once per target (Georgia's independent-
expenditure export repeats a $2.98M buy for each of six House candidates it
backed). Those twins share filer, date, amount and purpose; the loader splits
the amount evenly across the group's targets so a race never shows more
money than was spent.

Pure functions where possible (pinned by tests/test_ie.py); the REST calls
live in load_ie().
"""

import hashlib
import re
from collections import defaultdict

import mapping  # noqa: E402  (pipelines/load on sys.path, as load_cf does)
import rest  # noqa: E402

IE_STANCES = {"S", "O", "U"}
FEC_IE_MARK = "FEC_NONFEDERAL_IE"

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


class TargetIndex:
    """Resolves a target string to a tracked candidate's id.

    cands: [{"id", "name", "committee_name"}] from cf_candidates for the state.
    committees: SLCF committees.csv rows (committee_name -> candidate_name),
    which bridge "Paton for Georgia" -> "PATON, CHAD" -> cf_candidates.
    """

    def __init__(self, cands, committees=()):
        self.by_committee = {}      # norm(committee_name) -> candidate id
        self.by_name = {}           # norm(name) -> candidate id
        self.by_last = defaultdict(set)   # (LAST, first initial) -> ids
        for c in cands:
            cid = c["id"]
            if c.get("committee_name"):
                self.by_committee.setdefault(norm(c["committee_name"]), cid)
            self.by_name.setdefault(norm(c["name"]), cid)
            last, first = name_parts(c["name"])
            if last:
                self.by_last[(last, first[:1])].add(cid)
                self.by_last[(last, "")].add(cid)
        self.slcf_committee = {}    # norm(SLCF committee_name) -> candidate_name
        for row in committees:
            if row.get("candidate_name") and row.get("committee_name"):
                self.slcf_committee.setdefault(norm(row["committee_name"]), row["candidate_name"])

    def _by_person(self, name):
        last, first = name_parts(name)
        if not last:
            return None
        hit = self.by_name.get(norm(name))
        if hit:
            return hit
        ids = self.by_last.get((last, first[:1])) if first else set()
        if not ids:
            ids = self.by_last.get((last, ""), set())
        return next(iter(ids)) if len(ids) == 1 else None

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
        return self._by_person(target)


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


def ie_target(row, affiliations):
    """(target, stance) for an expenditure row, from the row itself or its
    committee's affiliation; None when it is not an independent expenditure."""
    stance = (row.get("support_oppose") or "").strip().upper()
    target = (row.get("affiliated_candidate_name") or "").strip()
    if stance in IE_STANCES and target:
        return target, stance
    fid = (row.get("state_filer_id") or "").strip()
    if fid in affiliations:
        return affiliations[fid]
    return None


def group_key(row):
    """Rows that are one expenditure listed once per target share this key."""
    return (
        (row.get("state_filer_id") or "").strip(),
        mapping.iso_date(row.get("date")) or "",
        mapping.money(row.get("amount")),
        (row.get("txn_id") or "").strip() or norm(row.get("payee_name")) + "|" + norm(row.get("purpose")),
    )


def ie_rows(st, rows, index, affiliations, ids, since, cycle, log=print):
    """Yield cf_independent_expenditures rows for the expenditure rows whose
    target resolves. Also returns, via the stats dict, what did not."""
    stats = {"ie_rows": 0, "matched": 0, "unmatched": 0, "before_since": 0, "superseded": 0}
    unmatched = defaultdict(float)
    picked = []          # (row, target, stance, candidate_id)
    groups = defaultdict(int)
    for row in rows:
        hit = ie_target(row, affiliations)
        if not hit:
            continue
        stats["ie_rows"] += 1
        if (row.get("superseded") or "").strip().lower() in ("1", "y", "yes", "true"):
            stats["superseded"] += 1
            continue
        date = mapping.iso_date(row.get("date"))
        if not date or date < since:
            stats["before_since"] += 1
            continue
        target, stance = hit
        groups[group_key(row)] += 1
        cand = index.resolve(target)
        if not cand:
            stats["unmatched"] += 1
            unmatched[target] += mapping.money(row.get("amount")) or 0
            continue
        stats["matched"] += 1
        picked.append((row, target, stance, cand))

    out = []
    seen = set()
    for row, target, stance, cand in picked:
        amount = mapping.money(row.get("amount"))
        n = groups[group_key(row)]
        base = ids.make("expenditures", row)
        txn = f"{base}:{hashlib.sha1(norm(target).encode()).hexdigest()[:8]}"
        if txn in seen:
            continue
        seen.add(txn)
        fid = (row.get("state_filer_id") or "").strip()
        purpose = mapping.text(row.get("purpose")) or mapping.text(row.get("transaction_type"))
        desc = purpose
        if n > 1:
            desc = f"{purpose or 'Independent expenditure'} · 1 of {n} targets, amount split"
        out.append({
            "ie_filer_ident": f"{st}:{fid}",
            "target_candidate_id": cand,
            "source_txn_id": txn,
            "support_oppose": stance,
            "amount": round(amount / n, 2),
            "expenditure_date": mapping.iso_date(row.get("date")),
            "description": desc,
            "cycle": cycle,
            "source": "slcf",
        })
    stats["unmatched_targets"] = len(unmatched)
    top = sorted(unmatched.items(), key=lambda kv: -kv[1])[:8]
    if top:
        log("   unmatched IE targets (top by $): " +
            "; ".join(f"{t} ${v:,.0f}" for t, v in top))
    return out, stats


def ie_committees(st, ie_out, committees, expenditures_by_fid):
    """cf_ie_committees rows for every spender with a kept expenditure."""
    names = {(r.get("state_filer_id") or "").strip(): r for r in committees}
    out = {}
    for rec in ie_out:
        fid = rec["ie_filer_ident"].split(":", 1)[1]
        if fid in out:
            continue
        meta = names.get(fid) or {}
        name = mapping.text(meta.get("committee_name")) or expenditures_by_fid.get(fid) or f"Filer {fid}"
        out[fid] = {
            "filer_ident": rec["ie_filer_ident"],
            "state": st,
            "name": name,
            "committee_type": mapping.text(meta.get("committee_type")),
        }
    return list(out.values())


def ie_contributions(st, rows, spender_fids, ids, since, cycle, individual_types=None,
                     entity_words=None, type_from_name_parts=False):
    """cf_ie_contributions rows: the spenders' own receipts."""
    out = []
    seen = set()
    for row in rows:
        fid = (row.get("state_filer_id") or "").strip()
        if fid not in spender_fids:
            continue
        if (row.get("superseded") or "").strip().lower() in ("1", "y", "yes", "true"):
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


def load_ie(st, entry, clean_dir, cands, dry_run, since, cycle, ids, open_table, log=print):
    """Run the outside-spending stage for one state. Returns the stats dict."""
    committees = list(open_table(clean_dir, "committees") or [])
    affiliations = committee_affiliations(committees)
    index = TargetIndex(cands, committees)
    exp_reader = open_table(clean_dir, "expenditures")
    if exp_reader is None:
        raise SystemExit(f"{st}: expenditures missing from {clean_dir}")
    exp_rows = list(exp_reader)
    spender_names = {}
    for r in exp_rows:
        fid = (r.get("state_filer_id") or "").strip()
        if fid and fid not in spender_names and r.get("committee_name"):
            spender_names[fid] = r["committee_name"].strip()
    ie_out, stats = ie_rows(st, exp_rows, index, affiliations, ids, since, cycle, log)
    spenders = {rec["ie_filer_ident"].split(":", 1)[1] for rec in ie_out}
    comm_out = ie_committees(st, ie_out, committees, spender_names)
    contrib_rows = open_table(clean_dir, "contributions") or []
    contrib_out = ie_contributions(st, contrib_rows, spenders, ids, since, cycle,
                                   entry.get("individual_types"), entry.get("entity_words"),
                                   bool(entry.get("type_from_name_parts")))
    by_cand = defaultdict(lambda: defaultdict(float))
    for rec in ie_out:
        by_cand[rec["target_candidate_id"]][rec["support_oppose"]] += rec["amount"]
    log(f"   outside spending: {stats['ie_rows']} IE rows, {stats['matched']} matched to "
        f"{len(by_cand)} tracked candidates, {stats['unmatched']} unmatched "
        f"({stats['unmatched_targets']} targets); {len(comm_out)} spenders, "
        f"{len(contrib_out)} spender receipts"
        f"{' (dry run)' if dry_run else ''}")
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
        for i in range(0, len(rows), 500):
            rest.upsert(table, rows[i:i + 500])
        # Prune: this state's slcf rows that this run no longer produced.
        keep = {r["source_txn_id"] for r in rows}
        live = rest.get_all(f"{table}?select=id,source_txn_id&{_prefix_filter(st)}")
        stale = [r["id"] for r in live if r["source_txn_id"] not in keep]
        if stale and keep:
            for i in range(0, len(stale), 200):
                rest.delete(f"{table}?id=in.({','.join(stale[i:i + 200])})")
        log(f"   {table}: loaded {len(rows)}, pruned {len(stale) if keep else 0}")
    return stats
