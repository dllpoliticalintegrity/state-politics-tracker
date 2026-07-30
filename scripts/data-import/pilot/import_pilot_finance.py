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

Usage:
    python3 import_pilot_finance.py --states fl ga mi az ky
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
from datetime import date
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


def http(url, data=None, headers=None, timeout=300):
    req = request.Request(url, data=data, headers=headers or {})
    with request.urlopen(req, timeout=timeout) as r:
        return r.read()


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
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", nargs="+", default=["fl", "ga", "mi", "az", "ky"],
                    choices=["fl", "ga", "mi", "az", "ky"])
    args = ap.parse_args()

    if not SUPABASE_URL or not SERVICE_KEY:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")

    cand_ids = {c["slug"]: c["id"] for c in sb_get("cf_candidates?select=id,slug")}
    sink = Sink()
    importers = {"fl": import_florida, "ga": import_georgia, "mi": import_michigan,
                 "az": import_arizona, "ky": import_kentucky}
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
