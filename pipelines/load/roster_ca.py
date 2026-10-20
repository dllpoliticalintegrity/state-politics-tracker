"""
California legislature: the November 2026 general-election candidates ->
cf_candidates + ca_candidate_filers.

Roster: the Secretary of State's certified list of candidates (a PDF, final
since 2026-08-27): every "State Senate District N" / "State Assembly Member
District N" contest and its two (top-two) candidates, with party preference.
An asterisk marks an incumbent.

Committee and candidate ids come from the CAL-ACCESS bulk export the CA
finance import already downloads (scripts/data-import/cal-access):
  - committee: the FILER_ID of the candidate's most recent 2025-26 Form 460 /
    450 cover page (CVR_CAMPAIGN_DISCLOSURE_CD) for the same office and
    district, matched on surname and first name (or initial). Only the
    candidate's own statements count (is_candidate_cover): an IE report
    (F496, F461, ...) names the candidate it supports or opposes, and would
    link an opposing party committee to them. Committees whose cover pages
    name several candidates (supporting committees) are excluded;
  - candidate: the CANDIDATE/OFFICEHOLDER filer id in FILERNAME_CD with the
    same surname and first name (most recent effective date).
The CA importer loads money for candidates with a committee id in
ca_candidate_filers, so a candidate without one is still listed (no money).

Idempotent by slug ("<first>-<last>-ca-sd<N>" / "-hd<N>"). Existing rows are
left alone apart from a missing committee ref; nothing is deleted.

    python pipelines/load/roster_ca.py --calaccess <dir with the TSVs> [--dry-run]
"""

import argparse
import csv
import io
import json
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib import parse, request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rest  # noqa: E402
from roster import display_name, name_slug, norm  # noqa: E402

CERT_URL = "https://elections.cdn.sos.ca.gov/statewide-elections/2026-general/cert-list-candidates.pdf"
HEAD = re.compile(r"^(State Senate|State Senator|State Assembly Member) District (\d+)$")
OTHER_CONTEST = re.compile(
    r"^(United States|Governor|Lieutenant|Secretary|Controller|Treasurer|Attorney|Insurance|"
    r"Member, State Board|Board of Equalization|Superintendent|Associate Justice|Chief Justice|"
    r"Presiding Justice)")
PARTIES = ["No Party Preference", "Peace and Freedom", "American Independent", "Democratic",
           "Republican", "Libertarian", "Green"]
PARTY_NAME = {"Democratic": "Democrat", "Republican": "Republican", "Libertarian": "Libertarian",
              "Green": "Green", "Peace and Freedom": "Peace and Freedom",
              "American Independent": "American Independent", "No Party Preference": "Independent"}
OFFICE_CD = {"state-senate": "SEN", "state-house": "ASM"}

csv.field_size_limit(10**9)


def parse_cert(pdf_path):
    """[{office, district, name, party, incumbent}] from the certified list."""
    import pdfplumber
    lines = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages[1:]:
            lines += (page.extract_text() or "").splitlines()
    out, cur, expect_designation = [], None, False
    for raw in lines:
        line = raw.strip()
        m = HEAD.match(line)
        if m:
            cur = ("state-senate" if m.group(1).startswith("State Senat") else "state-house", int(m.group(2)))
            expect_designation = False
            continue
        if OTHER_CONTEST.match(line):
            cur = None
            continue
        if not cur or line.startswith(("General Election", "Official Certified", "Page ")) \
                or re.match(r"^\d+/\d+/\d{4}$", line):
            continue
        party = next((p for p in PARTIES if line.endswith(" " + p)), None)
        if party and not expect_designation:
            name = line[: -len(party)].strip()
            out.append({"office": cur[0], "district": cur[1], "name": name.rstrip("*").strip(),
                        "party": PARTY_NAME[party], "incumbent": name.endswith("*")})
            expect_designation = True
        elif expect_designation:
            expect_designation = False
    return out


def tsv_rows(path):
    with open(path, encoding="latin-1", newline="") as f:
        yield from csv.DictReader((l.replace("\x00", "") for l in f), delimiter="\t",
                                  quoting=csv.QUOTE_NONE)


def _date_key(s):
    m = re.match(r"(\d+)/(\d+)/(\d{4})", s or "")
    return (int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else (0, 0, 0)


def name_key(first, last):
    """(SURNAME, first word of the first name) in comparison form."""
    f = norm(first).split()
    return norm(last).replace(" ", ""), (f[0] if f else "")


def split_display(name):
    """"Cecilia M. Aguiar-Curry" -> ("Cecilia M.", "Aguiar-Curry")."""
    words = [w for w in name.split() if w.rstrip(".").upper() not in {"JR", "SR", "II", "III", "IV"}]
    return (" ".join(words[:-1]), words[-1]) if len(words) > 1 else ("", name)


# Cover pages that say "this committee is the candidate's own": Form 460 (the
# semi-annual / pre-election statement) and Form 450 (the short form). Every
# other form with a CAND_NAML is somebody else's filing *about* a candidate:
# F496 late independent-expenditure reports, F461 / F465 IE statements, F497
# late contributions, F410 and the like, where CAND_NAML names the person
# supported or opposed. Matching on those links a party committee, PAC or
# other outside spender to the candidate it supports or opposes, and the
# importer then loads that committee's whole book of money under the
# candidate (see scripts/data-fixes/2026-10-20-ca-sd40-committees.sql for
# a real case).
CANDIDATE_COMMITTEE_FORMS = {"F460", "F450"}


def is_candidate_cover(row):
    """True if a CVR_CAMPAIGN_DISCLOSURE_CD row is a candidate-controlled committee's own statement."""
    if (row.get("FORM_TYPE") or "").strip().upper() not in CANDIDATE_COMMITTEE_FORMS:
        return False
    # Belt and braces: a support/oppose code only appears on IE-type filings.
    return not (row.get("SUP_OPP_CD") or "").strip()


def committees_index(calaccess_dir):
    """{(OFFICE_CD, district): [(surname, first, date, FILER_ID)]} from 2025-26 cover pages."""
    idx = defaultdict(list)
    for row in tsv_rows(Path(calaccess_dir) / "CVR_CAMPAIGN_DISCLOSURE_CD.TSV"):
        if not is_candidate_cover(row):
            continue
        rd = row.get("RPT_DATE") or ""
        if "2025" not in rd and "2026" not in rd:
            continue
        office = (row.get("OFFICE_CD") or "").strip().upper()
        if office not in ("SEN", "ASM"):
            continue
        dist = (row.get("DIST_NO") or "").strip().lstrip("0")
        fid = (row.get("FILER_ID") or "").strip()
        if not dist.isdigit() or not fid.isdigit():
            continue
        last, first = name_key(row.get("CAND_NAMF"), row.get("CAND_NAML"))
        idx[(office, int(dist))].append((last, first, _date_key(rd), int(fid)))
    # A committee whose cover pages name more than one candidate is a
    # primarily-formed or slate committee supporting several people, never a
    # candidate's own controlled committee: drop it from matching.
    surnames = defaultdict(set)
    for hits in idx.values():
        for last, _, _, fid in hits:
            surnames[fid].add(last)
    multi = {fid for fid, names in surnames.items() if len(names) > 1}
    return {k: [h for h in v if h[3] not in multi] for k, v in idx.items()}


def candidates_index(calaccess_dir):
    """{(surname, first): candidate filer id} (most recent effective date)."""
    best = {}
    for row in tsv_rows(Path(calaccess_dir) / "FILERNAME_CD.TSV"):
        if (row.get("FILER_TYPE") or "") != "CANDIDATE/OFFICEHOLDER":
            continue
        fid = (row.get("FILER_ID") or "").strip()
        if not fid.isdigit():
            continue
        k = name_key(row.get("NAMF"), row.get("NAML"))
        d = _date_key(row.get("EFFECT_DT"))
        if k not in best or d > best[k][0]:
            best[k] = (d, int(fid))
    return {k: v[1] for k, v in best.items()}


def match_committee(idx, office, district, first, last):
    want_last, want_first = name_key(first, last)
    hits = [h for h in idx.get((OFFICE_CD[office], district), []) if h[0] == want_last]
    exact = [h for h in hits if h[1] == want_first]
    initial = [h for h in hits if want_first and h[1][:1] == want_first[:1]]
    pool = exact or initial or (hits if len({h[3] for h in hits}) == 1 else [])
    return max(pool, key=lambda h: h[2])[3] if pool else None


def build(cert, comm_idx, cand_idx):
    rows, stats = [], defaultdict(int)
    for c in cert:
        name = display_name(c["name"])
        first, last = split_display(name)
        prefix = "sd" if c["office"] == "state-senate" else "hd"
        committee = match_committee(comm_idx, c["office"], c["district"], first, last)
        cand_id = cand_idx.get(name_key(first, last))
        stats["committee" if committee else "no_committee"] += 1
        stats["candidate_id" if cand_id else "no_candidate_id"] += 1
        rows.append({
            "row": {
                "state": "ca", "office": c["office"], "district": str(c["district"]),
                "slug": f"{name_slug(name)}-ca-{prefix}{c['district']}", "name": name,
                "party": c["party"], "election_year": 2026, "status": "won_primary",
                "title": "Incumbent" if c["incumbent"] else None,
                "filer_refs": [f"ca:{committee}"] if committee else [], "featured": False,
            },
            "candidate_filer_id": cand_id, "committee_filer_id": committee,
        })
    return rows, dict(stats)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--calaccess", required=True, help="directory holding the CAL-ACCESS TSVs")
    ap.add_argument("--cert", help="certified list PDF (default: download it)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    pdf = args.cert
    if not pdf:
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        with request.urlopen(CERT_URL, timeout=120) as r:
            tmp.write(r.read())
        tmp.close()
        pdf = tmp.name
    cert = parse_cert(pdf)
    rows, stats = build(cert, committees_index(args.calaccess), candidates_index(args.calaccess))

    live = rest.get_all("cf_candidates?state=eq.ca&select=id,slug,filer_refs&order=id")
    by_slug = {r["slug"]: r for r in live}
    claimed = {ref for r in live for ref in (r.get("filer_refs") or [])}
    linked = rest.get_all("ca_candidate_filers?select=candidate_id,candidate_filer_id,committee_filer_id&order=candidate_id")
    used_cand = {l["candidate_filer_id"] for l in linked}
    used_comm = {l["committee_filer_id"] for l in linked if l.get("committee_filer_id")}
    counts = defaultdict(int)
    for r in rows:
        if r["committee_filer_id"]:
            counts[r["committee_filer_id"]] += 1
    inserts, links, refused = [], [], 0
    for r in rows:
        row, comm, cand = r["row"], r["committee_filer_id"], r["candidate_filer_id"]
        if comm and (counts[comm] > 1 or f"ca:{comm}" in claimed or comm in used_comm):
            row["filer_refs"], comm = [], None
            refused += 1
        if cand in used_cand:
            cand = None
        if row["slug"] in by_slug:
            continue
        inserts.append(row)
        if cand and comm:
            links.append((row["slug"], cand, comm))
            used_cand.add(cand)
            used_comm.add(comm)
    by_office = defaultdict(int)
    for r in cert:
        by_office[r["office"]] += 1
    print(f"   california roster: {len(cert)} certified candidates {dict(by_office)}; "
          f"committee matched {stats.get('committee', 0)}, candidate id {stats.get('candidate_id', 0)}, "
          f"{refused} shared/claimed committees refused; {len(inserts)} new, "
          f"{len(links)} linked for the CA import{' (dry run)' if args.dry_run else ''}")
    if args.dry_run:
        for r in rows[:6]:
            print("     ", r["row"]["slug"], r["row"]["party"], r["committee_filer_id"], r["candidate_filer_id"])
        return 0
    for i in range(0, len(inserts), 200):
        rest.upsert("cf_candidates", inserts[i:i + 200], conflict="slug", resolution="ignore")
    if links:
        ids = {r["slug"]: r["id"] for r in rest.get_all("cf_candidates?state=eq.ca&select=id,slug&order=id")}
        payload = [{"candidate_id": ids[s], "candidate_filer_id": c, "committee_filer_id": m}
                   for s, c, m in links if s in ids]
        for i in range(0, len(payload), 200):
            rest.upsert("ca_candidate_filers", payload[i:i + 200], conflict="candidate_id",
                        resolution="ignore")
    return 0


if __name__ == "__main__":
    sys.exit(main())
