"""
SLCF canonical rows -> cf_* rows. Pure functions, no I/O; pinned by
tests/test_mapping.py.

SLCF's cleaned tables (pipelines/slcf/src/pipeline/columns.py) are the input:
contributions, expenditures and loans_debts, each carrying state_filer_id (the
filing committee) and txn_id (the source's own transaction id, blank where
the state publishes none). The output rows match the cf_* columns the pilot
importer writes (supabase/migrations/20260717000000_cf_schema.sql).
"""

import hashlib
import re

# SLCF table -> cf_* table it loads into.
CF_TABLE = {
    "contributions": "cf_contributions",
    "expenditures": "cf_expenditures",
    "loans_debts": "cf_loans",
}

AMOUNT_FIELD = {"contributions": "amount", "expenditures": "amount",
                "loans_debts": "original_amount"}

# Fields hashed into a synthetic id when the state publishes no transaction
# id. Never raw_file / row_num / filing_id: those change when a file is
# re-downloaded or a report amended, and the id must not.
HASH_FIELDS = {
    "contributions": ("state_filer_id", "date", "amount", "contributor_name",
                      "contributor_city", "contributor_state", "contributor_zip",
                      "transaction_type", "employer", "occupation"),
    "expenditures": ("state_filer_id", "date", "amount", "payee_name", "payee_city",
                     "payee_state", "payee_zip", "purpose", "transaction_type"),
    "loans_debts": ("state_filer_id", "date", "original_amount", "counterparty_name",
                    "record_type"),
}

_INDIVIDUAL_TYPE = re.compile(r"^(individual|self|candidate|family|spouse|person)", re.I)
_INKIND = re.compile(r"in[\s-]?kind|non[\s-]?monetary", re.I)
_LOAN = re.compile(r"\bloans?\b", re.I)
# loans_debts record types that are not money lent to the committee: payments
# on a loan, forgiveness, and debts (unpaid bills) owed by the committee.
_NOT_A_LOAN = re.compile(r"^p$|pay|forgiv|debt|owed|obligation", re.I)
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_SUFFIXES = {"JR", "JR.", "SR", "SR.", "II", "III", "IV", "V"}
# The pilot importer's organisation-name heuristic, for rows whose source
# carries no contributor/lender type.
_ENTITY_NAME = re.compile(
    r"\b(INC|LLC|LLP|L\.L\.C|PAC|COMMITTEE|PARTY|CORP|CORPORATION|ASSN|"
    r"ASSOCIATION|COMPANY|FUND|GROUP|TRUST|BANK|ENTERPRISES|PARTNERS|"
    r"HOLDINGS|AMERICA|USA|PLLC|FARMS|SERVICES|CONSULTING|"
    r"REALTY|PROPERTIES|CLUB|COALITION|ALLIANCE|FEDERATION|UNION|CHAMBER)\b",
    re.I,
)


def text(v):
    v = (v or "").strip()
    return v or None


def money(v):
    s = (v or "").replace("$", "").replace(",", "").strip()
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def iso_date(v):
    m = _DATE.match((v or "").strip())
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def is_entity_name(name):
    return bool(name and _ENTITY_NAME.search(name))


def contributor_type(raw, name, individual_types=None):
    """INDIVIDUAL / ENTITY from SLCF's per-state contributor_type, falling back
    to the name heuristic when the state gives none.

    individual_types (states.json): the exact raw values, lower-cased, that
    mean a person; every other value, blank included, is ENTITY. Set it to the
    pilot importer's own rule for a state being cut over, so the site's
    individual / organisation split doesn't move."""
    raw = (raw or "").strip()
    if individual_types is not None:
        return "INDIVIDUAL" if raw.lower() in individual_types else "ENTITY"
    if raw:
        return "INDIVIDUAL" if _INDIVIDUAL_TYPE.match(raw) else "ENTITY"
    if not name:
        return None
    return "ENTITY" if is_entity_name(name) else "INDIVIDUAL"


def split_name(name, individual):
    """(last, first). SLCF stores one full-name string; an organisation goes
    whole into last_name (as the pilot does), a person splits on the last word
    that isn't a suffix, so first + ' ' + last reads back as the full name."""
    name = (name or "").strip()
    if not name:
        return None, None
    if not individual:
        return name, None
    if "," in name:                                   # "LAST, FIRST M"
        last, first = (p.strip() for p in name.split(",", 1))
        return last or None, first or None
    parts = name.split()
    i = len(parts) - 1
    while i > 0 and parts[i].upper() in _SUFFIXES:
        i -= 1
    if i == 0:
        return name, None
    return " ".join(parts[i:]), " ".join(parts[:i])


def is_inkind(transaction_type):
    return bool(_INKIND.search(transaction_type or ""))


def is_loan_receipt(transaction_type):
    return bool(_LOAN.search(transaction_type or ""))


def is_lent_money(record_type):
    return not _NOT_A_LOAN.search((record_type or "").strip())


class TxnIds:
    """source_txn_id for each row of one state's run.

    With a source transaction id: id_format[table] (default "{st}:{id}"), so a
    state can reproduce the pilot importer's exact ids — e.g. "md:con:{id}" —
    and upsert onto its existing rows. Without one: "{st}:h:" + 16 hex digits
    of md5(HASH_FIELDS), plus "-n" for the n-th identical row in the run (two
    identical $25 gifts on the same day are two gifts). The "h:" namespace
    keeps synthetic ids from ever colliding with source ids."""

    def __init__(self, st, id_format=None):
        self.st = st
        self.id_format = id_format or {}
        self._seen = {}

    def source(self, table, source_id):
        fmt = self.id_format.get(table, "{st}:{id}")
        return fmt.format(st=self.st, id=source_id)

    def hashed(self, table, row):
        parts = []
        for f in HASH_FIELDS[table]:
            v = (row.get(f) or "").strip().upper()
            if f in ("amount", "original_amount"):
                m = money(v)
                v = f"{m:.2f}" if m is not None else v
            parts.append(v)
        base = f"{self.st}:h:" + hashlib.md5("|".join(parts).encode()).hexdigest()[:16]
        n = self._seen.get((table, base), 0)
        self._seen[(table, base)] = n + 1
        return base if n == 0 else f"{base}-{n}"

    def make(self, table, row):
        sid = (row.get("txn_id") or "").strip()
        return self.source(table, sid) if sid else self.hashed(table, row)


def to_cf(table, row, individual_types=None, category_field="category"):
    """(cf_table, row) for one SLCF row, or None when it carries nothing the
    site shows. Ids, candidate and cycle are added by the caller.

    category_field (states.json): which SLCF column holds the spending
    category the site groups expenditures by. SLCF's `category` varies by
    state — Colorado's is the payment form ("Monetary (Itemized)") and its
    spending type ("Fundraising Expenses") is in transaction_type."""
    amount = money(row.get(AMOUNT_FIELD[table]))
    if amount is None:
        return None
    date = iso_date(row.get("date"))

    if table == "contributions":
        name = text(row.get("contributor_name"))
        ctype = contributor_type(row.get("contributor_type"), name, individual_types)
        if text(row.get("contributor_last")) or text(row.get("contributor_first")):
            last, first = text(row.get("contributor_last")), text(row.get("contributor_first"))
        else:
            last, first = split_name(name, ctype != "ENTITY")
        if is_loan_receipt(row.get("transaction_type")):
            # The pilot's rule: a loan reported on the receipts schedule is a
            # loan, not a contribution.
            return "cf_loans", {
                "lender_type": ctype, "lender_last_name": last,
                "lender_first_name": first, "amount": amount, "loan_date": date,
            }
        return "cf_contributions", {
            "contributor_type": ctype,
            "contributor_last_name": last,
            "contributor_first_name": first,
            "employer": text(row.get("employer")),
            "occupation": text(row.get("occupation")),
            "amount": amount,
            "contribution_date": date,
            "city": text(row.get("contributor_city")),
            "state": text(row.get("contributor_state")),
            "zip": text(row.get("contributor_zip")),
            "source_form_type": "INKIND" if is_inkind(row.get("transaction_type")) else None,
        }

    if table == "expenditures":
        return "cf_expenditures", {
            "payee_last_name": text(row.get("payee_name")),
            "payee_city": text(row.get("payee_city")),
            "payee_state": text(row.get("payee_state")),
            "payee_zip": text(row.get("payee_zip")),
            "amount": amount,
            "expenditure_date": date,
            "category": (text(row.get(category_field)) or text(row.get("category"))
                         or text(row.get("transaction_type"))),
            "description": text(row.get("purpose")),
        }

    if not is_lent_money(row.get("record_type")):
        return None
    # The whole lender name goes in lender_last_name, as the pilot importer
    # stores it (loans_debts has no separate name parts to split on).
    name = text(row.get("counterparty_name"))
    individual = bool(name) and not is_entity_name(name)
    return "cf_loans", {
        "lender_type": None if not name else ("INDIVIDUAL" if individual else "ENTITY"),
        "lender_last_name": name, "lender_first_name": None,
        "amount": amount, "loan_date": date,
    }
