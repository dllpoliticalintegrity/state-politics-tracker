"""
parsers/iowa.py — Parse Iowa DR-2 campaign finance PDFs into 5 normalized relations.

Input:  data/Iowa/raw/
  *.pdf    — DR-2 Summary PDFs downloaded from iecdbblobstorage.blob.core.windows.net
             (one file per committee per filing period)
  manifest.csv — tracks all downloaded PDFs with API metadata (committee name,
                 period year, organization type, candidate name, etc.)

Output: data/Iowa/cleaned/
  contributions.csv.gz, expenditures.csv.gz, committees.csv.gz,
  candidates.csv.gz, loans_debts.csv.gz

Each PDF contains:
  Page 1  — DR-2 Summary page: committee/candidate metadata, treasurer/chairperson
             contact info, and financial summary totals (not parsed for transactions).
  Sch-A   — Cash contributions: date, contributor name+address, relationship, amount.
  Sch-B   — Expenditures: date, payee name+address, purpose, amount.
  Sch-D   — Unpaid bills (skipped — not enough detail for loans_debts table).
  Sch-E   — In-kind contributions: date, contributor, description, estimated value.
  Sch-F1  — Loans received: date, lender name+address, relationship, amount.
  Sch-F2  — Loans paid/forgiven: date, lender, relationship, amount.
  Sch-G   — Consultant breakdown (skipped).
  Sch-H1  — Campaign property (skipped).
  Sch-H2  — Campaign property sales (skipped).

Notes
─────
  • pdfplumber's extract_tables() reliably detects schedule type from the column
    header on every page — no need to track page-to-schedule state across pages.
  • Name+address in contributions and expenditures is a single multi-line cell:
    first line = name, last line = "City, ST ZIP", middle lines = street address.
  • Committees are deduplicated by committee_code — only the most-recently-seen
    metadata is written (latest filing period wins).
  • Candidates come from committees with organizationType="Candidate" in the manifest.
  • In-kind contributions (Sch-E) are written as contributions with
    transaction_type="In-Kind".
  • Loans received (Sch-F1) go to loans_debts with record_type="loan_received".
    Sch-F1's table has the same first column ("Date Incurred") as Sch-D's
    unpaid bills; only F1's has an "Amount of Loan" column, and Sch-D is
    skipped (it used to be read as loans).
  • Loans paid (Sch-F2) go to loans_debts with record_type="loan_repaid".
  • person_id model: "committee" — Iowa committee codes are per-registration;
    candidates may re-register each cycle with a new code.
  • Each page's layout cache is released once read: a statewide candidate's
    report runs to 6,000 pages, which pdfplumber otherwise holds in memory
    (12 GB and climbing on Rob Sand's 2025 report).
  • Loader ids (columns.py, TRANSACTION_IDS): state_filer_id = the IECDB
    committee code ("5185", "SWGA51409"). The PDFs carry no transaction id, so
    txn_id stays blank there (the loader hashes the row); superseded is never
    set — the index lists only each report's latest version.

Search mode (scraper --search)
──────────────────────────────
  search_contributions_{year}.csv / search_expenditures_{year}.csv, when
  present, replace the PDFs' Sch-A, Sch-B and Sch-E: they are the IECDB
  Searchable Database's rows (see the scraper), current to the latest filed
  report. The PDFs then give committee / candidate rows from page 1, and
  loans from Sch-F1 / F2 — read only in reports whose summary page shows loan
  activity, so the 6,000-page reports are opened for page 1 alone.
  • txn_id = transactionId, the database's own id for the transaction.
  • contributor_type / payee kind = the scraper's kind: "Individual",
    "Organization", "Committee" or "Unitemized". A committee's name drops the
    "#<code> " prefix the database puts on it.
  • As filed: the database shows each party's CURRENT contact record, so a
    gift from one "Theresa Macdonald" carries the address of a namesake who
    gave later (Rob Sand's imports: 2.6% of his gifts), and a person's name
    comes joined ("Richard W. Spanton"). Each itemized row is therefore
    matched to its line in the report PDF — read as text with PDFium, the
    whole state's reports in under two minutes — on committee, date, amount and
    name, and takes the name and city / state / zip as the report printed
    them. A person's line is "{last}, {first} {middle initial}", with a
    trailing space when there is no initial ("Dutcher, Michael A " = first
    "Michael A"; "Peters, George R" = first "George"); "Seward, Jr., Jack" =
    last "Seward, Jr.". That is the Iowa Data Hub's last_nm / first_nm
    (what the old pilot importer stored) for all but 27 of the tracked
    candidates' 177,729 gifts the two share (October 2026).
  • Rows with no line in the PDFs keep the database's values: a person's
    joined name is split — last = the final word, with a particle before it
    (Van, De, St., ...) and a suffix after it (Jr, III, ...); a middle
    initial is dropped from first. Anyone else goes whole into last.
  • An "Un-itemized" lump sum keeps no name and counts as "Individual" (the
    pilot importer's rule for a nameless gift), transaction_type "Unitemized"
    so the loader's unitemized option can label it.
  • Types: CON → "Monetary", INK → "In-Kind"; EXP → blank (the database has no
    purpose or category, and the loader would otherwise turn the type into
    every expenditure's spending category). filing_id = checkNumber.
  • Sch-F1 loans are written as contributions with transaction_type "Loan"
    (the loader books those as loans) so the lender's "Last, First" keeps its
    two parts; Sch-F2 stays in loans_debts.
"""

import csv
import gzip
import io
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import pdfplumber

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "src" / "pipeline"))
from src.reporting.logger import get_logger
import columns as C
import utils

csv.field_size_limit(sys.maxsize)

# =============================== paths ================================
RAW_DIR   = PROJECT_ROOT / "data" / "Iowa" / "raw"
CLEAN_DIR = PROJECT_ROOT / "data" / "Iowa" / "cleaned"
MANIFEST  = PROJECT_ROOT / "data" / "Iowa" / "manifest.csv"

CLEAN_DIR.mkdir(parents=True, exist_ok=True)

STATE          = "IA"
MAX_VALID_YEAR = date.today().year + 2

# ========================= schedule detection =======================
# Maps a normalized first-column header → schedule type.
# pdfplumber joins multi-line headers with '\n', so we normalize before matching.

def _norm(s: str) -> str:
    """Collapse whitespace (including newlines) for header matching."""
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


# Canonical first-cell values for each schedule's header row
SCH_A_HDR  = "contribution date"
SCH_B_HDR  = "expenditure date"
SCH_E_HDR  = "date"                   # Sch-E: "Date" | "Name & Address..."
SCH_F1_HDR = "date incurred"
SCH_F2_HDR = "date loan paid / forgiven"

# Minimum column count to distinguish data tables from sidebar tables
SCH_A_COLS  = 6
SCH_B_COLS  = 5
SCH_E_COLS  = 5
SCH_F1_COLS = 4
SCH_F2_COLS = 4

# Date pattern used to distinguish data rows from total/header rows
_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{4}$")

# City, ST ZIP pattern — Iowa addresses use "City, IA 50000" or "City IA 50000"
_ADDR_RE = re.compile(
    r"^(.*?)(?:,\s*|\s+)([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$", re.IGNORECASE
)

# Amount: "$1,000.00" or "(1,000.00)" for negatives
_AMT_RE = re.compile(r"^\$?[\d,]+(?:\.\d+)?$")

# Search mode: transaction type code -> SLCF transaction_type (an unknown
# code passes through as is), and the name-splitting word lists.
SEARCH_TYPES     = {"CON": "Monetary", "INK": "In-Kind", "EXP": ""}
_NAME_PARTICLES  = {"van", "von", "de", "del", "della", "der", "den", "di", "da", "du",
                    "la", "le", "st", "st.", "ten", "ter", "vander", "vanden", "dos", "das"}
_NAME_SUFFIXES   = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}
_INITIAL_RE      = re.compile(r"^[A-Za-z]\.?$")
_CMTE_PREFIX_RE  = re.compile(r"^#\S+\s+")
# Summary-page lines that mean a report has loan schedules to read.
_LOAN_SUMMARY_RE = re.compile(r"^Schedule F[12]: (Loans Received|Cash Loan Repayments|Forgiven)")

# Search mode, as-filed parties: a PDF text line naming a schedule's columns
# -> the row family it holds ("con" = Sch-A / E, "exp" = Sch-B; None = a
# schedule not matched), a record's first line (its date), the amount that
# ends it, and a "City, ST zip" line (the comma is missing on Sch-D / E).
_FILED_HEADERS  = (("Name and Address of Contributor", "con"),
                   ("Name & Address of Contributor", "con"),
                   ("Expenditure Name & Address", "exp"),
                   ("Name and Address of Person to Whom Debt", None),
                   ("Consultant Name and Address", None),
                   ("Date Expended Expenditure Name", None),
                   ("Name and Address of Lender", None),
                   ("Paid / Forgiven", None),
                   ("Description of Property", None))
_FILED_DATE_RE  = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})(?:\s|$)")
_FILED_AMT_RE   = re.compile(r"(\(?-?\$[\d,]+\.\d{2}\)?)$")
_FILED_CITY_RE  = re.compile(r"^(.*?),?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)-?$")


# ============================== helpers ==============================

def clean(val) -> str:
    return re.sub(r"\s+", " ", (val or "").strip())


def parse_amount(val: str) -> str:
    """'$1,000.00' or '($500.00)' → plain numeric string. '' on failure."""
    v = (val or "").strip().replace("$", "").replace(",", "")
    if not v:
        return ""
    if v.startswith("(") and v.endswith(")"):
        v = "-" + v[1:-1]
    try:
        float(v)
        return v
    except ValueError:
        return ""


def parse_date(val: str) -> str:
    """M/D/YYYY or MM/DD/YYYY → YYYY-MM-DD. '' on failure or implausible year."""
    v = (val or "").strip()
    if not v:
        return ""
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%-m/%-d/%Y"):
        try:
            d = datetime.strptime(v, fmt)
            if d.year < 1990 or d.year > MAX_VALID_YEAR:
                return ""
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def parse_name_address(cell: str) -> tuple[str, str, str, str, str]:
    """
    Parse a multi-line name+address cell (newline-delimited) into
    (name, street, city, state, zip).

    Iowa PDFs wrap long org names across multiple lines within a single cell,
    so "first line = name" is wrong for orgs. Instead we:
      1. Find the city/state/zip line by scanning from the end.
      2. Find the start of the street by looking for the first line that starts
         with a digit or "P O Box" (typical Iowa street address patterns).
      3. Everything before the street is the name (joined with spaces).

    Returns (name, street, city, state, zip) — any field may be empty.
    """
    parts = [p.strip() for p in (cell or "").split("\n") if p.strip()]
    if not parts:
        return "", "", "", "", ""

    # 1. Find the city/state/zip line (scan from end — it's always last)
    addr_idx = None
    for i in range(len(parts) - 1, -1, -1):
        if _ADDR_RE.match(parts[i]):
            addr_idx = i
            break

    if addr_idx is None:
        # No address found — return whole content as name
        return " ".join(parts), "", "", "", ""

    m       = _ADDR_RE.match(parts[addr_idx])
    city    = m.group(1).strip().rstrip(",").title()   # normalize case
    state   = m.group(2).upper()
    zipcode = m.group(3)

    # 2. Find where the street starts — first line (after the first) that starts
    #    with a digit or "P O Box" variant
    _STREET_START = re.compile(r"^(?:\d|p\.?\s*o\.?\s*box)", re.IGNORECASE)
    street_idx = None
    for i in range(1, addr_idx):
        if _STREET_START.match(parts[i]):
            street_idx = i
            break

    if street_idx is not None:
        name   = " ".join(parts[:street_idx])
        street = " ".join(parts[street_idx:addr_idx])
    else:
        # No clear street start — everything before city/state/zip is the name
        name   = " ".join(parts[:addr_idx])
        street = ""

    return name, street, city, state, zipcode


def is_data_row(row: list) -> bool:
    """Return True if the first cell of a table row looks like a date."""
    if not row or not row[0]:
        return False
    return bool(_DATE_RE.match(clean(str(row[0]))))


def cell(row: list, idx: int) -> str:
    """Safe cell access — returns '' if index is out of range or cell is None."""
    if idx < len(row) and row[idx] is not None:
        return clean(str(row[idx]))
    return ""


def raw_cell(row: list, idx: int) -> str:
    """Cell access that preserves internal whitespace (newlines). Use for name+address cells."""
    if idx < len(row) and row[idx] is not None:
        return str(row[idx]).strip()
    return ""


# ========================= PDF page parsing ==========================

def classify_table(tbl: list[list]) -> str | None:
    """
    Given a pdfplumber table (list of rows), return the schedule type
    ('A', 'B', 'E', 'F1', 'F2') or None if not a data table.
    """
    if not tbl or len(tbl) < 2:
        return None
    hdr  = tbl[0]
    ncol = len(hdr)
    h0   = _norm(hdr[0] or "")

    if ncol >= SCH_A_COLS  and h0 == SCH_A_HDR:
        return "A"
    if ncol >= SCH_B_COLS  and h0 == SCH_B_HDR:
        return "B"
    # Sch-D (unpaid bills) shares F1's "Date Incurred"; only F1 has a loan column.
    if ncol >= SCH_F1_COLS and h0 == SCH_F1_HDR \
            and any("loan" in _norm(h or "") for h in hdr):
        return "F1"
    if ncol >= SCH_F2_COLS and h0 == SCH_F2_HDR:
        return "F2"
    # Sch-E: first col = "date", second col starts with "name & address"
    if ncol >= SCH_E_COLS and h0 == SCH_E_HDR:
        h1 = _norm(hdr[1] or "")
        if "name" in h1 and "address" in h1:
            return "E"
    return None


def parse_pdf_header(pdf: pdfplumber.PDF) -> dict:
    """
    Extract committee metadata from the DR-2 Summary (page 1).

    Uses table extraction exclusively — text extraction merges the two-column
    layout and bleeds right-column values (dates, status labels) into the left-
    column metadata fields.

    Table 0 structure (7 rows):
      row 0: [committee_name, None, "Status: Filed/Amended", None]
      row 1: ["Committee Type: Iowa PAC", None, "Statutory Due Date", date]
      row 2: ["County: Dallas", None, "Adjusted Due Date", ""]
      row 3: ["District: 28", None, "Filed Date", date]
      row 4: ["Committee Code: 2677", None, "Postmark Date", ""]
      row 5: ["Political Party: Democratic", None, "Amendment Date", date]
      row 6: ["Report Date: 2026", "Candidate Name: Walton, Tom", None, None]

    Table 1: treasurer contact info. Summary tables: ["Schedule F1: Loans
    Received Total", "$2,000,000.00"] and the like, kept in meta["summary"]
    ({label: amount string}).
    """
    meta = {}
    if not pdf.pages:
        return meta

    tables = pdf.pages[0].extract_tables()
    if not tables:
        return meta

    t0 = tables[0]

    # ── Row 0: committee name + status ────────────────────────────
    if t0 and t0[0]:
        r0 = t0[0]
        if r0[0]:
            meta["committee_name"] = clean(str(r0[0]))
        if len(r0) > 2 and r0[2]:
            s = clean(str(r0[2]))
            if s.startswith("Status:"):
                meta["status"] = s.split(":", 1)[1].strip()

    # ── Rows 1–6: left-column metadata ────────────────────────────
    for row in t0[1:]:
        if not row or not row[0]:
            continue
        left = clean(str(row[0]))
        if left.startswith("Committee Type:"):
            meta["committee_type"] = left.split(":", 1)[1].strip()
        elif left.startswith("County:"):
            meta["county"] = left.split(":", 1)[1].strip()
        elif left.startswith("District:"):
            meta["district"] = left.split(":", 1)[1].strip()
        elif left.startswith("Committee Code:"):
            meta["committee_code"] = left.split(":", 1)[1].strip()
        elif left.startswith("Political Party:"):
            meta["political_party"] = left.split(":", 1)[1].strip()
        elif left.startswith("Report Date:"):
            # Candidate name lives in col 1: "Candidate Name: Walton, Tom"
            if len(row) > 1 and row[1]:
                cn = clean(str(row[1]))
                if cn.startswith("Candidate Name:"):
                    meta["candidate_name"] = cn.split(":", 1)[1].strip()

    # ── Treasurer (Table 1): "Last Name: X" in row 0 col 0 ───────
    for tbl in tables[1:]:
        if not tbl or not tbl[0] or not tbl[0][0]:
            continue
        r0 = tbl[0]
        h0 = clean(str(r0[0]))
        if not h0.startswith("Last Name:"):
            continue
        city_row = tbl[2] if len(tbl) > 2 else []
        meta["treasurer_last"]  = h0.split(":", 1)[1].strip()
        if len(r0) > 2 and r0[2]:
            meta["treasurer_first"] = clean(str(r0[2])).replace("First Name:", "").strip()
        if city_row:
            if city_row[0]:
                meta["treasurer_city"]  = clean(str(city_row[0])).replace("City:", "").strip()
            if len(city_row) > 3 and city_row[3]:
                meta["treasurer_zip"]   = clean(str(city_row[3])).replace("Zip Code:", "").strip()
        break

    # ── Summary lines: ["Schedule A: Cash Contributions Total", "$606,059.14"] ──
    meta["summary"] = {
        clean(str(row[0])): parse_amount(clean(str(row[1])))
        for tbl in tables for row in tbl
        if len(row) == 2 and row[0] and row[1] and clean(str(row[0])).startswith("Schedule ")
    }
    return meta


def has_loan_schedules(cmte_meta: dict) -> bool:
    """Whether a report's summary page shows loans received, repaid or
    forgiven — True when the summary can't be read, so nothing is missed."""
    lines = {k: v for k, v in (cmte_meta.get("summary") or {}).items()
             if _LOAN_SUMMARY_RE.match(k)}
    if not lines:
        return True
    return any(v and float(v) != 0 for v in lines.values())


def parse_sch_a_row(row: list, raw_file: str, row_num: int,
                    cmte_meta: dict, api_meta: dict) -> dict | None:
    """Parse a Sch-A (contributions) data row. Returns None if invalid."""
    if not is_data_row(row):
        return None
    date_val = parse_date(cell(row, 0))
    amount   = parse_amount(cell(row, 4))
    if not amount:
        return None

    contributor_name, street, city, addr_state, zipcode = parse_name_address(raw_cell(row, 2))
    relationship = cell(row, 3)
    # "None" is Iowa's way of saying no relationship — leave blank
    if relationship.lower() == "none":
        relationship = ""

    # Col 1 is "Contribution Committee" — committee code of donor committee
    # or payment method ("Check #\n1234"). Not a standard field but useful
    # as a proxy for contributor_type when it contains a committee code.
    col1 = cell(row, 1)

    # Detect unitemized aggregate rows
    if "unitemized" in contributor_name.lower():
        contributor_name = "Unitemized"

    return {
        "state":             STATE,
        "committee_name":    utils.clean_name(cmte_meta.get("committee_name", "")
                                              or api_meta.get("committee_name", "")),
        "contributor_name":  utils.clean_name(contributor_name),
        "amount":            amount,
        "date":              date_val,
        "transaction_type":  "Monetary",
        "contributor_type":  "",           # Iowa Sch-A has no type column
        "contributor_city":  city,
        "contributor_state": addr_state,
        "contributor_zip":   zipcode,
        "candidate_name":    utils.clean_name(
                                 cmte_meta.get("candidate_name", "")
                                 or api_meta.get("candidate_name", "")),
        "office":            _office_from_type(cmte_meta.get("committee_type", "")
                                               or api_meta.get("organization_type", "")),
        "election_year":     api_meta.get("period_year", ""),
        "filing_id":         col1,
        "state_filer_id":    _filer_id(cmte_meta, api_meta),
        "amended":           "1" if "amended" in (cmte_meta.get("status") or "").lower() else "0",
        "raw_file":          raw_file,
        "row_num":           row_num,
    }


def parse_sch_b_row(row: list, raw_file: str, row_num: int,
                    cmte_meta: dict, api_meta: dict) -> dict | None:
    """Parse a Sch-B (expenditures) data row. Returns None if invalid."""
    if not is_data_row(row):
        return None
    date_val = parse_date(cell(row, 0))
    amount   = parse_amount(cell(row, 4))
    if not amount:
        return None

    payee_name, street, city, addr_state, zipcode = parse_name_address(raw_cell(row, 2))
    purpose = cell(row, 3)

    return {
        "state":            STATE,
        "committee_name":   utils.clean_name(cmte_meta.get("committee_name", "")
                                             or api_meta.get("committee_name", "")),
        "payee_name":       utils.clean_name(payee_name),
        "amount":           amount,
        "date":             date_val,
        "transaction_type": "Monetary",
        "purpose":          purpose,
        "category":         "",
        "payee_city":       city,
        "payee_state":      addr_state,
        "payee_zip":        zipcode,
        "candidate_name":   utils.clean_name(
                                cmte_meta.get("candidate_name", "")
                                or api_meta.get("candidate_name", "")),
        "office":           _office_from_type(cmte_meta.get("committee_type", "")
                                              or api_meta.get("organization_type", "")),
        "election_year":    api_meta.get("period_year", ""),
        "filing_id":        cell(row, 1),
        "state_filer_id":   _filer_id(cmte_meta, api_meta),
        "amended":          "1" if "amended" in (cmte_meta.get("status") or "").lower() else "0",
        "raw_file":         raw_file,
        "row_num":          row_num,
    }


def parse_sch_e_row(row: list, raw_file: str, row_num: int,
                    cmte_meta: dict, api_meta: dict) -> dict | None:
    """Parse a Sch-E (in-kind contributions) data row."""
    if not is_data_row(row):
        return None
    date_val = parse_date(cell(row, 0))
    amount   = parse_amount(cell(row, 4))
    if not amount:
        return None

    contributor_name, street, city, addr_state, zipcode = parse_name_address(raw_cell(row, 1))
    description = cell(row, 3)

    return {
        "state":             STATE,
        "committee_name":    utils.clean_name(cmte_meta.get("committee_name", "")
                                              or api_meta.get("committee_name", "")),
        "contributor_name":  utils.clean_name(contributor_name),
        "amount":            amount,
        "date":              date_val,
        "transaction_type":  "In-Kind",
        "contributor_type":  "",
        "contributor_city":  city,
        "contributor_state": addr_state,
        "contributor_zip":   zipcode,
        "candidate_name":    utils.clean_name(
                                 cmte_meta.get("candidate_name", "")
                                 or api_meta.get("candidate_name", "")),
        "office":            _office_from_type(cmte_meta.get("committee_type", "")
                                               or api_meta.get("organization_type", "")),
        "election_year":     api_meta.get("period_year", ""),
        "filing_id":         "",
        "state_filer_id":    _filer_id(cmte_meta, api_meta),
        "amended":           "1" if "amended" in (cmte_meta.get("status") or "").lower() else "0",
        "raw_file":          raw_file,
        "row_num":           row_num,
    }


def parse_sch_f1_row(row: list, raw_file: str, row_num: int,
                     cmte_meta: dict, api_meta: dict) -> dict | None:
    """Parse a Sch-F1 (loans received) row → loans_debts record."""
    if not is_data_row(row):
        return None
    date_val = parse_date(cell(row, 0))
    amount   = parse_amount(cell(row, 3))
    if not amount:
        return None

    lender_name, street, city, addr_state, zipcode = parse_name_address(raw_cell(row, 1))

    return {
        "state":               STATE,
        "committee_name":      utils.clean_name(cmte_meta.get("committee_name", "")
                                                or api_meta.get("committee_name", "")),
        "original_amount":     amount,
        "date":                date_val,
        "record_type":         "loan_received",
        "counterparty_name":   utils.clean_name(lender_name),
        "lender_raw":          lender_name,   # as filed, for loan_as_contribution
        "counterparty_city":   city,
        "counterparty_state":  addr_state,
        "counterparty_zip":    zipcode,
        "candidate_name":      utils.clean_name(
                                   cmte_meta.get("candidate_name", "")
                                   or api_meta.get("candidate_name", "")),
        "election_year":       api_meta.get("period_year", ""),
        "amended":             "1" if "amended" in (cmte_meta.get("status") or "").lower() else "0",
        "filing_id":           "",
        "state_filer_id":      _filer_id(cmte_meta, api_meta),
        "raw_file":            raw_file,
        "row_num":             row_num,
    }


def parse_sch_f2_row(row: list, raw_file: str, row_num: int,
                     cmte_meta: dict, api_meta: dict) -> dict | None:
    """Parse a Sch-F2 (loans paid/forgiven) row → loans_debts record."""
    if not is_data_row(row):
        return None
    date_val = parse_date(cell(row, 0))
    amount   = parse_amount(cell(row, 3))
    if not amount:
        return None

    lender_name, street, city, addr_state, zipcode = parse_name_address(raw_cell(row, 1))

    return {
        "state":               STATE,
        "committee_name":      utils.clean_name(cmte_meta.get("committee_name", "")
                                                or api_meta.get("committee_name", "")),
        "original_amount":     amount,
        "date":                date_val,
        "record_type":         "loan_repaid",
        "counterparty_name":   utils.clean_name(lender_name),
        "counterparty_city":   city,
        "counterparty_state":  addr_state,
        "counterparty_zip":    zipcode,
        "candidate_name":      utils.clean_name(
                                   cmte_meta.get("candidate_name", "")
                                   or api_meta.get("candidate_name", "")),
        "election_year":       api_meta.get("period_year", ""),
        "amended":             "1" if "amended" in (cmte_meta.get("status") or "").lower() else "0",
        "filing_id":           "",
        "state_filer_id":      _filer_id(cmte_meta, api_meta),
        "raw_file":            raw_file,
        "row_num":             row_num,
    }


def _filer_id(cmte_meta: dict, api_meta: dict) -> str:
    """The filing committee's code, for the loader's state_filer_id: the PDF's
    "Committee Code", else the index's committeeCode."""
    return (cmte_meta.get("committee_code") or api_meta.get("committee_code", "")).strip()


# ======================= Search rows (--search) ========================

def split_person(name: str) -> tuple[str, str]:
    """(first, last) of a person's joined name, "First [Middle] Last [Suffix]":
    last = the final word plus any particle before it and suffix after it;
    first = the rest without middle initials. One word goes into last."""
    p = name.split()
    if len(p) < 2:
        return "", name.strip()
    end = len(p)
    while end > 2 and p[end - 1].lower().rstrip(",") in _NAME_SUFFIXES:
        end -= 1
    i = end - 1
    while i > 1 and p[i - 1].lower() in _NAME_PARTICLES:
        i -= 1
    first = [p[0]] + [t for t in p[1:i] if not _INITIAL_RE.match(t)]
    return " ".join(first), " ".join(p[i:])


def _search_party(row: dict) -> tuple[str, str, str, str]:
    """(full name, first, last, kind) of a search row's other party."""
    kind = row.get("kind") or "Individual"
    name = (row.get("secondaryName") or "").strip()
    if kind == "Unitemized":
        return "", "", "", kind
    if kind == "Committee":
        name = _CMTE_PREFIX_RE.sub("", name)
    if kind != "Individual":
        return utils.clean_name(name), "", name, kind
    first, last = split_person(name)
    return utils.clean_name(name), first, last, kind


def _search_common(row: dict, raw_file: str, row_num: int) -> dict:
    date_val = parse_date((row.get("date") or "")[:10])
    return {
        "state":            STATE,
        "committee_name":   utils.clean_name(_CMTE_PREFIX_RE.sub("", row.get("primaryName") or "")),
        "amount":           parse_amount(row.get("amount", "")),
        "date":             date_val,
        "office":           _office_from_type(row.get("committeeType", "")),
        "election_year":    date_val[:4],
        "filing_id":        clean(row.get("checkNumber")),
        "state_filer_id":   clean(row.get("primaryCommitteeCode")),
        "txn_id":           clean(row.get("transactionId")),
        "raw_file":         raw_file,
        "row_num":          row_num,
    }


# ---- as filed: the report PDFs' own lines for the search rows ----------

def _name_tokens(name: str) -> str:
    """A name's words, upper-cased and sorted, one-letter words and
    punctuation dropped: "Macdonald, Theresa" == "Theresa Macdonald"."""
    return " ".join(sorted(t for t in re.sub(r"[^A-Z0-9 ]", " ", (name or "").upper()).split()
                           if len(t) > 1))


def _cents(amount: str) -> int | None:
    s = (amount or "").strip()
    neg = s.startswith("(") or s.startswith("-") or "-$" in s
    digits = re.sub(r"[^\d.]", "", s)
    try:
        v = round(float(digits) * 100)
    except ValueError:
        return None
    return -v if neg else v


def _filed_key(code: str, family: str, date_val: str, cents: int, name: str) -> str:
    return f"{code}|{family}|{date_val}|{cents}|{_name_tokens(name)}"


def search_filed_key(row: dict, family: str) -> str | None:
    """The as-filed lookup key of a search row ("con" / "exp"), or None for
    an unitemized lump sum or a row without a usable date or amount."""
    if (row.get("kind") or "") == "Unitemized":
        return None
    name = (row.get("secondaryName") or "").strip()
    if row.get("kind") == "Committee":
        name = _CMTE_PREFIX_RE.sub("", name)
    date_val = parse_date((row.get("date") or "")[:10])
    cents = _cents(str(row.get("amount") or ""))
    if not name or not date_val or cents is None:
        return None
    return _filed_key(clean(row.get("primaryCommitteeCode")), family, date_val, cents, name)


def filed_records(pdf_path: Path) -> list[tuple[str, str, int, list[str]]]:
    """[(family, date, cents, lines)] for each Sch-A / Sch-E / Sch-B entry of
    a report, from its text: an entry runs from its date line to the line
    ending in its amount; lines keep their trailing spaces."""
    import pypdfium2 as pdfium        # pdfplumber's own PDF engine
    out, family, cur = [], None, None
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        for i in range(len(doc)):
            page = doc[i]
            tp = page.get_textpage()
            text = tp.get_text_range()
            tp.close()
            page.close()
            for raw in text.split("\r\n"):
                line = raw.strip()
                hdr = next((f for h, f in _FILED_HEADERS if h in line), "")
                if hdr != "":
                    family, cur = hdr, None
                    continue
                m = _FILED_DATE_RE.match(line)
                if m and family:
                    mo, d, y = m.groups()
                    cur = (family, f"{y}-{int(mo):02d}-{int(d):02d}", [line[m.end():].strip()])
                    continue
                if cur is None:
                    continue
                a = _FILED_AMT_RE.search(line)
                if a:
                    cents = _cents(a.group(1))
                    if cents is not None:
                        out.append((cur[0], cur[1], cents, cur[2] + [line[:a.start()].strip()]))
                    cur = None
                else:
                    cur[2].append(raw)
    finally:
        doc.close()
    return out


def _filed_parties(lines: list[str]) -> dict[str, tuple[str, str, str, str]]:
    """{name tokens: (name line, city, state, zip)} for each line of an entry
    that could be its party's name — single lines first, then two joined (a
    long name wraps) — with the last "City, ST zip" line after it."""
    out = {}
    for span in (1, 2):
        for i in range(len(lines) - span + 1):
            raw = " ".join([l.strip() for l in lines[i:i + span - 1]] + [lines[i + span - 1]])
            toks = _name_tokens(raw)
            if not toks or toks in out:
                continue
            city = st = zipcode = ""
            for nxt in lines[i + span:]:
                c = _FILED_CITY_RE.match(nxt.strip())
                if c:
                    city, st, zipcode = c.group(1).strip(), c.group(2).upper(), c.group(3)
            out[toks] = (raw.lstrip(), city, st, zipcode)
    return out


def build_filed_index(pdfs: list[Path], api_index: dict, wanted: set[str], log) -> dict[str, list]:
    """{search key: [(name line, city, state, zip), ...]} from every report
    PDF, kept only for the keys some search row has (wanted). Raises
    ImportError without PDFium."""
    import pypdfium2  # noqa: F401 -- fail here, not once per PDF
    index: dict[str, list] = {}
    failed = 0
    for pdf_path in pdfs:
        code = (api_index.get(pdf_path.name, {}).get("committee_code") or "").strip()
        if not code:
            continue
        try:
            entries = filed_records(pdf_path)
        except Exception as e:          # an unreadable report: its rows keep the database's values
            failed += 1
            log.warning(f"  as-filed text: {pdf_path.name}: {e}")
            continue
        for family, date_val, cents, lines in entries:
            prefix = f"{code}|{family}|{date_val}|{cents}|"
            for toks, hit in _filed_parties(lines).items():
                if prefix + toks in wanted:
                    index.setdefault(prefix + toks, []).append(hit)
    if failed:
        log.warning(f"  as-filed text: {failed} PDFs unreadable")
    return index


def filed_name_parts(line: str) -> tuple[str, str] | None:
    """(last, first) of a person's name line as filed, "{last}, {first} {mi}":
    the first ", " ends the last name ("Cortez,, Madeline" = last "Cortez,"),
    or the suffix after it ("Seward, Jr., Jack" = last "Seward, Jr."); the
    line ends in a space when the middle initial is blank, so its last word
    is an initial to drop only when it doesn't. None without a comma."""
    last, sep, first = line.partition(", ")
    if not sep:
        last, sep, first = line.partition(",")
        if not sep:
            return None
    suffix = re.match(r"(jr|sr|ii|iii|iv|v)\.?, ", first, re.I)
    if suffix:
        last, first = f"{last}, {first[:suffix.end() - 2]}", first[suffix.end():]
    words = first.split()
    if len(words) >= 2 and not line.endswith(" ") and _INITIAL_RE.match(words[-1]):
        words = words[:-1]
    return last.strip(), " ".join(words)


def _take_filed(filed: dict | None, key: str | None, city: str, zipcode: str):
    """Pop the as-filed entry for a search row's key: of twins (same day,
    amount and name), the one at the row's own city and zip if any."""
    hits = filed.get(key) if filed and key else None
    if not hits:
        return None
    for i, h in enumerate(hits):
        if (h[1].lower(), h[3]) == (city.lower(), zipcode):
            return hits.pop(i)
    return hits.pop(0)


def _apply_filed(rec: dict, side: str, kind: str, hit) -> None:
    """Overwrite a search record's name parts and city / state / zip with the
    report's (side = "contributor" / "payee"): a person's last and first from
    the name line, anyone else's whole name line into last."""
    if not hit:
        return
    line, city, st, zipcode = hit
    if kind == "Individual":
        parts = filed_name_parts(line)
        if parts and parts[0]:
            rec[f"{side}_last"], rec[f"{side}_first"] = parts
    elif kind in ("Organization", "Committee"):
        rec[f"{side}_last"], rec[f"{side}_first"] = line.strip(), ""
    if city:
        rec[f"{side}_city"], rec[f"{side}_state"], rec[f"{side}_zip"] = city, st, zipcode


def parse_search_contribution(row: dict, raw_file: str, row_num: int,
                              filed: dict | None = None) -> dict | None:
    """One Searchable Database contribution row → contributions record, with
    its party as filed when the report PDFs have its line (filed)."""
    rec = _search_common(row, raw_file, row_num)
    if not rec["amount"] or not rec["txn_id"]:
        return None
    name, first, last, kind = _search_party(row)
    code = clean(row.get("transactionType")).upper()
    tx_type = SEARCH_TYPES.get(code, code)
    if kind == "Unitemized" and tx_type == "Monetary":
        tx_type = "Unitemized"
    rec.update({
        "contributor_name":  name,
        "transaction_type":  tx_type,
        # A nameless lump sum counts as a person (the pilot importer's rule).
        "contributor_type":  "Individual" if kind == "Unitemized" else kind,
        "contributor_city":  clean(row.get("secondaryCity")),
        "contributor_state": clean(row.get("secondaryState")),
        "contributor_zip":   clean(row.get("secondaryZip")),
        "contributor_first": first,
        "contributor_last":  last,
    })
    _apply_filed(rec, "contributor", kind,
                 _take_filed(filed, search_filed_key(row, "con"),
                             rec["contributor_city"], rec["contributor_zip"]))
    return rec


def parse_search_expenditure(row: dict, raw_file: str, row_num: int,
                             filed: dict | None = None) -> dict | None:
    """One Searchable Database expenditure row → expenditures record, with
    its payee as filed when the report PDFs have its line (filed)."""
    rec = _search_common(row, raw_file, row_num)
    if not rec["amount"] or not rec["txn_id"]:
        return None
    name, first, last, kind = _search_party(row)
    code = clean(row.get("transactionType")).upper()
    rec.update({
        "payee_name":       name,
        "payee_first":      first,
        "payee_last":       last,
        "transaction_type": SEARCH_TYPES.get(code, code),
        "purpose":          "",
        "category":         "",
        "payee_city":       clean(row.get("secondaryCity")),
        "payee_state":      clean(row.get("secondaryState")),
        "payee_zip":        clean(row.get("secondaryZip")),
    })
    _apply_filed(rec, "payee", kind,
                 _take_filed(filed, search_filed_key(row, "exp"),
                             rec["payee_city"], rec["payee_zip"]))
    return rec


_CORP_SUFFIX_RE = re.compile(r"^(inc|llc|l\.l\.c|corp|co|company|ltd|lp|llp|pc|pllc|na|n\.a)\.?$", re.I)


def loan_as_contribution(rec: dict) -> dict:
    """A Sch-F1 loans_debts record re-shaped as a contributions row with
    transaction_type "Loan" (search mode): the loader books it as a loan, and
    a lender written "Last, First" keeps its two name parts, as filed."""
    raw = rec.get("lender_raw", "")
    last, _, first = raw.partition(",")
    last, first = last.strip(), first.strip()
    person = bool(first) and not _CORP_SUFFIX_RE.match(first)
    return {
        "state":             rec["state"],
        "committee_name":    rec["committee_name"],
        "contributor_name":  rec["counterparty_name"],
        "amount":            rec["original_amount"],
        "date":              rec["date"],
        "transaction_type":  "Loan",
        "contributor_type":  "Individual" if person else "Organization",
        "contributor_city":  rec["counterparty_city"],
        "contributor_state": rec["counterparty_state"],
        "contributor_zip":   rec["counterparty_zip"],
        "contributor_first": first if person else "",
        "contributor_last":  last if person else raw.strip(),
        "candidate_name":    rec["candidate_name"],
        "election_year":     rec["election_year"],
        "amended":           rec["amended"],
        "state_filer_id":    rec["state_filer_id"],
        "raw_file":          rec["raw_file"],
        "row_num":           rec["row_num"],
    }


def _office_from_type(committee_type: str) -> str:
    """
    Derive a canonical office label from Iowa's committee type strings.
    E.g. "State House" → "State House", "Statewide" → "Statewide".
    Unknown types and PAC types map to "".
    """
    t = (committee_type or "").strip()
    if not t:
        return ""
    # Candidate committee types that map cleanly to office
    offices = {
        "State House":   "State House",
        "State Senate":  "State Senate",
        "Statewide":     "Statewide",
        "County":        "County",
        "City":          "City",
        "School":        "School",
        "Judicial":      "Judicial",
    }
    for key, val in offices.items():
        if key.lower() in t.lower():
            return val
    return ""


# ========================= manifest index ===========================

def load_manifest_index() -> dict[str, dict]:
    """
    Load manifest.csv into a lookup keyed by filename.
    Used by the parser to get API-provided metadata for each PDF.
    """
    idx: dict[str, dict] = {}
    if not MANIFEST.exists():
        return idx
    with open(MANIFEST, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            fn = row.get("filename", "")
            if fn:
                idx[fn] = row
    return idx


# ============================== run ==================================

def open_writer(filename: str, fieldnames: list):
    fh = gzip.open(CLEAN_DIR / filename, "wt", encoding="utf-8", newline="")
    w  = csv.DictWriter(fh, fieldnames=fieldnames,
                        extrasaction="ignore", restval="")
    w.writeheader()
    return fh, w


def run():
    log = get_logger("iowa", "parse")
    t0  = time.perf_counter()
    log._emit("parse_started")

    total_contributions = 0
    total_expenditures  = 0
    total_loans         = 0
    committees_written  = 0
    candidates_written  = 0
    file_handles        = []

    try:
        cand_fh, cand_w = open_writer("candidates.csv.gz",    C.CANDIDATES)
        cmte_fh, cmte_w = open_writer("committees.csv.gz",    C.COMMITTEES)
        cont_fh, cont_w = open_writer("contributions.csv.gz", C.CONTRIBUTIONS)
        expn_fh, expn_w = open_writer("expenditures.csv.gz",  C.EXPENDITURES)
        loan_fh, loan_w = open_writer("loans_debts.csv.gz",   C.LOANS_DEBTS)
        file_handles = [cand_fh, cmte_fh, cont_fh, expn_fh, loan_fh]

        # ── Load manifest index ────────────────────────────────────────
        api_index = load_manifest_index()
        log.info(f"  Manifest index: {len(api_index):,} entries")

        if not api_index:
            log.warning("No manifest found — run the scraper first.")

        # ── Collect PDFs to parse ──────────────────────────────────────
        # Only parse files listed in the manifest (so orphaned old amendments
        # are never re-parsed). Sort by period_year then filename for
        # deterministic output order.
        manifest_files = sorted(
            api_index.keys(),
            key=lambda fn: (api_index[fn].get("period_year", ""), fn),
        )
        pdfs = [RAW_DIR / fn for fn in manifest_files
                if (RAW_DIR / fn).exists() and (RAW_DIR / fn).stat().st_size > 0]

        log.info(f"  PDFs to parse: {len(pdfs):,}")

        # ── Search mode (scraper --search) ─────────────────────────────
        # Its year files, when present, replace the PDFs' Sch-A / B / E; PDFs
        # then give committees, candidates and loans (Sch-F1 / F2) only.
        search_files = [
            (p, label)
            for label in ("contributions", "expenditures")
            for p in sorted(RAW_DIR.glob(f"search_{label}_*.csv"))
        ]
        search = bool(search_files)
        filed = None
        if search:
            log.info(f"  Search mode: {len(search_files)} year files; "
                     f"PDFs read for loans and committees only")
            # As filed: the PDFs' own lines for the search rows' parties
            # (see the module docstring) — keys wanted, then the PDFs' text.
            ft = time.perf_counter()
            wanted: set[str] = set()
            for path, label in search_files:
                family = "con" if label == "contributions" else "exp"
                with open(path, newline="", encoding="utf-8", errors="replace") as f:
                    for row in csv.DictReader(f):
                        key = search_filed_key(row, family)
                        if key:
                            wanted.add(key)
            try:
                filed = build_filed_index(pdfs, api_index, wanted, log)
            except ImportError as e:     # no PDFium: the database's values stand
                log.warning(f"  as-filed text unavailable ({e}); search values kept")
            log.info(f"  As filed: {len(filed or {}):,} of {len(wanted):,} search keys "
                     f"found in the PDFs ({round(time.perf_counter() - ft, 1)}s)")
            del wanted
        for path, label in search_files:
            ft = time.perf_counter()
            parse_row = (parse_search_contribution if label == "contributions"
                         else parse_search_expenditure)
            writer = cont_w if label == "contributions" else expn_w
            written = skipped = 0
            with open(path, newline="", encoding="utf-8", errors="replace") as f:
                for row_num, row in enumerate(csv.DictReader(f), start=2):
                    rec = parse_row(row, path.name, row_num, filed)
                    if rec is None:
                        skipped += 1
                        continue
                    writer.writerow(rec)
                    written += 1
            if label == "contributions":
                total_contributions += written
            else:
                total_expenditures += written
            log.file_parsed(path.name, label, written, skipped=skipped,
                            duration_s=round(time.perf_counter() - ft, 3),
                            bytes=path.stat().st_size)

        # ── Dedup sets — one committee/candidate row per unique code ───
        seen_cmte_codes: set[str] = set()
        seen_cand_codes: set[str] = set()

        # ── Iterate PDFs ───────────────────────────────────────────────
        parse_errors = 0
        for pdf_path in pdfs:
            ft       = time.perf_counter()
            raw_file = pdf_path.name
            api_meta = api_index.get(raw_file, {})

            cont_count = expn_count = loan_count = 0
            row_num    = 1   # 1-based row counter across all tables in this PDF

            try:
                with pdfplumber.open(pdf_path) as pdf:
                    # ── Page 1: committee metadata ─────────────────────
                    cmte_meta = parse_pdf_header(pdf)

                    # Fall back to manifest data when header parse is sparse
                    cmte_code = (cmte_meta.get("committee_code")
                                 or api_meta.get("committee_code", "")).strip()
                    cmte_name = (cmte_meta.get("committee_name")
                                 or api_meta.get("committee_name", "")).strip()
                    cmte_type = (cmte_meta.get("committee_type")
                                 or api_meta.get("organization_type", "")).strip()
                    cand_name = (cmte_meta.get("candidate_name")
                                 or api_meta.get("candidate_name", "")).strip()
                    party     = cmte_meta.get("political_party", "").strip()
                    district  = cmte_meta.get("district", "").strip()
                    county    = cmte_meta.get("county", "").strip()
                    period_yr = api_meta.get("period_year", "")

                    # Treasurer contact (for committee treasurer_name / city / zip)
                    treas_last  = cmte_meta.get("treasurer_last", "")
                    treas_first = cmte_meta.get("treasurer_first", "")
                    treas_name  = f"{treas_last}, {treas_first}".strip(", ") \
                                  if treas_last else ""
                    treas_city  = cmte_meta.get("treasurer_city", "")
                    treas_zip   = cmte_meta.get("treasurer_zip", "")

                    # ── Write committee row (first time we see this code) ──
                    if cmte_code and cmte_code not in seen_cmte_codes:
                        seen_cmte_codes.add(cmte_code)
                        is_candidate_cmte = (
                            api_meta.get("organization_type", "").lower() == "candidate"
                            or bool(cand_name)
                        )
                        cmte_w.writerow({
                            "state":          STATE,
                            "state_filer_id": cmte_code,
                            "committee_name": utils.clean_name(cmte_name),
                            "committee_type": cmte_type,
                            "election_year":  period_yr,
                            "candidate_name": utils.clean_name(cand_name),
                            "treasurer_name": utils.clean_name(treas_name),
                            "city":           treas_city,
                            "zip":            treas_zip,
                            "active":         "",
                            "raw_file":       raw_file,
                            "row_num":        1,
                        })
                        committees_written += 1

                        # ── Write candidate row if this is a candidate committee ──
                        if is_candidate_cmte and cand_name \
                                and cmte_code not in seen_cand_codes:
                            seen_cand_codes.add(cmte_code)
                            # Iowa names in "Last, First" format from the API;
                            # parse to first/last for candidate columns
                            cand_clean = utils.clean_name(cand_name)
                            if "," in cand_clean:
                                cand_last, cand_first = cand_clean.split(",", 1)
                                cand_last  = cand_last.strip()
                                cand_first = cand_first.strip()
                            else:
                                cand_last  = cand_clean
                                cand_first = ""

                            cand_w.writerow({
                                "state":           STATE,
                                "state_filer_id":  cmte_code,
                                "candidate_name":  cand_clean,
                                "candidate_first": cand_first,
                                "candidate_last":  cand_last,
                                "office":          _office_from_type(cmte_type),
                                "district":        district,
                                "jurisdiction":    county,
                                "party":           party,
                                "election_year":   period_yr,
                                "incumbent":       "",
                                "raw_file":        raw_file,
                                "row_num":         1,
                            })
                            candidates_written += 1

                    # ── Pages 2+: schedule data ────────────────────────
                    # Search mode reads only the loan schedules, and only in
                    # reports whose summary shows loans.
                    pages = pdf.pages[1:]
                    if search and not has_loan_schedules(cmte_meta):
                        pages = []
                    for page in pages:
                        tables = page.extract_tables()
                        page.close()     # release the page's layout cache
                        for tbl in tables:
                            sch = classify_table(tbl)
                            if sch is None or (search and sch not in ("F1", "F2")):
                                continue

                            for data_row in tbl[1:]:   # skip header row
                                row_num += 1

                                if sch == "A":
                                    rec = parse_sch_a_row(data_row, raw_file, row_num,
                                                          cmte_meta, api_meta)
                                    if rec:
                                        cont_w.writerow(rec)
                                        cont_count += 1

                                elif sch == "B":
                                    rec = parse_sch_b_row(data_row, raw_file, row_num,
                                                          cmte_meta, api_meta)
                                    if rec:
                                        expn_w.writerow(rec)
                                        expn_count += 1

                                elif sch == "E":
                                    rec = parse_sch_e_row(data_row, raw_file, row_num,
                                                          cmte_meta, api_meta)
                                    if rec:
                                        cont_w.writerow(rec)
                                        cont_count += 1

                                elif sch == "F1":
                                    rec = parse_sch_f1_row(data_row, raw_file, row_num,
                                                           cmte_meta, api_meta)
                                    if rec and search:
                                        cont_w.writerow(loan_as_contribution(rec))
                                        cont_count += 1
                                    elif rec:
                                        loan_w.writerow(rec)
                                        loan_count += 1

                                elif sch == "F2":
                                    rec = parse_sch_f2_row(data_row, raw_file, row_num,
                                                           cmte_meta, api_meta)
                                    if rec:
                                        loan_w.writerow(rec)
                                        loan_count += 1

            except Exception as e:
                log.warning(f"  Error parsing {raw_file}: {e}")
                parse_errors += 1
                continue

            total_contributions += cont_count
            total_expenditures  += expn_count
            total_loans         += loan_count

            log.file_parsed(raw_file, "pdf",
                            cont_count + expn_count + loan_count,
                            duration_s=round(time.perf_counter() - ft, 3),
                            bytes=pdf_path.stat().st_size)

        if parse_errors:
            log.warning(f"  {parse_errors} PDFs failed to parse")

        # ── Close handles before person-ID assignment ──────────────────
        for fh in file_handles:
            fh.close()
        file_handles = []

        # Iowa committee codes are per-registration (candidates may re-register
        # each cycle). Group by (state, candidate_name, office, district) to
        # assign a stable cross-cycle person_id.
        utils.assign_person_ids(CLEAN_DIR / "candidates.csv.gz", id_model="committee")
        utils.assign_committee_person_ids(CLEAN_DIR / "committees.csv.gz",
                                          CLEAN_DIR / "candidates.csv.gz")

        def _bytes(name):
            p = CLEAN_DIR / name
            return p.stat().st_size if p.exists() else 0

        log.file_parsed("contributions.csv.gz", "contributions", total_contributions,
                        role="output", bytes=_bytes("contributions.csv.gz"))
        log.file_parsed("expenditures.csv.gz",  "expenditures",  total_expenditures,
                        role="output", bytes=_bytes("expenditures.csv.gz"))
        log.file_parsed("committees.csv.gz",    "committees",    committees_written,
                        role="output", bytes=_bytes("committees.csv.gz"))
        log.file_parsed("candidates.csv.gz",    "candidates",    candidates_written,
                        role="output", bytes=_bytes("candidates.csv.gz"))
        log.file_parsed("loans_debts.csv.gz",   "loans_debts",   total_loans,
                        role="output", bytes=_bytes("loans_debts.csv.gz"))

        duration = round(time.perf_counter() - t0, 1)
        log.info(
            f"Done in {duration}s — "
            f"{total_contributions:,} contributions, "
            f"{total_expenditures:,} expenditures, "
            f"{total_loans:,} loans, "
            f"{committees_written:,} committees, "
            f"{candidates_written:,} candidates"
        )
        log._emit("parse_completed", status="completed", duration_s=duration,
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=committees_written, candidates=candidates_written)

    except KeyboardInterrupt:
        log.warning("Interrupted")
        log._emit("parse_completed", status="interrupted",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=committees_written, candidates=candidates_written)
        raise

    except Exception as e:
        log._emit("parse_completed", status="error",
                  duration_s=round(time.perf_counter() - t0, 1),
                  contributions=total_contributions, expenditures=total_expenditures,
                  committees=committees_written, candidates=candidates_written,
                  error_type=type(e).__name__, error=str(e))
        raise

    finally:
        for fh in file_handles:
            try:
                fh.close()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        sys.exit(1)
