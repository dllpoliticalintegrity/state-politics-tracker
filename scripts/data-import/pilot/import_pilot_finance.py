#!/usr/bin/env python3
"""
Pilot-state campaign-finance importer: FL, MI, GA governor races -> cf_* tables.

Fetches directly from each state's disclosure system (the same sources the
state-level-campaign-finance pipeline scrapes, but scoped to the committees in
cf_candidates.filer_refs so the shared database only carries rows for tracked
races):

  FL  Division of Elections cgi query (contrib.exe / expend.exe), one query per
      candidate (office=GOV), date-windowed when a query hits the 32,000-row cap.
      FL rows carry no transaction id -> a deterministic md5 of the row fields
      (plus a duplicate-sequence suffix) is used for idempotent upserts.
  GA  Peachfile bulk CSV export (TCON/TEXP per filing year), filtered by
      Filing Entity ID. Rows carry a stable Transaction Id.
  MI  MiTN bulk ZIP export (Contribution/Expenditure per year), filtered by
      cfr_com_id. Rows carry stable contribution/expense ids.

Loan-type rows land in cf_loans; in-kind rows keep source_form_type='INKIND';
GA "Unitemized Contribution" lump rows are labeled so they read sensibly in
donor tables. After loading, refresh_cf_finance_views() rebuilds the matviews.

Auth: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (GitHub Actions secret).
Committee mappings live in COMMITTEES below — extend them when new candidates
or states are curated, and keep them in sync with cf_candidates.filer_refs.

  AZ  SeeTheMoney AdvancedSearch JSON API, per exact committee name
      (DataTables POST; search params in the query string).
  KY  KREF flat CSV exports (contributions/expenditures per year), matched by
      recipient candidate name — KREF publishes no filer ids. KY statewide
      races run in odd years; the tracked race is the 2027 governor's race.
  ME  Not importable from datacenter IPs (Cloudflare WAF on the Maine
      disclosure system) — Maine runs with candidates + polling only.
  PA  DOS annual full-export ZIPs (contrib/expense files keyed by FILERID);
      amended filings are deduped by keeping the max CampaignFinanceID per
      (filer, year, cycle).
  CO  TRACER bulk CSV zips, filtered by CO_ID; stable RecordIDs, amended
      rows skipped, year files overlap so RecordIDs are deduped in-run.
  MN  Campaign Finance Board bulk CSVs (itemized >$200 only), keyed by
      committee reg num.
  MA  OCPF api.ocpf.us textOutput TSV per CPF ID (schedules A and B).
  HI  Campaign Spending Commission datasets on opendata.hawaii.gov (CKAN
      datastore API, filtered by Reg No + Election Period).
  IA  Iowa Data Hub bulk ZIP download (datasets 917/918) — the old Socrata
      API is dead. Committees that predate the race are cycle-filtered.
  MD  MDCRIS open JSON API (api-campaignfinance.maryland.gov); per-committee
      CSV export with stable TransactionIDs; refund rows negated.
  WI  Sunshine data-download API (campaignfinance.wi.gov), date-windowed
      statewide CSV filtered client-side to tracked committees (stable
      transaction IDs; server truncates every download at 99,999 rows, so
      capped windows are split). Nightly runs cover the last 45 days;
      WI_SINCE=2025-01-01 for a full backfill.
  AL  FCPA (fcpa.alabamavotes.gov, entellitrak like MI) nightly bulk
      extracts, ids re-resolved from the transaction-data listing each run.
      The server sends a leaf-only TLS chain, so the GlobalSign intermediate
      is fetched and trusted at runtime. The Cash extract already contains
      the in-kind rows, so the separate In-Kind extract is skipped.
  AK  APOC per-candidate CSV exports (CDIncome/CDExpenditures WebForms:
      session + search POST, then exportAll GET). APOC has no filer ids —
      searches are by candidate last name with rows filtered to
      Office=Governor — and no transaction ids, so deterministic row hashes
      are synthesized. Connection resets are routine; every step retries.
  AR  SoS ethics-disclosures bulk CSV (Civix API like GA/ID), filtered by
      Filing Entity ID; stable Transaction IDs; Return Contribution rows
      negated.
  CT  SEEC eCRIS static election-cycle CSVs (candidate-committee receipts /
      disbursements), filtered by Committee ID. No transaction ids — rows
      hash to synthetic ids. CEP public-grant rows are relabeled so the
      Citizens' Election Program reads sensibly in donor tables.
  ID  Sunshine (api-sunshine.voteidaho.gov, Civix like GA/AR) bulk CSV per
      filing year, filtered by Filing Entity ID; stable Transaction Ids;
      Excel-escaped zips (="83702") unwrapped.
  IL  ISBE full tab-delimited dumps (Receipts.txt ~1 GB, Expenditures.txt
      ~0.8 GB), streamed line-by-line and filtered by CommitteeID; stable
      row IDs. Committees predate the race (Pritzker's dates to 2017), so
      rows before IL_SINCE (default 2025-01-01) are skipped.
  KS  SoS CFR viewer HTML scrape (ASP.NET WebForms postback chain per
      candidate/report/schedule; Kansas publishes no bulk data and no ids).
      Schedule A = contributions, Schedule C = expenditures; row hashes
      exclude the report id so amended re-filings dedupe.

Usage:
    python3 import_pilot_finance.py --states fl ga mi az ky pa co mn ma hi ia md wi al ak ar ct id il ks
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path
from urllib import request, parse

UA = ("Mozilla/5.0 (compatible; statepoliticstracker-importer/1.0; "
      "+https://github.com/dllpoliticalintegrity/state-politics-tracker)")
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# slug -> per-state committee identifiers. Must mirror cf_candidates.filer_refs.
COMMITTEES = {
    "ga": {  # Peachfile Filing Entity ID
        "keisha-lance-bottoms": "100663",
        "rick-jackson": "103524",
        "geoff-duncan": "101117",
        "burt-jones": "101091",
        "michael-thurmond": "100753",
        "chris-carr": "100035",
        "jason-esteves": "101119",
        # brad-raffensperger: no Peachfile committee found as of Jul 2026
        # Lt. Governor
        "greg-dolezal": "100021",
        "josh-mclaurin": "100828",
        "john-f-kennedy": "100122",
        "michael-tillery": "100007",
        "steve-gooch": "100060",
        "david-clark": "102478",
        "nabilah-parkes": "104502",
        "seth-clark": "101717",
        # Attorney General
        "brian-strickland": "102817",
        "tanya-miller": "102716",
        "bill-cowsert": "100055",
        "rob-trammell": "100430",
        # Secretary of State
        "tim-fleming": "100059",
        "penny-brown-reynolds": "103195",
        "kelvin-king": "103261",
        "gabriel-sterling": "103254",
        "vernon-jones": "100071",
        "dana-barrett": "101619",
    },
    "mi": {  # MiTN cfr_com_id (gubernatorial accounts only)
        "jocelyn-benson": "0521875",
        "john-james": "0606046",
        "garlin-gilchrist": "0521896",
        "chris-swanson": "0521893",
        "mike-duggan": "0521868",
        "aric-nesbitt": "0521877",
        "mike-cox": "0521871",
        # perry-johnson: no gubernatorial committee found as of Jul 2026
        # Attorney General / Secretary of State
        "eli-savit": "0606504",
        "doug-lloyd": "0607449",
        "mark-totten": "0606110",
        "barb-byrum": "0606536",
        "anthony-forlini": "0611210",
        # garlin-gilchrist (SoS run) keeps committee 0521896 above
    },
    "az": {  # SeeTheMoney: slug -> (exact committee name, committee id)
        "katie-hobbs": ("Elect Katie Hobbs", 201800057),
        "karrin-taylor-robson": ("Karrin for Arizona", 100592),
        "andy-biggs": ("Biggs for Arizona", 101830),
        "david-schweikert": ("David Schweikert for Governor", 101980),
        "kris-mayes": ("Kris Mayes for Arizona", 100626),
        "warren-petersen": ("Friends of Warren Petersen", 201600171),
        "rodney-glassman": ("Glassman for Attorney General", 101445),
        "adrian-fontes": ("Fontes for AZ", 100622),
        "gina-swoboda": ("Gina Swoboda for Arizona Secretary of State", 102117),
        # alexander-kolodin: no candidate committee found as of Jul 2026
    },
    "ky": {  # KREF: slug -> (recipient last, recipient first) — name-keyed
        "jacqueline-coleman": ("COLEMAN", "JACQUELINE"),
        "rocky-adkins": ("ADKINS", "ROCKY"),
        "rick-hardin": ("HARDIN", "RICK"),
        "brett-st-amand": ("ST. AMAND", "BRETT"),
        "charles-bruiser-martin": ("MARTIN", "CHARLES"),
        "geary-cooney": ("COONEY", "GEARY"),
    },
    "pa": {  # PA DOS full-export FILERID (committee records, FILERTYPE 2)
        "josh-shapiro": "20160016",
        "stacy-garrity": "20200025",
        # ken-krawchuk / tony-dastra: no committee filings as of Jul 2026
    },
    "co": {  # TRACER CO_ID
        "phil-weiser": "20255047944",
        "victor-marx": "20255051136",
        "michael-bennet": "20255048909",
        "barbara-kirkmeyer": "20255050775",
        "scott-bottoms": "20255047962",
        "jason-mikesell": "20255048097",
        # greg-lopez: no 2026 committee found as of Jul 2026
    },
    "mn": {  # CFB principal campaign committee reg num
        "amy-klobuchar": "19369",
        "mike-lindell": "19315",
        "lisa-demuth": "19287",
        "kendall-qualls": "19218",  # 2026 cmte; 18742 is his identically-named 2022 cmte
        "brad-kohler": "19215",
    },
    "ma": {  # OCPF CPF ID
        "maura-healey": "15710",
        "mike-minogue": "19431",
        "brian-shortsleeve": "19172",
        "mike-kennealy": "19091",
        "andrea-james": "19010",
    },
    "ia": {  # Iowa Data Hub committee_cd (dataset 917/918)
        "rob-sand": "5185",          # pre-existing auditor cmte — cycle-filtered
        "zach-lahn": "SWGA51409",
        "randy-feenstra": "SWGA51419",
        "adam-steen": "SWGA51203",
        "brad-sherman": "2640",      # pre-existing state-rep cmte — cycle-filtered
        "eddie-andrews": "SWGA51147",
        "nicholas-gluba": "SWGA51623",
    },
    "md": {  # MDCRIS: slug -> (Filing Entity ID, exact committee name)
        "wes-moore": ("1013630", "Moore, Wes For Maryland"),
        "dan-cox": ("1013697", "Cox, Dan for Governor"),
        "ed-hale": ("1015605", "Hale, (Edwin) for Gov"),
        # andy-ellis / cathy-white: no MDCRIS committees found as of Jul 2026
    },
    "hi": {  # Campaign Spending Commission Reg No (CKAN datasets)
        "josh-green": "CC10174",
        "gary-cordery": "CC11747",
        # bourgoin / fujiyama: no CSC filings for the 2022-2026 period
    },
    "wi": {  # Sunshine entity id (payee on contributions, payer on disbursements)
        "francesca-hong": "1145867",
        "david-crowley": "16295",
        "kelda-roys": "15992",
        "joel-brennan": "11966062",
        "mandela-barnes": "15552",
        "sara-rodriguez": "16403",
        "missy-hughes": "11957166",
        "tom-tiffany": "16621",
        "andy-manske": "11948172",
        "josh-schoemann": "7885743",
        "bill-berrien": "11948157",
    },
    "al": {  # FCPA CommitteeId (keys the bulk CSV extracts)
        "tommy-tuberville": "31625",
        "doug-jones": "32837",
    },
    "ak": {  # APOC has no filer ids — searched by candidate last name,
             # rows filtered to Office=Governor (solo + ticket registrations
             # both match the last-name substring search)
        "tom-begich": "Begich",
        "jonathan-kreiss-tomkins": "Kreiss-Tomkins",
        "bernadette-wilson": "Wilson",
        "matt-heilala": "Heilala",
        "treg-taylor": "Taylor",
        "adam-crum": "Crum",
        "click-bishop": "Bishop",
        "dave-bronson": "Bronson",
        "bill-walker": "Walker",
    },
    "ar": {  # ethics-disclosures Filing Entity ID
        "sarah-huckabee-sanders": "1004",
        "fredrick-love": "7490",
        "colt-shelby": "11037",
        "supha-xayprasith-mays": "9021",
    },
    "ct": {  # eCRIS Committee ID
        "ned-lamont": "14108",
        "josh-elliott": "14066",
        "ryan-fazio": "14082",
        "erin-stewart": "14119",
        "betsy-mccaughey": "14266",
        "jennifer-tooker": "14041",
    },
    "id": {  # Sunshine (voteidaho) Filing Entity ID
        "brad-little": "392",
        "terri-pickens": "219",
        "john-stegner": "3587",
        "paul-sand": "3870",
        "pro-life": "3629",
        "jacob-burnett": "3725",
        "mark-fitzpatrick": "3605",
    },
    "il": {  # ISBE committee ID
        "jb-pritzker": "32762",
        "darren-bailey": "34092",
        "collin-corbett": "41172",
        "ted-dabrowski": "40825",
        "rick-heidner": "40926",
        # mendrick: committee 27398 is his sheriff-era account (closed
        # 2026-04) — governor-race money can't be separated, so skipped.
    },
    "ks": {  # SoS CFR viewer — name-keyed (Kansas publishes no committee ids)
        "ty-masterson": "Masterson",
        "cindy-holscher": "Holscher",
    },
    "fl": {  # queried by candidate last name against office=GOV
        "byron-donalds": "Donalds",
        "david-jolly": "Jolly",
        "jay-collins": "Collins",
        "james-fishback": "Fishback",
        "paul-renner": "Renner",
        "jerry-demings": "Demings",
        # Row offices — (last name, office code) pairs
        "james-uthmeier": ("Uthmeier", "ATG"),
        "jose-javier-rodriguez": ("Rodriguez", "ATG"),
        "blaise-ingoglia": ("Ingoglia", "CFO"),
        "annette-taddeo": ("Taddeo", "CFO"),
        "frank-collige": ("Collige", "CFO"),
        "earle-ford": ("Ford", "CFO"),
        "wilton-simpson": ("Simpson", "AGR"),
        "matt-taylor": ("Taylor", "AGR"),
        "joey-mendoza-atkins": ("Mendoza Atkins", "AGR"),
        "don-prichard": ("Prichard", "AGR"),
    },
}

YEARS = [2025, 2026]
FL_ROW_LIMIT = 32000

ENTITY_PAT = re.compile(
    r"\b(INC|LLC|LLP|L\.L\.C|PAC|COMMITTEE|PARTY|CORP|CORPORATION|ASSN|"
    r"ASSOCIATION|COMPANY|FUND|GROUP|TRUST|BANK|ENTERPRISES|PARTNERS|"
    r"HOLDINGS|FLORIDA|AMERICA|USA|PA|PLLC|FARMS|SERVICES|CONSULTING|"
    r"REALTY|PROPERTIES|CLUB|COALITION|ALLIANCE|FEDERATION|UNION|CHAMBER)\b",
    re.I,
)


def http(url, data=None, headers=None, timeout=300, context=None):
    req = request.Request(url, data=data, headers=headers or {})
    with request.urlopen(req, timeout=timeout, context=context) as r:
        return r.read()


def http_retry(url, tries=3, **kw):
    """http() with retries — big bulk downloads (AR's ~100 MB CSVs) get cut
    off mid-body often enough that one attempt isn't reliable."""
    last = None
    for i in range(tries):
        try:
            return http(url, **kw)
        except Exception as ex:  # noqa: BLE001 — IncompleteRead, resets, timeouts
            last = ex
            print(f"   retry {i + 1}/{tries} {url.split('?')[0]}: {ex}", flush=True)
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"{url}: failed after {tries} tries: {last}")


# --------------------------------------------------------------------------
# Supabase
# --------------------------------------------------------------------------

def sb_get(path):
    return json.loads(http(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
    ))


def sb_upsert(table, rows, conflict="source,source_txn_id"):
    """Idempotent batch upsert via PostgREST."""
    if not rows:
        return
    body = json.dumps(rows).encode()
    http(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={parse.quote(conflict)}",
        data=body,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=minimal",
        },
    )


class Sink:
    """Buffers transformed rows and flushes them in batches."""

    def __init__(self, batch=2000):
        self.batch = batch
        self.buffers = {}
        self.counts = {}
        self._seen_ids = set()

    def txn_id(self, prefix, *parts):
        h = hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:16]
        base = f"{prefix}:{h}"
        tid, i = base, 0
        while tid in self._seen_ids:
            i += 1
            tid = f"{base}-{i}"
        self._seen_ids.add(tid)
        return tid

    def emit(self, table, row):
        buf = self.buffers.setdefault(table, [])
        buf.append(row)
        self.counts[table] = self.counts.get(table, 0) + 1
        if len(buf) >= self.batch:
            sb_upsert(table, buf)
            buf.clear()

    def flush(self):
        for table, buf in self.buffers.items():
            sb_upsert(table, buf)
            buf.clear()


# --------------------------------------------------------------------------
# Shared parsing helpers
# --------------------------------------------------------------------------

def mdy_to_iso(s):
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", (s or "").strip())
    return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}" if m else None


def money(s):
    s = (s or "").replace("$", "").replace(",", "").replace("(", "-").replace(")", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def city_state_zip(s):
    m = re.match(r"^(.*?),\s*([A-Z]{2})\s+([\d-]+)?\s*$", (s or "").strip())
    if m:
        return m.group(1), m.group(2), m.group(3)
    return (s or "").strip() or None, None, None


# --------------------------------------------------------------------------
# Florida
# --------------------------------------------------------------------------

FL_BASE = "https://dos.elections.myflorida.com"


def fl_form_defaults(page):
    """Parse a FL query form and return every field with its default value —
    the cgi builds broken SQL unless the full browser field set is posted."""
    h = http(f"{FL_BASE}/campaign-finance/{page}/", headers={"User-Agent": BROWSER_UA}).decode("utf-8", "replace")
    action = r"contrib\.exe" if page == "contributions" else r"expend\.exe"
    form = re.search(r"<form[^>]*%s.*?</form>" % action, h, re.S | re.I).group(0)
    fields = {}
    for m in re.finditer(r"<input([^>]*)>", form, re.I):
        attrs = m.group(1)
        nm = re.search(r'name="?([\w]+)"?', attrs, re.I)
        if not nm:
            continue
        n = nm.group(1)
        tm = re.search(r'type="?(\w+)"?', attrs, re.I)
        typ = (tm.group(1) if tm else "text").lower()
        vm = re.search(r'value="?([^">\s]*)"?', attrs, re.I)
        v = vm.group(1) if vm else ""
        if typ == "radio":
            if "checked" in attrs.lower():
                fields[n] = v
        elif typ in ("submit", "image"):
            fields.setdefault(n, v or "Submit")
        else:
            fields.setdefault(n, v)
    for m in re.finditer(r'<select[^>]*name="?(\w+)"?[^>]*>(.*?)</select>', form, re.S | re.I):
        n, body = m.group(1), m.group(2)
        sel = re.search(r'<option[^>]*selected[^>]*value="?([^">\s]*)"?', body, re.I)
        first = re.search(r'<option[^>]*value="?([^">\s]*)"?', body, re.I)
        fields[n] = (sel or first).group(1) if (sel or first) else ""
    return fields


def fl_query(exe, fields):
    body = parse.urlencode(fields).encode()
    raw = http(f"{FL_BASE}/cgi-bin/{exe}", data=body, headers={
        "User-Agent": BROWSER_UA,
        "Referer": f"{FL_BASE}/campaign-finance/",
        "Content-Type": "application/x-www-form-urlencoded",
    })
    time.sleep(0.5)
    return raw.decode("utf-8", "replace")


def fl_contrib_rows(base, last_name, date_from=None, date_to=None, office="GOV"):
    f = dict(base)
    f.update({"CanLName": last_name, "office": office, "queryformat": "2",
              "rowlimit": str(FL_ROW_LIMIT)})
    if date_from:
        f["cdatefrom"], f["cdateto"] = date_from, date_to
    text = fl_query("contrib.exe", f)
    rows = list(csv.reader(io.StringIO(text), delimiter="\t"))[1:]
    if len(rows) >= FL_ROW_LIMIT:
        if not date_from:
            # Full range truncated: re-query in yearly halves, recursively.
            out = []
            for a, b in [("01/01/2025", "06/30/2025"), ("07/01/2025", "12/31/2025"),
                         ("01/01/2026", "06/30/2026"), ("07/01/2026", "12/31/2026")]:
                out += fl_contrib_rows(base, last_name, a, b, office=office)
            return out
        # Window truncated: split it in half by month.
        fa, fb = date_from.split("/"), date_to.split("/")
        mid_m = (int(fa[0]) + int(fb[0])) // 2 or 1
        mid = f"{mid_m:02d}/15/{fa[2]}"
        return (fl_contrib_rows(base, last_name, date_from, mid, office=office) +
                fl_contrib_rows(base, last_name, mid, date_to, office=office))
    return rows


def import_florida(sink, cand_ids):
    con_base = fl_form_defaults("contributions")
    exp_base = fl_form_defaults("expenditures")
    for slug, spec in COMMITTEES["fl"].items():
        last, office = spec if isinstance(spec, tuple) else (spec, "GOV")
        cid = cand_ids[slug]
        for p in fl_contrib_rows(con_base, last, office=office):
            if len(p) < 8:
                continue
            acct, dt, amount, typ, name, addr, csz, occ = p[:8]
            amt = money(amount)
            if amt is None:
                continue
            iso = mdy_to_iso(dt)
            city, st, zc = city_state_zip(csz)
            name = name.strip()
            is_entity = bool(ENTITY_PAT.search(name)) or " " not in name
            if is_entity:
                lastn, firstn = name, None
            else:
                toks = name.split()
                lastn, firstn = toks[0].title(), " ".join(toks[1:]).title()
            tid = sink.txn_id("fl", acct, iso, amount, name, addr)
            if typ.strip().upper() == "LOA":
                sink.emit("cf_loans", {
                    "candidate_id": cid, "committee_id": f"fl:{slug}", "source_txn_id": tid,
                    "lender_type": "ENTITY" if is_entity else "INDIVIDUAL",
                    "lender_last_name": lastn, "lender_first_name": firstn,
                    "amount": amt, "loan_date": iso})
            else:
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"fl:{slug}", "source_txn_id": tid,
                    "contributor_type": "ENTITY" if is_entity else "INDIVIDUAL",
                    "contributor_last_name": lastn, "contributor_first_name": firstn,
                    "occupation": occ.strip() or None, "amount": amt,
                    "contribution_date": iso, "city": city, "state": st, "zip": zc,
                    "source_form_type": "INKIND" if typ.strip().upper() == "INK" else None})
        f = dict(exp_base)
        f.update({"CanLName": last, "office": office, "queryformat": "2",
                  "rowlimit": str(FL_ROW_LIMIT)})
        for p in list(csv.reader(io.StringIO(fl_query("expend.exe", f)), delimiter="\t"))[1:]:
            if len(p) < 7:
                continue
            acct, dt, amount, payee, addr, csz, purpose = p[:7]
            amt = money(amount)
            if amt is None:
                continue
            iso = mdy_to_iso(dt)
            city, st, zc = city_state_zip(csz)
            sink.emit("cf_expenditures", {
                "candidate_id": cid, "committee_id": f"fl:{slug}",
                "source_txn_id": sink.txn_id("fl", "exp", acct, iso, amount, payee, purpose),
                "payee_last_name": payee.strip() or None, "payee_city": city,
                "payee_state": st, "payee_zip": zc, "amount": amt,
                "expenditure_date": iso, "description": purpose.strip() or None})


# --------------------------------------------------------------------------
# Georgia
# --------------------------------------------------------------------------

GA_API = "https://api-peachfile.ethics.ga.gov/api"
GA_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Origin": "https://peachfile.ethics.ga.gov",
    "Referer": "https://peachfile.ethics.ga.gov/",
    "Content-Type": "application/json",
}


def import_georgia(sink, cand_ids):
    ent_to_slug = {v: k for k, v in COMMITTEES["ga"].items()}
    for year in YEARS:
        for code in ("TCON", "TEXP"):
            body = json.dumps({"Type": "CSV", "FilingYear": year,
                               "TransactionTypeCode": code}).encode()
            text = http(f"{GA_API}/ExportPublicData/GetExportPublicDownloadData",
                        data=body, headers=GA_HEADERS).decode("utf-8", "replace")
            rd = csv.DictReader(io.StringIO(text))
            rd.fieldnames = [c.strip() for c in rd.fieldnames]
            for row in rd:
                ent = (row.get("Filing Entity ID") or row.get("Filing Entity Id") or "").strip()
                slug = ent_to_slug.get(ent)
                if not slug:
                    continue
                cid = cand_ids[slug]
                amt = money(row.get("Transaction Amount"))
                if amt is None:
                    continue
                iso = mdy_to_iso(row.get("Transaction Date"))
                raw_tid = (row.get("Transaction Id") or row.get("Transaction ID") or "").strip()
                tid = f"ga:{raw_tid}" if raw_tid else sink.txn_id("ga", code, ent, iso, amt)
                if code == "TEXP":
                    sink.emit("cf_expenditures", {
                        "candidate_id": cid, "committee_id": f"ga:{ent}", "source_txn_id": tid,
                        "payee_last_name": (row.get("Payee Last Name") or "").strip() or None,
                        "payee_first_name": (row.get("Payee First Name") or "").strip() or None,
                        "payee_city": (row.get("Payee Address City") or "").strip() or None,
                        "payee_state": (row.get("Payee Address State") or "").strip() or None,
                        "amount": amt, "expenditure_date": iso,
                        "description": (row.get("Purpose") or "").strip() or None})
                    continue
                sub = (row.get("Transaction Sub Type") or "").strip()
                ctype_raw = (row.get("Contributor Type") or "").strip()
                if "loan" in sub.lower():
                    sink.emit("cf_loans", {
                        "candidate_id": cid, "committee_id": f"ga:{ent}", "source_txn_id": tid,
                        "lender_type": "INDIVIDUAL" if ctype_raw in ("Individual", "Self") else "ENTITY",
                        "lender_last_name": (row.get("Contributor Last Name") or "").strip() or None,
                        "lender_first_name": (row.get("Contributor First Name") or "").strip() or None,
                        "amount": amt, "loan_date": iso})
                    continue
                if sub == "Unitemized Contribution":
                    sink.emit("cf_contributions", {
                        "candidate_id": cid, "committee_id": f"ga:{ent}", "source_txn_id": tid,
                        "contributor_type": None,
                        "contributor_last_name": "Unitemized (small-dollar) contributions",
                        "amount": amt, "contribution_date": iso})
                    continue
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"ga:{ent}", "source_txn_id": tid,
                    "contributor_type": "INDIVIDUAL" if ctype_raw in ("Individual", "Self") else "ENTITY",
                    "contributor_last_name": (row.get("Contributor Last Name") or "").strip() or None,
                    "contributor_first_name": (row.get("Contributor First Name") or "").strip() or None,
                    "employer": (row.get("Contributor/Person Responsible for Loan Employer") or "").strip() or None,
                    "occupation": (row.get("Contributor/Person Responsible for Loan Occupation") or "").strip() or None,
                    "amount": amt, "contribution_date": iso,
                    "city": (row.get("Contributor Address City") or "").strip() or None,
                    "state": (row.get("Contributor Address State") or "").strip() or None,
                    "zip": (row.get("Contributor Address Zip Code") or "").replace("=", "").replace('"', "").strip() or None,
                    "source_form_type": "INKIND" if "In-Kind" in sub else None})


# --------------------------------------------------------------------------
# Michigan
# --------------------------------------------------------------------------

MI_BASE = "https://mi-boe.entellitrak.com/etk-mi-boe-prod/page.request.do"


def mi_file_list():
    raw = http(f"{MI_BASE}?page=gov.mi.boe.component.cfrexport.page.cfrexportresults"
               f"&pageSize=200&pageNumber=1&sortDirection=DESC&sortBy=year&type=",
               headers={"User-Agent": BROWSER_UA})
    return json.loads(raw)["data"]["list"]


def import_michigan(sink, cand_ids):
    com_to_slug = {v: k for k, v in COMMITTEES["mi"].items()}
    files = [f for f in mi_file_list()
             if str(f.get("year")) in {str(y) for y in YEARS}
             and f.get("transactiontype") in ("Contribution", "Expenditure")]
    for meta in files:
        raw = http(f"{MI_BASE}?page=gov.mi.boe.component.cfrexport.page.cfrexportfile"
                   f"&id={meta['download']}", headers={"User-Agent": BROWSER_UA})
        z = zipfile.ZipFile(io.BytesIO(raw))
        with io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8", errors="replace") as f:
            cols = f.readline().rstrip("\n").split("\t")
            idx = {c: i for i, c in enumerate(cols)}
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) < 10:
                    continue

                def g(c):
                    i = idx.get(c)
                    return p[i].strip() if i is not None and i < len(p) else ""

                slug = com_to_slug.get(g("cfr_com_id"))
                if not slug:
                    continue
                cid = cand_ids[slug]
                amt = money(g("amount"))
                if amt is None:
                    continue
                if meta["transactiontype"] == "Expenditure":
                    sink.emit("cf_expenditures", {
                        "candidate_id": cid, "committee_id": f"mi:{g('cfr_com_id')}",
                        "source_txn_id": f"mi:{g('expense_id')}-{g('detail_id')}",
                        "payee_last_name": g("payee_l_name_or_org") or None,
                        "payee_first_name": g("payee_f_name") or None,
                        "payee_city": g("payee_city") or None,
                        "payee_state": g("payee_state") or None,
                        "payee_zip": g("payee_zip") or None, "amount": amt,
                        "expenditure_date": mdy_to_iso(g("exp_date")),
                        "category": g("exp_desc") or None,
                        "description": g("purpose") or None})
                    continue
                iso = mdy_to_iso(g("received_date"))
                first = g("contributor_f_name") or None
                ctype = "INDIVIDUAL" if first else "ENTITY"
                tid = f"mi:{g('contribution_id')}-{g('cont_detail_id')}"
                if "loan" in g("contribtype").lower():
                    sink.emit("cf_loans", {
                        "candidate_id": cid, "committee_id": f"mi:{g('cfr_com_id')}",
                        "source_txn_id": tid, "lender_type": ctype,
                        "lender_last_name": g("contributor_l_name_or_org") or None,
                        "lender_first_name": first, "amount": amt, "loan_date": iso})
                    continue
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"mi:{g('cfr_com_id')}",
                    "source_txn_id": tid, "contributor_type": ctype,
                    "contributor_last_name": g("contributor_l_name_or_org") or None,
                    "contributor_first_name": first,
                    "employer": g("contributor_employer") or None,
                    "occupation": g("contributor_occupation") or None,
                    "amount": amt, "contribution_date": iso,
                    "city": g("contributor_city") or None,
                    "state": g("contributor_state") or None,
                    "zip": g("contributor_zip") or None,
                    "source_form_type": "INKIND" if "kind" in g("contribtype").lower() else None})


# --------------------------------------------------------------------------
# Arizona (SeeTheMoney AdvancedSearch JSON API)
# --------------------------------------------------------------------------

AZ_BASE = "https://seethemoney.az.gov/Reporting/AdvancedSearch/"
AZ_CYCLE = "44~1/1/2025 12:00:00 AM~12/31/2026 11:59:59 PM"
AZ_COLS = ["CommitteeID", "CommitteeName", "TransactionDate", "Amount",
           "TransactionName", "TransactionType", "Occupation", "Employer",
           "City", "State", "ZipCode", "FirstName", "LastName", "FilerName", "Memo"]


def az_net_date(sv):
    m = re.search(r"/Date\((\-?\d+)\)/", sv or "")
    if not m:
        return None
    import datetime
    return datetime.datetime.utcfromtimestamp(int(m.group(1)) / 1000).strftime("%Y-%m-%d")


def az_fetch(cat, filer_name, start, length=3000):
    qp = {"CommiteeReportId": "", "CategoryType": cat, "JurisdictionId": "0",
          "CycleId": AZ_CYCLE, "StartDate": "2025-01-01", "EndDate": "2026-12-31",
          "FilerName": filer_name, "FilerId": "", "BallotName": "", "BallotMeasureId": "",
          "FilerTypeId": "130", "OfficeTypeId": "", "OfficeId": "", "PartyId": "",
          "ContributorName": "", "VendorName": "", "StateId": "", "City": "",
          "Employer": "", "Occupation": "", "CandidateName": "", "CandidateFilerId": "",
          "Position": "Support", "LowAmount": "", "HighAmount": ""}
    body = {"draw": "1", "start": str(start), "length": str(length),
            "search[value]": "", "search[regex]": "false",
            "order[0][column]": "0", "order[0][dir]": "asc"}
    for i, c in enumerate(AZ_COLS):
        body[f"columns[{i}][data]"] = c
        body[f"columns[{i}][name]"] = ""
        body[f"columns[{i}][searchable]"] = "true"
        body[f"columns[{i}][orderable]"] = "true"
        body[f"columns[{i}][search][value]"] = ""
        body[f"columns[{i}][search][regex]"] = "false"
    url = AZ_BASE + "?" + parse.urlencode(qp)
    d = json.loads(http(url, data=parse.urlencode(body).encode(), headers={
        "User-Agent": BROWSER_UA, "Referer": AZ_BASE,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}))
    return d.get("recordsTotal") or 0, d.get("data") or []


def import_arizona(sink, cand_ids):
    http(AZ_BASE, headers={"User-Agent": BROWSER_UA})  # session cookies
    for slug, (cname, cid_num) in COMMITTEES["az"].items():
        cid = cand_ids[slug]
        for cat in ("Income", "Expenditures"):
            start = 0
            while True:
                total, rows = az_fetch(cat, cname, start)
                for r in rows:
                    if r.get("CommitteeID") != cid_num:
                        continue
                    amt = r.get("Amount")
                    if amt is None:
                        continue
                    iso = az_net_date(r.get("TransactionDate"))
                    ttype = (r.get("TransactionType") or "").strip()
                    name = (r.get("TransactionName") or "").strip()
                    first = (r.get("FirstName") or "").strip() or None
                    last = (r.get("LastName") or "").strip() or None
                    if not last and name:
                        if "," in name:
                            parts = [x.strip().title() or None for x in (name.split(",", 1) + [""])[:2]]
                            last, first = parts[0], parts[1]
                        else:
                            last = name
                    committee = f"az:{r.get('CommitteeID')}"
                    t = sink.txn_id("az", slug, cat, iso, amt, name, r.get("Memo"))
                    if cat == "Expenditures":
                        sink.emit("cf_expenditures", {
                            "candidate_id": cid, "committee_id": committee, "source_txn_id": t,
                            "payee_last_name": name or last,
                            "payee_city": (r.get("City") or "").strip() or None,
                            "payee_state": (r.get("State") or "").strip() or None,
                            "payee_zip": (r.get("ZipCode") or "").strip() or None,
                            "amount": amt, "expenditure_date": iso, "category": ttype or None,
                            "description": (r.get("Memo") or "").strip() or None})
                        continue
                    is_ind = any(k in ttype.lower() for k in ("individual", "personal", "family"))
                    if "loan" in ttype.lower():
                        sink.emit("cf_loans", {
                            "candidate_id": cid, "committee_id": committee, "source_txn_id": t,
                            "lender_type": "INDIVIDUAL" if is_ind else "ENTITY",
                            "lender_last_name": last, "lender_first_name": first,
                            "amount": amt, "loan_date": iso})
                        continue
                    sink.emit("cf_contributions", {
                        "candidate_id": cid, "committee_id": committee, "source_txn_id": t,
                        "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                        "contributor_last_name": last, "contributor_first_name": first,
                        "employer": (r.get("Employer") or "").strip() or None,
                        "occupation": (r.get("Occupation") or "").strip() or None,
                        "amount": amt, "contribution_date": iso,
                        "city": (r.get("City") or "").strip() or None,
                        "state": (r.get("State") or "").strip() or None,
                        "zip": (r.get("ZipCode") or "").strip() or None})
                start += 3000
                if start >= total or not rows:
                    break
                time.sleep(0.3)


# --------------------------------------------------------------------------
# Kentucky (KREF flat CSV exports; 2027 governor cycle)
# --------------------------------------------------------------------------

KY_BASE = "https://secure.kentucky.gov/kref/publicsearch"
KY_YEARS = [2025, 2026, 2027]


def import_kentucky(sink, cand_ids):
    name_to_slug = {v: k for k, v in COMMITTEES["ky"].items()}
    for year in KY_YEARS:
        try:
            text = http(f"{KY_BASE}/ExportContributors?ElectionDate=01%2F01%2F0001%2000%3A00%3A00"
                        f"&ContributionSearchType=All&MinimalDate={year}-01-01&MaximalDate={year}-12-31",
                        headers={"User-Agent": BROWSER_UA}).decode("utf-8", "replace")
        except Exception:
            continue
        for row in csv.DictReader(io.StringIO(text)):
            if (row.get("Office Sought") or "").strip().upper() != "GOVERNOR":
                continue
            if "2027" not in (row.get("Election Date") or ""):
                continue
            first_tok = ((row.get("Recipient First Name") or "").strip().upper().split() or [""])[0]
            key = ((row.get("Recipient Last Name") or "").strip().upper(), first_tok)
            slug = name_to_slug.get(key)
            if not slug:
                continue
            amt = money(row.get("Amount"))
            if amt is None:
                continue
            org = (row.get("From Organization Name") or "").strip()
            sink.emit("cf_contributions", {
                "candidate_id": cand_ids[slug], "committee_id": f"ky:{key[0]},{key[1]}",
                "source_txn_id": sink.txn_id("ky", year, slug, row.get("Contributor Last Name"),
                                             row.get("Contributor First Name"), org,
                                             row.get("Amount"), row.get("Address 1")),
                "contributor_type": "ENTITY" if org else "INDIVIDUAL",
                "contributor_last_name": org or (row.get("Contributor Last Name") or "").strip() or None,
                "contributor_first_name": None if org else ((row.get("Contributor First Name") or "").strip() or None),
                "amount": amt, "contribution_date": None,
                "city": (row.get("City") or "").strip() or None,
                "state": (row.get("State") or "").strip() or None,
                "zip": (row.get("Zip") or "").strip() or None, "cycle": "2027"})
    for year in KY_YEARS:
        min_date = parse.quote(f"01/01/{year} 00:00:00")
        max_date = parse.quote(f"12/31/{year} 00:00:00")
        try:
            text = http(f"{KY_BASE}/Export?ElectionDate=01%2F01%2F0001%2000%3A00%3A00"
                        f"&MinimalDate={min_date}&MaximalDate={max_date}",
                        headers={"User-Agent": BROWSER_UA}).decode("utf-8", "replace")
        except Exception:
            continue
        for row in csv.DictReader(io.StringIO(text)):
            fc_last = (row.get("From Candidate Last Name") or "").strip().upper()
            fc_first = ((row.get("From Candidate First Name") or "").strip().upper().split() or [""])[0]
            slug = name_to_slug.get((fc_last, fc_first))
            if not slug:
                continue
            if (row.get("Office Sought") or "GOVERNOR").strip().upper() != "GOVERNOR":
                continue
            amt = money(row.get("Disbursement Amount"))
            if amt is None:
                continue
            sink.emit("cf_expenditures", {
                "candidate_id": cand_ids[slug], "committee_id": f"ky:{fc_last},{fc_first}",
                "source_txn_id": sink.txn_id("ky", "exp", year, slug, row.get("Recipient Last Name"),
                                             row.get("Organization Name"), row.get("Disbursement Amount"),
                                             row.get("Disbursement Date")),
                "payee_last_name": (row.get("Organization Name") or row.get("Recipient Last Name") or "").strip() or None,
                "payee_first_name": (row.get("Recipient First Name") or "").strip() or None,
                "amount": amt, "expenditure_date": mdy_to_iso(row.get("Disbursement Date")),
                "description": (row.get("Purpose") or "").strip() or None, "cycle": "2027"})


# --------------------------------------------------------------------------
# Pennsylvania — DOS annual full-export ZIPs (header row, cp1252, quoted CSV)
# --------------------------------------------------------------------------

PA_BASE = ("https://www.pa.gov/content/dam/copapwp-pagov/en/dos/resources/"
           "voting-and-elections/campaign-finance/campaign-finance-data")


def pa_date(s):
    s = (s or "").strip()
    return f"{s[:4]}-{s[4:6]}-{s[6:]}" if len(s) == 8 and s.isdigit() else None


def import_pennsylvania(sink, cand_ids):
    ids = {v: k for k, v in COMMITTEES["pa"].items()}

    def rows_of(zf, name):
        with zf.open(name) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, encoding="cp1252", errors="replace"))

    def cfid_of(row):
        return int(row[next(k for k in row if k.lower() == "campaignfinanceid")])

    for year in YEARS:
        try:
            blob = http(f"{PA_BASE}/{year}.zip", headers={"User-Agent": UA})
        except Exception:
            continue
        zf = zipfile.ZipFile(io.BytesIO(blob))
        for kind, fname, filer_col in (("con", f"contrib_{year}.txt", "FilerID"),
                                       ("exp", f"expense_{year}.txt", "FILERID")):
            # The export repeats rows for amended filings — keep only the
            # latest filing (max CampaignFinanceID) per (filer, EYEAR, CYCLE).
            best = {}
            for row in rows_of(zf, fname):
                filer = (row.get(filer_col) or "").strip()
                if filer not in ids:
                    continue
                key = (filer, row["EYEAR"], row["CYCLE"])
                best[key] = max(best.get(key, 0), cfid_of(row))
            for row in rows_of(zf, fname):
                filer = (row.get(filer_col) or "").strip()
                if filer not in ids:
                    continue
                if cfid_of(row) != best[(filer, row["EYEAR"], row["CYCLE"])]:
                    continue
                slug = ids[filer]
                if kind == "exp":
                    amt = money(row.get("EXPAMT"))
                    if not amt:
                        continue
                    d = pa_date(row.get("EXPDATE"))
                    sink.emit("cf_expenditures", {
                        "candidate_id": cand_ids[slug], "committee_id": f"pa:{filer}",
                        "source_txn_id": sink.txn_id("pa", filer, "exp", year, row["CYCLE"],
                                                     row.get("EXPNAME"), d, amt),
                        "payee_last_name": (row.get("EXPNAME") or "").strip() or None,
                        "amount": amt, "expenditure_date": d,
                        "description": (row.get("EXPDESC") or "").strip() or None,
                        "payee_city": (row.get("CITY") or "").strip() or None,
                        "payee_state": (row.get("STATE") or "").strip() or None,
                        "payee_zip": (row.get("ZIPCODE") or "").strip() or None,
                        "cycle": "2026"})
                    continue
                # PA contributor names are "First Last" plain strings with no
                # entity flag — classify by entity keywords, like FL.
                name = (row.get("CONTRIBUTOR") or "").strip()
                if ENTITY_PAT.search(name):
                    last, first, ctype = name, "", "ENTITY"
                else:
                    ctype = "INDIVIDUAL"
                    if "," in name:
                        last, _, first = [x.strip() for x in name.partition(",")]
                    else:
                        parts = name.rsplit(None, 1)
                        first, last = (parts[0], parts[1]) if len(parts) == 2 else ("", name)
                for i in ("1", "2", "3"):
                    amt = money(row.get(f"CONTAMT{i}"))
                    if not amt:
                        continue
                    d = pa_date(row.get(f"CONTDATE{i}"))
                    sink.emit("cf_contributions", {
                        "candidate_id": cand_ids[slug], "committee_id": f"pa:{filer}",
                        "source_txn_id": sink.txn_id("pa", filer, year, row["CYCLE"], name, d, amt),
                        "contributor_type": ctype,
                        "contributor_last_name": last or None,
                        "contributor_first_name": first or None,
                        "employer": (row.get("ENAME") or "").strip() or None,
                        "occupation": (row.get("OCCUPATION") or "").strip() or None,
                        "amount": amt, "contribution_date": d,
                        "city": (row.get("CITY") or "").strip() or None,
                        "state": (row.get("STATE") or "").strip() or None,
                        "zip": (row.get("ZIPCODE") or "").strip() or None,
                        "cycle": "2026"})


# --------------------------------------------------------------------------
# Wisconsin — Sunshine data-download API (date-windowed statewide CSV)
# --------------------------------------------------------------------------

WI_API = "https://campaignfinance.wi.gov/api/data-download/transactions"
WI_ROW_CAP = 99_999


def import_wisconsin(sink, cand_ids):
    """Sunshine (campaignfinance.wi.gov) data-download API: date-windowed CSV
    pulls of the statewide transactions feed, filtered client-side to tracked
    committees (the endpoint ignores committee filters). Every download is
    silently truncated at 99,999 rows, so windows that come back at the cap
    are split in half and re-fetched. The committee's entity id appears as
    the Payee on Contribution rows and as the Contributor/payer on
    Disbursement rows; Conduit Contribution rows are pass-through duplicates
    and are skipped. Backfill from 2025-01-01 ran Aug 2026 (source_txn_id
    'wi:<ID>' upserts keep re-runs idempotent); WI_SINCE overrides the
    default window start for a fresh backfill."""
    eids = {v: k for k, v in COMMITTEES["wi"].items()}
    since = os.environ.get("WI_SINCE") or (date.today() - timedelta(days=45)).isoformat()
    today = date.today().isoformat()

    def fetch_window(d_from, d_to):
        q = parse.quote(json.dumps({"dateFrom": f"{d_from}T00:00:00.000Z",
                                    "dateTo": f"{d_to}T00:00:00.000Z"}))
        blob = http(f"{WI_API}?queryParams={q}", headers={"User-Agent": UA})
        text = blob.decode("utf-8-sig", errors="replace")
        rows = list(csv.DictReader(io.StringIO(text)))
        if len(rows) >= WI_ROW_CAP and d_from != d_to:
            mid = date.fromordinal((date.fromisoformat(d_from).toordinal() +
                                    date.fromisoformat(d_to).toordinal()) // 2).isoformat()
            return fetch_window(d_from, mid) + fetch_window(
                (date.fromordinal(date.fromisoformat(mid).toordinal() + 1)).isoformat(), d_to)
        return rows

    def split_name(name):
        name = (name or "").strip()
        if "," in name:
            last, _, first = [x.strip() for x in name.partition(",")]
            return first, last
        parts = name.rsplit(None, 1)
        return (parts[0], parts[1]) if len(parts) == 2 else ("", name)

    seen = set()
    for row in fetch_window(since, today):
        ttype = row.get("Transaction Type")
        if ttype == "Contribution":
            eid = (row.get("Payee Entity ID") or "").strip()
        elif ttype == "Disbursement":
            eid = (row.get("Contributor Entity ID (-> Related Payer Entity ID if applicable)") or "").strip()
        else:
            continue  # Conduit Contribution etc. — pass-through duplicates
        slug = eids.get(eid)
        if not slug:
            continue
        tid = row.get("ID")
        if not tid or tid in seen:
            continue
        seen.add(tid)
        amt = money(row.get("Amount"))
        if amt is None:
            continue
        cat = row.get("Transaction Category") or ""
        d = mdy_to_iso(row.get("Date"))
        base = {"candidate_id": cand_ids[slug], "committee_id": f"wi:{eid}",
                "source_txn_id": f"wi:{tid}", "cycle": "2026"}
        if ttype == "Contribution":
            name = row.get("Contributor Name (-> Related Payer Name if applicable)") or ""
            is_ind = row.get("Contributor Entity Type") == "Individual"
            first, last = split_name(name) if is_ind else ("", name.strip())
            if "Loan" in cat and cat != "Loan Forgiven":
                sink.emit("cf_loans", {**base,
                    "lender_type": "INDIVIDUAL" if is_ind else "ENTITY",
                    "lender_last_name": last or None,
                    "lender_first_name": first or None,
                    "amount": amt, "loan_date": d})
            else:
                sink.emit("cf_contributions", {**base,
                    "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                    "contributor_last_name": last or None,
                    "contributor_first_name": first or None,
                    "occupation": (row.get("Contributor Occupation") or "").strip() or None,
                    "amount": amt, "contribution_date": d,
                    "city": (row.get("Contributor City") or "").strip() or None,
                    "state": (row.get("Contributor State") or "").strip() or None,
                    "zip": (row.get("Contributor Zip") or "").strip() or None,
                    "source_form_type": "INKIND" if cat == "In-Kind" else None})
        else:
            payee = (row.get("Payee Name") or "").strip()
            sink.emit("cf_expenditures", {**base,
                "payee_last_name": payee or None,
                "amount": amt, "expenditure_date": d,
                "category": cat or None,
                "description": (row.get("Transaction Purpose") or "").strip() or None,
                "payee_city": (row.get("Payee City") or "").strip() or None,
                "payee_state": (row.get("Payee State") or "").strip() or None,
                "payee_zip": (row.get("Payee Zip") or "").strip() or None})


# --------------------------------------------------------------------------
# Colorado — TRACER bulk CSV zips; rows carry stable RecordIDs
# --------------------------------------------------------------------------

CO_BASE = "https://tracer.sos.colorado.gov/PublicSite/Docs/BulkDataDownloads"


def import_colorado(sink, cand_ids):
    ids = {v: k for k, v in COMMITTEES["co"].items()}
    seen = set()
    for year in YEARS:
        for kind, fname in (("con", f"{year}_ContributionData.csv.zip"),
                            ("exp", f"{year}_ExpenditureData.csv.zip"),
                            ("loan", f"{year}_LoanData.csv.zip")):
            try:
                blob = http(f"{CO_BASE}/{fname}", headers={"User-Agent": UA})
            except Exception:
                continue
            zf = zipfile.ZipFile(io.BytesIO(blob))
            inner = zf.namelist()[0]
            reader = csv.DictReader(io.TextIOWrapper(zf.open(inner), encoding="utf-8",
                                                     errors="replace"))
            for row in reader:
                co_id = row.get("CO_ID")
                if co_id not in ids or row.get("Amended") == "Y":
                    continue
                rec = row["RecordID"]
                if rec in seen:  # year files overlap by filing period
                    continue
                seen.add(rec)
                slug = ids[co_id]
                base = {"candidate_id": cand_ids[slug], "committee_id": f"co:{co_id}",
                        "source_txn_id": f"co:{rec}", "cycle": "2026"}
                if kind == "con":
                    amt = money(row.get("ContributionAmount"))
                    if amt is None:
                        continue
                    is_ind = (row.get("ContributorType") or "").strip().lower() == "individual"
                    sink.emit("cf_contributions", {**base,
                        "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                        "contributor_last_name": (row.get("LastName") or "").strip() or None,
                        "contributor_first_name": (row.get("FirstName") or "").strip() or None,
                        "employer": (row.get("Employer") or "").strip() or None,
                        "occupation": (row.get("Occupation") or "").strip() or None,
                        "amount": amt,
                        "contribution_date": (row.get("ContributionDate") or "")[:10] or None,
                        "city": (row.get("City") or "").strip() or None,
                        "state": (row.get("State") or "").strip() or None,
                        "zip": (row.get("Zip") or "").strip() or None})
                elif kind == "exp":
                    amt = money(row.get("ExpenditureAmount"))
                    if amt is None:
                        continue
                    payee = " ".join(x for x in ((row.get("FirstName") or "").strip(),
                                                 (row.get("LastName") or "").strip()) if x)
                    sink.emit("cf_expenditures", {**base,
                        "payee_last_name": payee or None, "amount": amt,
                        "expenditure_date": (row.get("ExpenditureDate") or "")[:10] or None,
                        "category": (row.get("ExpenditureType") or "").strip() or None,
                        "description": (row.get("Explanation") or "").strip() or None,
                        "payee_city": (row.get("City") or "").strip() or None,
                        "payee_state": (row.get("State") or "").strip() or None,
                        "payee_zip": (row.get("Zip") or "").strip() or None})
                else:
                    amt = money(row.get("LoanAmount")) or money(row.get("PaymentAmount"))
                    if not amt:
                        continue
                    src = (row.get("LoanSourceType") or "").lower()
                    sink.emit("cf_loans", {**base,
                        "lender_type": "INDIVIDUAL" if ("candidate" in src or "individual" in src) else "ENTITY",
                        "lender_last_name": (row.get("Name") or "").strip() or None,
                        "amount": amt,
                        "loan_date": (row.get("LoanDate") or row.get("PaymentDate") or "")[:10] or None})


# --------------------------------------------------------------------------
# Minnesota — CFB bulk CSVs (itemized >$200, 2015-present snapshots)
# --------------------------------------------------------------------------

MN_URL = "https://cfb.mn.gov/reports-and-data/self-help/data-downloads/campaign-finance"
MN_CONTRIB_DL = "-2026985457"   # itemized contributions to candidate committees
MN_EXPEND_DL = "-1315784544"    # expenditures incl. contributions made


def import_minnesota(sink, cand_ids):
    ids = {v: k for k, v in COMMITTEES["mn"].items()}
    text = http(f"{MN_URL}?download={MN_CONTRIB_DL}",
                headers={"User-Agent": BROWSER_UA}).decode("utf-8-sig", "replace")
    for row in csv.DictReader(io.StringIO(text)):
        reg = (row.get("Recipient reg num") or "").strip()
        if reg not in ids:
            continue
        amt = money(row.get("Amount"))
        if not amt:
            continue
        name = (row.get("Contributor") or "").strip()
        is_ind = (row.get("Contrib type") or "").strip().lower() in ("individual", "self", "candidate")
        if is_ind and "," in name:
            last, _, first = [x.strip() for x in name.partition(",")]
        else:
            last, first = name, ""
        d = (row.get("Receipt date") or "").strip() or None
        sink.emit("cf_contributions", {
            "candidate_id": cand_ids[ids[reg]], "committee_id": f"mn:{reg}",
            "source_txn_id": sink.txn_id("mn", reg, d, name, amt, row.get("In kind?")),
            "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
            "contributor_last_name": last or None, "contributor_first_name": first or None,
            "employer": (row.get("Contrib Employer name") or "").strip() or None,
            "amount": amt, "contribution_date": d,
            "zip": (row.get("Contrib zip") or "").strip() or None, "cycle": "2026"})
    text = http(f"{MN_URL}?download={MN_EXPEND_DL}",
                headers={"User-Agent": BROWSER_UA}).decode("utf-8-sig", "replace")
    for row in csv.DictReader(io.StringIO(text)):
        reg = (row.get("Committee reg num") or "").strip()
        if reg not in ids:
            continue
        amt = money(row.get("Amount"))
        if not amt:
            continue
        d = (row.get("Date") or "").strip() or None
        vendor = (row.get("Vendor name") or "").strip()
        sink.emit("cf_expenditures", {
            "candidate_id": cand_ids[ids[reg]], "committee_id": f"mn:{reg}",
            "source_txn_id": sink.txn_id("mn", reg, "exp", d, vendor, amt),
            "payee_last_name": vendor or None, "amount": amt, "expenditure_date": d,
            "category": (row.get("Type") or "").strip() or None,
            "description": (row.get("Purpose") or "").strip() or None,
            "payee_city": (row.get("Vendor city") or "").strip() or None,
            "payee_state": (row.get("Vendor state") or "").strip() or None,
            "payee_zip": (row.get("Vendor zip") or "").strip() or None, "cycle": "2026"})


# --------------------------------------------------------------------------
# Massachusetts — OCPF textOutput TSV per committee (A=receipts, B=expends)
# --------------------------------------------------------------------------

MA_BASE = "https://api.ocpf.us/search/textOutput"


def import_massachusetts(sink, cand_ids):
    for slug, cpf in COMMITTEES["ma"].items():
        for cat in ("A", "B"):
            url = (f"{MA_BASE}?searchTypeCategory={cat}&cpfId={cpf}"
                   f"&startDate=01/01/2025&endDate=12/31/2026"
                   f"&sortDirection=DESC&recordTypeId=-1")
            try:
                text = http(url, headers={"User-Agent": UA}).decode("utf-8-sig", "replace")
            except Exception:
                continue
            for row in csv.DictReader(io.StringIO(text), delimiter="\t"):
                amt = money(row.get("Amount"))
                if not amt:
                    continue
                d = mdy_to_iso((row.get("Date") or "").strip('"'))
                if cat == "B":
                    payee = " ".join(x for x in ((row.get("First Name") or "").strip(),
                                                 (row.get("Name") or "").strip()) if x)
                    sink.emit("cf_expenditures", {
                        "candidate_id": cand_ids[slug], "committee_id": f"ma:{cpf}",
                        "source_txn_id": sink.txn_id("ma", cpf, "exp", d, payee, amt),
                        "payee_last_name": payee or None, "amount": amt,
                        "expenditure_date": d,
                        "description": (row.get("Description") or "").strip() or None,
                        "payee_city": (row.get("City") or "").strip() or None,
                        "payee_state": (row.get("State") or "").strip() or None,
                        "payee_zip": (row.get("Zip Code") or "").strip() or None,
                        "cycle": "2026"})
                    continue
                last = (row.get("Name") or "").strip() or None
                first = (row.get("First Name") or "").strip() or None
                sink.emit("cf_contributions", {
                    "candidate_id": cand_ids[slug], "committee_id": f"ma:{cpf}",
                    "source_txn_id": sink.txn_id("ma", cpf, d, last, first, amt,
                                                 row.get("Tender Type ID")),
                    "contributor_type": "INDIVIDUAL" if (row.get("Record Type ID") or "").strip() == "201" else "ENTITY",
                    "contributor_last_name": last, "contributor_first_name": first,
                    "employer": (row.get("Employer") or "").strip() or None,
                    "occupation": (row.get("Occupation") or "").strip() or None,
                    "amount": amt, "contribution_date": d,
                    "city": (row.get("City") or "").strip() or None,
                    "state": (row.get("State") or "").strip() or None,
                    "zip": (row.get("Zip Code") or "").strip() or None, "cycle": "2026"})


# --------------------------------------------------------------------------
# Hawaii — Campaign Spending Commission datasets on opendata.hawaii.gov (CKAN)
# --------------------------------------------------------------------------

HI_API = "https://opendata.hawaii.gov/api/3/action/datastore_search"
HI_CON_RES = "443bd998-1ef3-47da-9170-c2c376b2e41c"
HI_EXP_RES = "ca3ac02a-eb44-4b44-b3a7-5f60653cc1d3"
HI_PERIOD = "2022-2026"


def hi_fetch(resource, reg):
    q = parse.urlencode({
        "resource_id": resource,
        "filters": json.dumps({"Reg No": reg, "Election Period": HI_PERIOD}),
        "limit": 50000})
    data = json.loads(http(f"{HI_API}?{q}", headers={"User-Agent": UA}))
    return data["result"]["records"]


def import_hawaii(sink, cand_ids):
    for slug, reg in COMMITTEES["hi"].items():
        for r in hi_fetch(HI_CON_RES, reg):
            amt = money(str(r.get("Amount")))
            if amt is None:
                continue
            name = (r.get("Contributor Name") or "").strip()
            is_ind = (r.get("Contributor Type") or "").strip().lower() in (
                "individual", "immediate family", "candidate")
            if is_ind and "," in name:
                last, _, first = [x.strip() for x in name.partition(",")]
            else:
                last, first = name, ""
            sink.emit("cf_contributions", {
                "candidate_id": cand_ids[slug], "committee_id": f"hi:{reg}",
                "source_txn_id": f"hi:con:{r['_id']}",
                "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                "contributor_last_name": last or None, "contributor_first_name": first or None,
                "employer": (r.get("Employer") or "").strip() or None,
                "occupation": (r.get("Occupation") or "").strip() or None,
                "amount": amt, "contribution_date": (r.get("Date") or "")[:10] or None,
                "city": (r.get("City") or "").strip() or None,
                "state": ((r.get("State") or "").strip() or None),
                "zip": (r.get("Zip Code") or "").strip() or None, "cycle": "2026"})
        for r in hi_fetch(HI_EXP_RES, reg):
            amt = money(str(r.get("Amount")))
            if amt is None:
                continue
            sink.emit("cf_expenditures", {
                "candidate_id": cand_ids[slug], "committee_id": f"hi:{reg}",
                "source_txn_id": f"hi:exp:{r['_id']}",
                "payee_last_name": (r.get("Vendor Name") or "").strip() or None,
                "amount": amt, "expenditure_date": (r.get("Date") or "")[:10] or None,
                "category": (r.get("Expenditure Category") or "").strip() or None,
                "description": (r.get("Purpose of Expenditure") or "").strip() or None,
                "cycle": "2026"})


# --------------------------------------------------------------------------
# Iowa — Data Hub bulk ZIPs (the old Socrata/SODA API is gone; data.iowa.gov
# is now a Next.js app over BigQuery). /api/dataset-download works directly
# and unauthenticated; dataset 917 = contributions (multi-part CSV zip),
# 918 = expenditures. Rows carry no ids -> deterministic hash txn ids.
# --------------------------------------------------------------------------

IA_DL = "https://data.iowa.gov/api/dataset-download?path=datasets%2F{}%2Frows.csv"
# Sand (5185) and Sherman (2640) reuse committees that predate the 2026
# governor's race — only rows from the 2026 cycle belong in the tracker.
IA_CYCLE_FILTERED = {"5185", "2640"}
IA_CYCLE_START = "2025-01-01"


def import_iowa(sink, cand_ids):
    ids = {v: k for k, v in COMMITTEES["ia"].items()}

    def rows_of(dataset):
        zf = zipfile.ZipFile(io.BytesIO(http(IA_DL.format(dataset), headers={"User-Agent": UA})))
        for inner in zf.namelist():
            with zf.open(inner) as f:
                yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"))

    for row in rows_of("917"):
        code = (row.get("committee_cd") or "").strip()
        if code not in ids:
            continue
        d = (row.get("contribution_received_date") or "").strip()[:10] or None
        if code in IA_CYCLE_FILTERED and (not d or d < IA_CYCLE_START):
            continue
        amt = money(row.get("amount"))
        if amt is None:
            continue
        slug = ids[code]
        org = (row.get("organization_nm") or "").strip()
        first = (row.get("first_nm") or "").strip()
        last = (row.get("last_nm") or "").strip()
        txn = sink.txn_id("ia", code, d, first, last, org, row.get("amount"),
                          row.get("check_number"), row.get("address_line_1"))
        if row.get("transaction_type") == "LOANREC":
            sink.emit("cf_loans", {
                "candidate_id": cand_ids[slug], "committee_id": f"ia:{code}",
                "source_txn_id": txn,
                "lender_type": "ENTITY" if org else "INDIVIDUAL",
                "lender_last_name": org or last or None,
                "lender_first_name": None if org else (first or None),
                "amount": amt, "loan_date": d, "cycle": "2026"})
            continue
        sink.emit("cf_contributions", {
            "candidate_id": cand_ids[slug], "committee_id": f"ia:{code}",
            "source_txn_id": txn,
            "contributor_type": "ENTITY" if org else "INDIVIDUAL",
            "contributor_last_name": org or last or None,
            "contributor_first_name": None if org else (first or None),
            "amount": amt, "contribution_date": d,
            "city": (row.get("city") or "").strip() or None,
            "state": (row.get("state") or "").strip() or None,
            "zip": (row.get("zip_code") or "").strip() or None,
            "source_form_type": "INKIND" if row.get("transaction_type") == "INK" else None,
            "cycle": "2026"})

    for row in rows_of("918"):
        code = (row.get("committee_cd") or "").strip()
        if code not in ids:
            continue
        d = (row.get("calendar_date") or "").strip()[:10] or None
        if code in IA_CYCLE_FILTERED and (not d or d < IA_CYCLE_START):
            continue
        amt = money(row.get("amount"))
        if amt is None:
            continue
        slug = ids[code]
        org = (row.get("organization_nm") or "").strip()
        first = (row.get("first_nm") or "").strip()
        last = (row.get("last_nm") or "").strip()
        sink.emit("cf_expenditures", {
            "candidate_id": cand_ids[slug], "committee_id": f"ia:{code}",
            "source_txn_id": sink.txn_id("ia", "exp", code, d, org, last,
                                         row.get("amount"), row.get("check_number")),
            "payee_last_name": org or last or None,
            "payee_first_name": None if org else (first or None),
            "amount": amt, "expenditure_date": d,
            "payee_city": (row.get("city") or "").strip() or None,
            "payee_state": (row.get("state_cd") or "").strip() or None,
            "payee_zip": (row.get("zip_code") or "").strip() or None,
            "cycle": "2026"})


# --------------------------------------------------------------------------
# Maryland — MDCRIS open JSON API; DownloadPublicGridData returns the ENTIRE
# filtered set as CSV (line 1 is a title, real header on line 2). Rows carry
# stable TransactionIDs. Refund rows ("(Return)") export positive — negate.
# --------------------------------------------------------------------------

MD_API = "https://api-campaignfinance.maryland.gov/api/PublicGrid/DownloadPublicGridData"


def md_csv(grid, filter_key, committee_name, extra=None):
    body = {"publicGridName": grid, "fileName": "export", "type": "CSV",
            filter_key: {"pageNumber": 1, "pageSize": 100, "sortBy": "TransactionDate",
                         "sortType": "DESC", "filerName": committee_name,
                         "fromDate": "2025-01-01", "toDate": "2026-12-31",
                         **(extra or {})}}
    text = http(MD_API, data=json.dumps(body).encode(),
                headers={"User-Agent": UA, "Content-Type": "application/json"}
                ).decode("utf-8-sig", "replace")
    lines = io.StringIO(text)
    next(lines)  # title line
    return csv.DictReader(lines)


def import_maryland(sink, cand_ids):
    for slug, (entity_id, cmte_name) in COMMITTEES["md"].items():
        for row in md_csv("ContributionPublicGrid", "contributionSearchFilter",
                          cmte_name, {"transactionTypeCode": "TCON"}):
            amt = money(row.get("Transaction Amount"))
            if amt is None:
                continue
            if "(Return)" in (row.get("Contribution Type") or "") and amt > 0:
                amt = -amt
            is_ind = (row.get("Contributor Type") or "").strip() == "Individual"
            name = (row.get("Contributor Name") or "").strip()
            if is_ind and "," in name:
                last, _, first = [x.strip() for x in name.partition(",")]
            else:
                last, first = name, ""
            sink.emit("cf_contributions", {
                "candidate_id": cand_ids[slug], "committee_id": f"md:{entity_id}",
                "source_txn_id": f"md:con:{row['TransactionID']}",
                "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                "contributor_last_name": last or None,
                "contributor_first_name": first or None,
                "amount": amt, "contribution_date": mdy_to_iso(row.get("Transaction Date")),
                "city": (row.get("Contributor City") or "").strip() or None,
                "state": (row.get("Contributor State") or "").strip() or None,
                "zip": (row.get("Contributor Zip Code") or "").strip() or None,
                "source_form_type": "INKIND" if "In-Kind" in (row.get("Contribution Type") or "") else None,
                "cycle": "2026"})
        for row in md_csv("ExpenditurePublicGrid", "expenditureSearchFilter", cmte_name):
            amt = money(row.get("Transaction Amount"))
            if amt is None:
                continue
            payee = (row.get("Payee Name") or "").strip() or (row.get("Vendor Name") or "").strip()
            sink.emit("cf_expenditures", {
                "candidate_id": cand_ids[slug], "committee_id": f"md:{entity_id}",
                "source_txn_id": f"md:exp:{row['TransactionID']}",
                "payee_last_name": payee or None,
                "amount": amt, "expenditure_date": mdy_to_iso(row.get("Transaction Date")),
                "category": (row.get("Category") or "").strip() or None,
                "description": (row.get("Purpose") or "").strip() or None,
                "payee_city": (row.get("Payee City") or "").strip() or None,
                "payee_state": (row.get("Payee State") or "").strip() or None,
                "payee_zip": (row.get("Payee Zip Code") or "").strip() or None,
                "cycle": "2026"})


# --------------------------------------------------------------------------
# Alabama — FCPA bulk extracts (entellitrak, same platform as Michigan)
# --------------------------------------------------------------------------

AL_BASE = "https://fcpa.alabamavotes.gov/page.request.do"
AL_INTERMEDIATE = "http://secure.globalsign.com/cacert/gsatlasr3ovtlsca2025q3.crt"


def al_ssl_context():
    """fcpa.alabamavotes.gov serves its leaf certificate without the issuing
    intermediate, which fails default verification — trust the GlobalSign
    intermediate explicitly (fetched as DER from GlobalSign's cert store)."""
    import ssl
    ctx = ssl.create_default_context()
    try:
        der = http(AL_INTERMEDIATE, timeout=60)
        ctx.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(der))
    except Exception as ex:  # noqa: BLE001 — fall back to the system store
        print(f"   al: intermediate CA fetch failed ({ex}); using system store only")
    return ctx


def import_alabama(sink, cand_ids):
    com_to_slug = {v: k for k, v in COMMITTEES["al"].items()}
    ctx = al_ssl_context()
    listing = json.loads(http(
        f"{AL_BASE}?page=com.acf.common.page.transactiondatadownloadsresults"
        f"&pageSize=100&pageNumber=1&sortDirection=DESC&sortBy=year",
        headers={"User-Agent": BROWSER_UA}, context=ctx))
    data = listing.get("data") or {}
    rows = data.get("list") or data.get("rows") or []

    def norm(r):
        return {k.lower(): v for k, v in r.items()}

    files = []
    for r in (norm(x) for x in rows):
        dt = str(r.get("datatype") or "").lower()
        if str(r.get("year")) not in {str(y) for y in YEARS}:
            continue
        # The Cash extract already includes the in-kind rows (verified by
        # ContributionID overlap), so only cash + expenditures are pulled.
        if "cash" in dt:
            files.append(("contrib", r.get("download")))
        elif "expenditure" in dt:
            files.append(("expend", r.get("download")))
    seen = set()
    for kind, dl_id in files:
        raw = http(f"{AL_BASE}?page=getTransactionData&id={dl_id}",
                   headers={"User-Agent": BROWSER_UA}, context=ctx, timeout=600)
        z = zipfile.ZipFile(io.BytesIO(raw))
        with io.TextIOWrapper(z.open(z.namelist()[0]), encoding="utf-8",
                              errors="replace") as f:
            for row in csv.DictReader(f):
                ent = (row.get("CommitteeId") or "").strip()
                slug = com_to_slug.get(ent)
                if not slug:
                    continue
                cid = cand_ids[slug]
                if kind == "expend":
                    amt = money(row.get("ExpenditureAmount"))
                    rid = (row.get("ExpenditureID") or "").strip()
                    if amt is None or not rid or rid in seen:
                        continue
                    seen.add(rid)
                    sink.emit("cf_expenditures", {
                        "candidate_id": cid, "committee_id": f"al:{ent}",
                        "source_txn_id": f"al:e{rid}",
                        "payee_last_name": (row.get("LastName") or "").strip() or None,
                        "payee_first_name": (row.get("FirstName") or "").strip() or None,
                        "payee_city": (row.get("City") or "").strip() or None,
                        "payee_state": (row.get("State") or "").strip() or None,
                        "payee_zip": (row.get("Zip") or "").strip() or None,
                        "amount": amt,
                        "expenditure_date": mdy_to_iso(row.get("ExpenditureDate")),
                        "category": (row.get("Purpose") or "").strip() or None,
                        "description": (row.get("Explanation") or "").strip() or None})
                    continue
                amt = money(row.get("ContributionAmount"))
                rid = (row.get("ContributionID") or "").strip()
                if amt is None or not rid or rid in seen:
                    continue
                seen.add(rid)
                ctype_raw = (row.get("ContributorType") or "").strip().lower()
                is_ind = "individual" in ctype_raw or ctype_raw == "self"
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"al:{ent}",
                    "source_txn_id": f"al:c{rid}",
                    "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                    "contributor_last_name": (row.get("LastName") or "").strip() or None,
                    "contributor_first_name": (row.get("FirstName") or "").strip() or None,
                    "amount": amt,
                    "contribution_date": mdy_to_iso(row.get("ContributionDate")),
                    "city": (row.get("City") or "").strip() or None,
                    "state": (row.get("State") or "").strip() or None,
                    "zip": (row.get("Zip") or "").strip() or None,
                    "source_form_type": "INKIND" if "in-kind" in
                        (row.get("ContributionType") or "").lower() else None})


# --------------------------------------------------------------------------
# Alaska — APOC per-candidate CSV exports (WebForms session + export GET)
# --------------------------------------------------------------------------

AK_CD = "https://aws.state.ak.us/ApocReports/CampaignDisclosure"
AK_STATE_ABBR = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
    "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
    "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}


def ak_abbr(name):
    s = (name or "").strip()
    return AK_STATE_ABBR.get(s.lower(), s or None)


def ak_export_once(page, name, year="2026", tries=8):
    """One APOC query: fresh session, filter POST (stored server-side), then
    the static exportAll CSV link. F5/DataDome drops connections routinely
    (bursts last ~30-60 s) — every request retries with long backoff, and
    steps are paced a few seconds apart."""
    import http.cookiejar
    cj = http.cookiejar.CookieJar()
    op = request.build_opener(request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", BROWSER_UA)]

    def openr(u, data=None):
        last = None
        for i in range(tries):
            try:
                with op.open(request.Request(u, data=data), timeout=300) as r:
                    return r.read()
            except Exception as ex:  # noqa: BLE001 — resets/timeouts both retry
                last = ex
                time.sleep(min(45, 5 * (i + 1)))
        raise RuntimeError(f"apoc {u}: failed after {tries} tries: {last}")

    url = f"{AK_CD}/{page}.aspx"
    h = openr(url).decode("utf-8", "replace")
    p = re.search(r'name="(M\$C\$[^"$]+)\$csfFilter\$txtName"', h).group(1)
    vs = re.search(r'id="__VIEWSTATE" value="([^"]*)"', h).group(1)
    vg = re.search(r'id="__VIEWSTATEGENERATOR" value="([^"]*)"', h).group(1)
    def form(html_text, button, value):
        vs = re.search(r'id="__VIEWSTATE" value="([^"]*)"', html_text).group(1)
        vg = re.search(r'id="__VIEWSTATEGENERATOR" value="([^"]*)"',
                       html_text).group(1)
        return {"__EVENTTARGET": "", "__EVENTARGUMENT": "", "__LASTFOCUS": "",
                "__VIEWSTATE": vs, "__VIEWSTATEGENERATOR": vg,
                f"{p}$csfFilter$ddlNameType": "CandidateName",
                f"{p}$csfFilter$txtName": name,
                f"{p}$csfFilter$ddlField":
                    "IncomeTypes" if page == "CDIncome" else "ExpenditureTypes",
                f"{p}$csfFilter$ddlValue": "-1",
                f"{p}$csfFilter$txtBeginDate": "",
                f"{p}$csfFilter$txtEndDate": "",
                f"{p}$csfFilter$ddlReportYear": year,
                f"{p}$csfFilter$ddlStatus": "Default",
                button: value}
    time.sleep(2)
    s = openr(url, parse.urlencode(
        form(h, f"{p}$csfFilter$btnSearch", "Search")).encode()
        ).decode("utf-8", "replace")
    time.sleep(2)
    # The export dialog's links carry session state — click Export and follow
    # the CSV exportAll link it returns (a bare exportAll GET comes back
    # empty).
    e = openr(url, parse.urlencode(
        form(s, f"{p}$csfFilter$btnExport", "Export")).encode()
        ).decode("utf-8", "replace")
    target = None
    for link in set(re.findall(r'href="([^"]*isExport[^"]*)"', e)):
        if "exportAll=True" in link and "CSV" in link:
            target = "https://aws.state.ak.us" + link.replace("&amp;", "&")
    if not target:
        raise RuntimeError(f"apoc {page}/{name}: no export link found")
    time.sleep(2)
    return openr(target).decode("utf-8", "replace")


def ak_export(page, name, year="2026"):
    """A search POST that gets eaten (WAF error page, dropped body) leaves no
    stored filter, and the export then comes back empty — so an empty export
    is treated as a failure and the whole session is rebuilt."""
    for attempt in range(3):
        text = ak_export_once(page, name, year)
        lines = text.splitlines()
        if lines and "Result" in lines[0] and len(lines) > 1:
            return text
        print(f"   ak: empty/invalid export for {name} {page} "
              f"(attempt {attempt + 1}/3) — retrying", flush=True)
        time.sleep(20)
    return text


def import_alaska(sink, cand_ids):
    for slug, last_name in COMMITTEES["ak"].items():
        cid = cand_ids[slug]
        for page in ("CDIncome", "CDExpenditures"):
            text = ak_export(page, last_name)
            n = 0
            for row in csv.DictReader(io.StringIO(text)):
                # Last-name search also matches other filers (e.g. Kyle
                # Walker, Anchorage Assembly) — the Office column scopes it.
                if (row.get("Office") or "").strip() != "Governor":
                    continue
                amt = money(row.get("Amount"))
                d = mdy_to_iso(row.get("Date"))
                if amt is None or not d:
                    continue
                lastn = (row.get("Last/Business Name") or "").strip()
                first = (row.get("First Name") or "").strip()
                # No transaction ids in APOC exports — hash the row.
                tid = sink.txn_id("ak", page, slug, d, lastn, first, amt,
                                  row.get("Address"), row.get("City"),
                                  row.get("Purpose of Expenditure"))
                base = {"candidate_id": cid, "committee_id": f"ak:{slug}",
                        "source_txn_id": tid}
                n += 1
                if page == "CDExpenditures":
                    sink.emit("cf_expenditures", {**base,
                        "payee_last_name": lastn or None,
                        "payee_first_name": first or None,
                        "payee_city": (row.get("City") or "").strip() or None,
                        "payee_state": ak_abbr(row.get("State")),
                        "payee_zip": (row.get("Zip") or "").strip() or None,
                        "amount": amt, "expenditure_date": d,
                        "description":
                            (row.get("Purpose of Expenditure") or "").strip() or None})
                    continue
                ptype = (row.get("Payment Type") or "").strip()
                pdetail = (row.get("Payment Detail") or "").strip()
                if "loan" in ptype.lower() or "loan" in pdetail.lower():
                    sink.emit("cf_loans", {**base,
                        "lender_type": "INDIVIDUAL" if first else "ENTITY",
                        "lender_last_name": lastn or None,
                        "lender_first_name": first or None,
                        "amount": amt, "loan_date": d})
                    continue
                sink.emit("cf_contributions", {**base,
                    "contributor_type": "INDIVIDUAL" if first else "ENTITY",
                    "contributor_last_name": lastn or None,
                    "contributor_first_name": first or None,
                    "employer": (row.get("Employer") or "").strip() or None,
                    "occupation": (row.get("Occupation") or "").strip() or None,
                    "amount": amt, "contribution_date": d,
                    "city": (row.get("City") or "").strip() or None,
                    "state": ak_abbr(row.get("State")),
                    "zip": (row.get("Zip") or "").strip() or None,
                    "source_form_type": "INKIND" if ptype == "Non-Monetary" else None})
            print(f"   ak:{slug} {page}: {n} rows", flush=True)


# --------------------------------------------------------------------------
# Arkansas — SoS ethics-disclosures bulk CSV (Civix API, like GA/ID)
# --------------------------------------------------------------------------

AR_API = "https://api-ethics-disclosures.sos.arkansas.gov/api"


def civix_bulk(api, code, year):
    """Fetch a Civix bulk CSV (AR/ID) gzipped — the uncompressed AR files run
    ~100 MB and get cut off mid-body; gzip shrinks them ~6x."""
    import gzip
    body = json.dumps({"transactionTypeCode": code, "type": "CSV",
                       "filingYear": str(year)}).encode()
    raw = http_retry(f"{api}/ExportData/GetExportPublicDownloadData",
                     tries=5, data=body, timeout=900,
                     headers={"User-Agent": BROWSER_UA,
                              "Content-Type": "application/json",
                              "Accept-Encoding": "gzip"})
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8-sig", "replace")


def ar_addr(s):
    """'1 Busch Place, St Louis, MO 63118' -> (city, state, zip)."""
    parts = [x.strip() for x in (s or "").rsplit(",", 2)]
    if len(parts) == 3:
        m = re.match(r"^([A-Z]{2})\s+([\d-]+)?", parts[2])
        if m:
            return parts[1], m.group(1), m.group(2)
    return None, None, None


def import_arkansas(sink, cand_ids):
    ent_to_slug = {v: k for k, v in COMMITTEES["ar"].items()}
    for year in YEARS:
        for code in ("TCON", "TEXP"):
            text = civix_bulk(AR_API, code, year)
            for row in csv.DictReader(io.StringIO(text)):
                ent = (row.get("Filing Entity ID") or "").strip()
                slug = ent_to_slug.get(ent)
                if not slug:
                    continue
                cid = cand_ids[slug]
                amt = money(row.get("Transaction Amount"))
                if amt is None:
                    continue
                iso = mdy_to_iso(row.get("Transaction Date"))
                rid = (row.get("Transaction ID") or "").strip()
                tid = f"ar:{rid}" if rid else sink.txn_id("ar", code, ent, iso, amt)
                if code == "TEXP":
                    sink.emit("cf_expenditures", {
                        "candidate_id": cid, "committee_id": f"ar:{ent}",
                        "source_txn_id": tid,
                        "payee_last_name": (row.get("Payee Name") or "").strip() or None,
                        "payee_city": ar_addr(row.get("Payee Address"))[0],
                        "payee_state": ar_addr(row.get("Payee Address"))[1],
                        "amount": amt, "expenditure_date": iso,
                        "category": (row.get("Transaction Category") or "").strip() or None,
                        "description": (row.get("Transaction Description") or "").strip() or None})
                    continue
                ttype = (row.get("Transaction Type") or "").strip()
                src_type = (row.get("Funding Source / Loan Source Type") or "").strip()
                is_ind = src_type.lower() in ("individual", "candidate")
                name = (row.get("Source Name") or "").strip()
                first = ""
                if is_ind and "," in name:
                    name, _, first = [x.strip() for x in name.partition(",")]
                city, st, zp = ar_addr(row.get("Source Address"))
                if ttype == "Loan":
                    sink.emit("cf_loans", {
                        "candidate_id": cid, "committee_id": f"ar:{ent}",
                        "source_txn_id": tid,
                        "lender_type": "INDIVIDUAL" if is_ind else "ENTITY",
                        "lender_last_name": name or None,
                        "lender_first_name": first or None,
                        "amount": amt, "loan_date": iso})
                    continue
                if ttype == "Return Contribution":
                    amt = -abs(amt)
                sub = (row.get("Transaction Sub Type") or "")
                if not name and "non-itemized" in sub.lower():
                    name = "Unitemized (small-dollar) contributions"
                    is_ind = False
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"ar:{ent}",
                    "source_txn_id": tid,
                    "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                    "contributor_last_name": name or None,
                    "contributor_first_name": first or None,
                    "employer": (row.get("Employer Name") or "").strip() or None,
                    "occupation": (row.get("Occupation") or "").strip() or None,
                    "amount": amt, "contribution_date": iso,
                    "city": city, "state": st, "zip": zp,
                    "source_form_type": "INKIND" if "in-kind" in sub.lower()
                        or "nonmoney" in sub.lower() else None})


# --------------------------------------------------------------------------
# Connecticut — SEEC eCRIS static election-cycle CSVs
# --------------------------------------------------------------------------

CT_EXPORT = ("https://seec.ct.gov/ecrisreporting/Data/eCrisDownloads/"
             "exportdatafiles/{kind}2026ElectionYearCandidateExploratoryCommittees.csv")


def import_connecticut(sink, cand_ids):
    com_to_slug = {v: k for k, v in COMMITTEES["ct"].items()}
    # Receipts
    text = http(CT_EXPORT.format(kind="Receipts"),
                headers={"User-Agent": UA}, timeout=900).decode("utf-8-sig", "replace")
    for row in csv.DictReader(io.StringIO(text)):
        ent = (row.get("Committee ID") or "").strip()
        slug = com_to_slug.get(ent)
        if not slug:
            continue
        amt = money(row.get("Amount"))
        iso = mdy_to_iso(row.get("Transaction Date"))
        if amt is None or not iso:
            continue
        rtype = (row.get("Receipt Type") or "").strip()
        cname = (row.get("Contributor Name") or "").strip()
        first = (row.get("Contributor First Name") or "").strip()
        last = (row.get("Contributor Last Name") or "").strip()
        # eCRIS exports carry no transaction ids — hash the row (report id
        # included: receipt rows repeat legitimately within a report).
        tid = sink.txn_id("ct", ent, row.get("Report ID"), iso, rtype,
                          cname, first, last, amt, row.get("Street Address"))
        base = {"candidate_id": cand_ids[slug], "committee_id": f"ct:{ent}",
                "source_txn_id": tid}
        if "loan" in rtype.lower():
            sink.emit("cf_loans", {**base,
                "lender_type": "INDIVIDUAL" if last else "ENTITY",
                "lender_last_name": (last or cname) or None,
                "lender_first_name": first or None,
                "amount": amt, "loan_date": iso})
            continue
        if rtype == "Public Grants":
            # CEP qualifying/primary/general grants — label the lump sums so
            # they read sensibly next to private donors.
            sink.emit("cf_contributions", {**base,
                "contributor_type": "ENTITY",
                "contributor_last_name":
                    "Citizens' Election Program (public grant)",
                "amount": amt, "contribution_date": iso})
            continue
        sink.emit("cf_contributions", {**base,
            "contributor_type": "INDIVIDUAL" if last else "ENTITY",
            "contributor_last_name": (last or cname) or None,
            "contributor_first_name": first or None,
            "employer": (row.get("Employer") or "").strip() or None,
            "occupation": (row.get("Occupation") or "").strip() or None,
            "amount": amt, "contribution_date": iso,
            "city": (row.get("City") or "").strip() or None,
            "state": (row.get("State") or "").strip() or None,
            "zip": (row.get("zip") or "").strip() or None,
            "source_form_type": "INKIND" if "in kind" in rtype.lower()
                or "in-kind" in rtype.lower() else None})
    # Disbursements
    text = http(CT_EXPORT.format(kind="Disbursements"),
                headers={"User-Agent": UA}, timeout=900).decode("utf-8-sig", "replace")
    for row in csv.DictReader(io.StringIO(text)):
        ent = (row.get("Committee ID") or "").strip()
        slug = com_to_slug.get(ent)
        if not slug:
            continue
        amt = money(row.get("Amount"))
        iso = mdy_to_iso(row.get("Payment Date"))
        if amt is None or not iso:
            continue
        payee = (row.get("Payee") or "").strip()
        tid = sink.txn_id("ct", ent, row.get("Report ID"), iso, "disb",
                          payee, amt, row.get("Street Address"),
                          row.get("Description"))
        sink.emit("cf_expenditures", {
            "candidate_id": cand_ids[slug], "committee_id": f"ct:{ent}",
            "source_txn_id": tid,
            "payee_last_name": payee or None,
            "payee_city": (row.get("City") or "").strip() or None,
            "payee_state": (row.get("State") or "").strip() or None,
            "amount": amt, "expenditure_date": iso,
            "category": (row.get("Purpose of Expenditure") or "").strip() or None,
            "description": (row.get("Description") or "").strip() or None})


# --------------------------------------------------------------------------
# Idaho — Sunshine bulk CSV (api-sunshine.voteidaho.gov, Civix like GA/AR)
# --------------------------------------------------------------------------

ID_API = "https://api-sunshine.voteidaho.gov/api"


def id_zip(s):
    return (s or "").replace('="', "").replace('"', "").strip() or None


def import_idaho(sink, cand_ids):
    ent_to_slug = {v: k for k, v in COMMITTEES["id"].items()}
    for year in YEARS:
        for code in ("TCON", "TEXP"):
            text = civix_bulk(ID_API, code, year)
            rd = csv.DictReader(io.StringIO(text))
            rd.fieldnames = [c.strip() for c in rd.fieldnames]
            for row in rd:
                ent = (row.get("Filing Entity ID") or "").strip()
                slug = ent_to_slug.get(ent)
                if not slug:
                    continue
                cid = cand_ids[slug]
                amt = money(row.get("Transaction Amount"))
                if amt is None:
                    continue
                iso = mdy_to_iso(row.get("Transaction Date"))
                rid = (row.get("Transaction Id") or "").strip()
                tid = f"id:{rid}" if rid else sink.txn_id("id", code, ent, iso, amt)
                sub = (row.get("Transaction Sub Type") or "").strip()
                if code == "TEXP":
                    org = (row.get("Payee Company Name") or "").strip()
                    last = (row.get("Payee Last Name") or "").strip()
                    purpose = re.sub(r"[^\x20-\x7e]+", " ",
                                     row.get("Purpose") or "").strip()
                    sink.emit("cf_expenditures", {
                        "candidate_id": cid, "committee_id": f"id:{ent}",
                        "source_txn_id": tid,
                        "payee_last_name": (last or org) or None,
                        "payee_first_name": (row.get("Payee First Name") or "").strip() or None,
                        "payee_city": (row.get("Payee Address City") or "").strip() or None,
                        "payee_state": (row.get("Payee Address State") or "").strip() or None,
                        "payee_zip": id_zip(row.get("Payee Address Zip Code")),
                        "amount": amt, "expenditure_date": iso,
                        "category": purpose or None,
                        "description": (row.get("Transaction Description") or "").strip() or None})
                    continue
                ttype = (row.get("Transaction Type") or "").strip()
                is_ind = (row.get("Contributor Type") or "").strip() == "Person"
                last = (row.get("Contributor Last Name") or "").strip()
                first = (row.get("Contributor First Name") or "").strip()
                org = (row.get("Contributor Company Name") or "").strip()
                if ttype == "Loan" or "loan" in sub.lower():
                    sink.emit("cf_loans", {
                        "candidate_id": cid, "committee_id": f"id:{ent}",
                        "source_txn_id": tid,
                        "lender_type": "INDIVIDUAL" if is_ind else "ENTITY",
                        "lender_last_name": (last or org) or None,
                        "lender_first_name": first or None,
                        "amount": amt, "loan_date": iso})
                    continue
                sink.emit("cf_contributions", {
                    "candidate_id": cid, "committee_id": f"id:{ent}",
                    "source_txn_id": tid,
                    "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                    "contributor_last_name": (last or org) or None,
                    "contributor_first_name": first or None,
                    "amount": amt, "contribution_date": iso,
                    "city": (row.get("Contributor Address City") or "").strip() or None,
                    "state": (row.get("Contributor Address State") or "").strip() or None,
                    "zip": id_zip(row.get("Contributor Address Zip Code")),
                    "source_form_type": "INKIND" if sub == "In-Kind" else None})


# --------------------------------------------------------------------------
# Illinois — ISBE full dumps, streamed (Receipts.txt is ~1 GB)
# --------------------------------------------------------------------------

IL_FILES = "https://www.elections.il.gov/CampaignDisclosureDataFiles"


def il_lines(fname, max_tries=30):
    """Stream a huge ISBE dump line by line, resuming with Range requests
    when the transfer gets cut off (the server honors 206; verified). The
    try budget resets whenever a retry makes progress.

    IL_TAIL_BYTES (optional) starts the stream that many bytes from the end
    instead of at byte 0 — rows are append-ordered by ID, so on a slow link
    a generous tail still covers the whole 2025+ cycle window. The header
    line is always fetched from the file head first."""
    offset = 0
    buf = b""
    tries = 0
    tail = int(os.environ.get("IL_TAIL_BYTES") or 0)
    if tail:
        head = http(f"{IL_FILES}/{fname}", headers={
            "User-Agent": BROWSER_UA, "Range": "bytes=0-4095"}, timeout=120)
        yield head.split(b"\n")[0].decode("latin-1", "replace")
        req = request.Request(f"{IL_FILES}/{fname}", method="HEAD",
                              headers={"User-Agent": BROWSER_UA})
        size = int(request.urlopen(req, timeout=120).headers["Content-Length"])
        offset = max(0, size - tail)
        buf = b"\0"  # sentinel: discard the partial line at the cut point
    while True:
        headers = {"User-Agent": BROWSER_UA}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            r = request.urlopen(
                request.Request(f"{IL_FILES}/{fname}", headers=headers),
                timeout=600)
            if offset and r.status != 206:
                raise RuntimeError(f"range not honored (HTTP {r.status})")
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    if buf:
                        yield buf.decode("latin-1", "replace")
                    return
                if tries:
                    tries = 0
                offset += len(chunk)
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for ln in lines:
                    yield ln.decode("latin-1", "replace")
        except Exception as ex:  # noqa: BLE001 — resume from current offset
            tries += 1
            if tries >= max_tries:
                raise RuntimeError(f"il {fname}: gave up at byte {offset}: {ex}")
            print(f"   il:{fname} resume from {offset} "
                  f"(try {tries}): {ex}", flush=True)
            time.sleep(min(60, 5 * tries))


def import_illinois(sink, cand_ids):
    com_to_slug = {v: k for k, v in COMMITTEES["il"].items()}
    since = os.environ.get("IL_SINCE", "2025-01-01")
    for fname in ("Receipts.txt", "Expenditures.txt"):
        lines = il_lines(fname)
        cols = next(lines).rstrip("\r").split("\t")
        idx = {c: i for i, c in enumerate(cols)}
        kept = 0
        for line in lines:
            # Cheap prefilter: CommitteeID is the second column.
            head = line.split("\t", 3)
            if len(head) < 3 or head[1] not in com_to_slug:
                continue
            p = line.rstrip("\r\n").split("\t")
            if len(p) < len(cols) - 2:
                continue

            def g(c):
                i = idx.get(c)
                return p[i].strip() if i is not None and i < len(p) else ""

            slug = com_to_slug[head[1]]
            cid = cand_ids[slug]
            amt = money(g("Amount"))
            d = (g("RcvDate") or g("ExpendedDate"))[:10]
            if amt is None or not re.match(r"^\d{4}-\d{2}-\d{2}$", d) or d < since:
                continue
            kept += 1
            base = {"candidate_id": cid, "committee_id": f"il:{head[1]}"}
            if fname == "Expenditures.txt":
                sink.emit("cf_expenditures", {**base,
                    "source_txn_id": f"il:e{g('ID')}",
                    "payee_last_name": g("LastOnlyName") or None,
                    "payee_first_name": g("FirstName") or None,
                    "payee_city": g("City") or None,
                    "payee_state": g("State") or None,
                    "payee_zip": g("Zip") or None,
                    "amount": amt, "expenditure_date": d,
                    "description": g("Purpose") or None})
                continue
            first = g("FirstName")
            d2 = g("D2Part")
            row = {**base, "source_txn_id": f"il:r{g('ID')}",
                   "amount": amt}
            if d2.startswith("3"):  # loans
                sink.emit("cf_loans", {**row,
                    "lender_type": "INDIVIDUAL" if first else "ENTITY",
                    "lender_last_name": g("LastOnlyName") or None,
                    "lender_first_name": first or None, "loan_date": d})
                continue
            sink.emit("cf_contributions", {**row,
                "contributor_type": "INDIVIDUAL" if first else "ENTITY",
                "contributor_last_name": g("LastOnlyName") or None,
                "contributor_first_name": first or None,
                "employer": g("Employer") or None,
                "occupation": g("Occupation") or None,
                "contribution_date": d,
                "city": g("City") or None, "state": g("State") or None,
                "zip": g("Zip") or None,
                "source_form_type": "INKIND" if d2.startswith("5") else None})
        print(f"   il:{fname}: {kept} rows kept", flush=True)


# --------------------------------------------------------------------------
# Kansas — SoS CFR viewer HTML scrape (WebForms postback chain)
# --------------------------------------------------------------------------

KS_BASE = "https://www.kssos.org/elections/cfr_viewer/"


def ks_opener():
    import http.cookiejar
    op = request.build_opener(
        request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.addheaders = [("User-Agent", BROWSER_UA)]
    return op


def ks_get(op, url):
    return op.open(url, timeout=120).read().decode("utf-8", "replace")


def ks_post(op, url, data, referer):
    req = request.Request(url, parse.urlencode(data).encode(),
                          {"Referer": referer,
                           "Content-Type": "application/x-www-form-urlencoded"})
    r = op.open(req, timeout=180)
    return r.geturl(), r.read().decode("utf-8", "replace")


def ks_hidden(h):
    """Every hidden input on the page — the viewer 500s unless the POST
    echoes exactly the hidden fields present (no more, no fewer)."""
    return {m.group(1): m.group(2) for m in re.finditer(
        r'<input type="hidden" name="([^"]+)"[^>]*value="([^"]*)"', h)}


def ks_filings_list(op, last_name):
    """entry -> Candidate viewer -> search (office 1 = Governor) -> first
    result's filings list. Returns (url, html)."""
    entry = KS_BASE + "cfr_examiner_entry.aspx"
    h = ks_get(op, entry)
    d = ks_hidden(h)
    d.update(ddlViewerOptions="Candidate", btnSubmit="Submit")
    u, h = ks_post(op, entry, d, entry)
    d = ks_hidden(h)
    d.update({"__EVENTTARGET": "", "__EVENTARGUMENT": "",
              "txtFirstName": "", "txtLastName": last_name,
              "drpdownOffice": "1", "txtDistrictNo": "",
              "drpdownFilingType": "", "txtStartDate": "", "txtEndDate": "",
              "btnSearch": "Submit Search"})
    u, h = ks_post(op, u, d, u)
    d = ks_hidden(h)
    d.update({"__EVENTTARGET": "grdviewLookupResults$ctl02$lnkbtnLastName",
              "__EVENTARGUMENT": ""})
    return ks_post(op, u, d, u)


def ks_click(op, u, h, target):
    d = ks_hidden(h)
    d.update({"__EVENTTARGET": target, "__EVENTARGUMENT": ""})
    return ks_post(op, u, d, u)


def ks_rows(html_text):
    """Parse a schedule page's table rows into cell-text lists."""
    import html as html_mod
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html_text, re.S):
        tds = [re.sub(r"\s+", " ",
                      html_mod.unescape(re.sub(r"<[^>]+>", " ", td))).strip()
               for td in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if tds:
            out.append(tds)
    return out


def ks_name_addr(s):
    """'Evergy Metro Inc. PO Box 418679 Kansas City MO 64141' ->
    (name, state, zip) — the viewer concatenates name and address."""
    s = (s or "").strip()
    # Address-less payees render as "WinRed Not Available Not Available NA".
    s = re.sub(r"(\s+Not Available)+(\s+NA)?$", "", s)
    m = re.search(r"\s([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$", s)
    st, zp = (m.group(1), m.group(2)) if m else (None, None)
    body = s[: m.start()].strip() if m else s
    m2 = re.search(r"^(.*?)\s+(?:\d+\s|PO\s*Box|P\.?O\.?\s*Box)", body, re.I)
    name = (m2.group(1) if m2 else body).strip()
    return name or body, st, zp


def import_kansas(sink, cand_ids):
    for slug, last_name in COMMITTEES["ks"].items():
        cid = cand_ids[slug]
        # Discover the R&E report links once, then re-walk the chain per
        # report/schedule (viewstates are single-use).
        op = ks_opener()
        _, h = ks_filings_list(op, last_name)
        reports = sorted(set(re.findall(
            r"(grdviewCfrResults\$ctl\d+\$lnkbtnLastName)", h)))
        print(f"   ks:{slug}: {len(reports)} R&E reports", flush=True)
        for target in reports:
            for sched, table in (("lnkbtnScheduleAView", "cf_contributions"),
                                 ("lnkbtnScheduleCView", "cf_expenditures")):
                op = ks_opener()
                u, h = ks_filings_list(op, last_name)
                u, h = ks_click(op, u, h, target)
                if "lnkbtnSchedule" not in h:
                    continue
                if sched.replace("lnkbtn", "") not in h and sched not in h:
                    continue
                u, h = ks_click(op, u, h, sched)
                rows = ks_rows(h)
                hdr_i, hdr = next(((i, r) for i, r in enumerate(rows)
                                   if "Date" in r and "Amount" in r), (None, None))
                if hdr is None:
                    continue
                di = hdr.index("Date")
                ai = len(hdr) - 1 - hdr[::-1].index("Amount")
                ni = next((i for i, c in enumerate(hdr) if "Name" in c), 1)
                pi = next((i for i, c in enumerate(hdr) if "Payment" in c), None)
                oi = next((i for i, c in enumerate(hdr) if "Occupation" in c), None)
                ui = next((i for i, c in enumerate(hdr) if "Purpose" in c), None)
                n = 0
                for r in rows[hdr_i + 1:]:
                    if len(r) != len(hdr):
                        continue
                    dm = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2})$", r[di])
                    amt = money(r[ai])
                    if not dm or amt is None:
                        continue
                    iso = f"20{dm.group(3)}-{dm.group(1).zfill(2)}-{dm.group(2).zfill(2)}"
                    name, st, zp = ks_name_addr(r[ni])
                    ptype = r[pi] if pi is not None and pi < len(r) else ""
                    occ = r[oi] if oi is not None and oi < len(r) else ""
                    # Hash excludes the report target so amended re-filings
                    # of the same period dedupe to the same ids.
                    tid = sink.txn_id("ks", slug, sched, iso, name, st, zp,
                                      amt, ptype, occ)
                    is_ind = bool(occ) or not ENTITY_PAT.search(name)
                    first, last = "", name
                    if is_ind:
                        parts = name.rsplit(None, 1)
                        if len(parts) == 2:
                            first, last = parts
                    base = {"candidate_id": cid, "committee_id": f"ks:{slug}",
                            "source_txn_id": tid, "amount": amt}
                    n += 1
                    if table == "cf_expenditures":
                        sink.emit("cf_expenditures", {**base,
                            "payee_last_name": name or None,
                            "payee_state": st, "payee_zip": zp,
                            "expenditure_date": iso,
                            "description":
                                (r[ui] if ui is not None and ui < len(r) else "") or None})
                        continue
                    if "loan" in ptype.lower():
                        sink.emit("cf_loans", {**base,
                            "lender_type": "INDIVIDUAL" if is_ind else "ENTITY",
                            "lender_last_name": last or None,
                            "lender_first_name": first or None,
                            "loan_date": iso})
                        continue
                    sink.emit("cf_contributions", {**base,
                        "contributor_type": "INDIVIDUAL" if is_ind else "ENTITY",
                        "contributor_last_name": last or None,
                        "contributor_first_name": first or None,
                        "occupation": occ or None,
                        "contribution_date": iso,
                        "state": st, "zip": zp})
                print(f"   ks:{slug} {target[-24:]} {sched[-14:]}: {n} rows",
                      flush=True)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    all_states = ["fl", "ga", "mi", "az", "ky", "pa", "co", "mn", "ma", "hi",
                  "ia", "md", "wi", "al", "ak", "ar", "ct", "id", "il", "ks"]
    ap.add_argument("--states", nargs="+", default=all_states, choices=all_states)
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")

    cand_ids = {c["slug"]: c["id"] for c in sb_get("cf_candidates?select=id,slug")}
    sink = Sink()
    importers = {"fl": import_florida, "ga": import_georgia, "mi": import_michigan,
                 "az": import_arizona, "ky": import_kentucky,
                 "pa": import_pennsylvania, "co": import_colorado,
                 "mn": import_minnesota, "ma": import_massachusetts,
                 "hi": import_hawaii, "ia": import_iowa, "md": import_maryland,
                 "wi": import_wisconsin, "al": import_alabama,
                 "ak": import_alaska, "ar": import_arkansas,
                 "ct": import_connecticut, "id": import_idaho,
                 "il": import_illinois, "ks": import_kansas}
    for st in args.states:
        print(f"== importing {st} ==", flush=True)
        importers[st](sink, cand_ids)
        sink.flush()
        print(f"   running totals: {sink.counts}", flush=True)

    # Rebuild the matviews so summaries/top-donor views pick up the new rows.
    http(f"{SUPABASE_URL}/rest/v1/rpc/refresh_cf_finance_views", data=b"{}",
         headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                  "Content-Type": "application/json"})
    print("done:", sink.counts)


if __name__ == "__main__":
    main()
