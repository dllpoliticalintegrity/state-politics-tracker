"""Offline tests for the SLCF -> cf_* loader, the job planner and the manifest.

    python3 -m unittest discover -s pipelines/tests

No network: the Supabase calls the loader makes are replaced with fakes.
"""

import contextlib
import csv
import gzip
import io
import json
import sys
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest import mock

PIPELINES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINES))
sys.path.insert(0, str(PIPELINES / "load"))

import load_cf  # noqa: E402
import mapping  # noqa: E402
import plan_matrix  # noqa: E402
import rest  # noqa: E402
import run_state  # noqa: E402

SLCF_PIPELINE = PIPELINES / "slcf" / "src" / "pipeline"
sys.path.insert(0, str(SLCF_PIPELINE))
import columns as C  # noqa: E402


class MappingTest(unittest.TestCase):
    def test_split_name(self):
        self.assertEqual(mapping.split_name("JOHN A SMITH", True), ("SMITH", "JOHN A"))
        self.assertEqual(mapping.split_name("JOHN SMITH JR", True), ("SMITH JR", "JOHN"))
        self.assertEqual(mapping.split_name("SMITH, JOHN", True), ("SMITH", "JOHN"))
        self.assertEqual(mapping.split_name("CHER", True), ("CHER", None))
        self.assertEqual(mapping.split_name("ACME HOLDINGS LLC", False), ("ACME HOLDINGS LLC", None))
        self.assertEqual(mapping.split_name("", True), (None, None))

    def test_contributor_type(self):
        self.assertEqual(mapping.contributor_type("Individual", "JOHN SMITH"), "INDIVIDUAL")
        self.assertEqual(mapping.contributor_type("Candidate", "JOHN SMITH"), "INDIVIDUAL")
        self.assertEqual(mapping.contributor_type("Non-Individual", "ACME"), "ENTITY")
        self.assertEqual(mapping.contributor_type("Political Committee", "X"), "ENTITY")
        self.assertEqual(mapping.contributor_type("", "ACME CONSULTING LLC"), "ENTITY")
        self.assertEqual(mapping.contributor_type("", "JANE DOE"), "INDIVIDUAL")
        self.assertIsNone(mapping.contributor_type("", ""))

    def test_money_and_dates(self):
        self.assertEqual(mapping.money("$1,000.50"), 1000.5)
        self.assertEqual(mapping.money("(25)"), -25.0)
        self.assertEqual(mapping.money("-100"), -100.0)
        self.assertIsNone(mapping.money("n/a"))
        self.assertEqual(mapping.iso_date("2026-03-01 00:00:00"), "2026-03-01")
        self.assertIsNone(mapping.iso_date("03/01/2026"))

    def test_source_ids_use_the_state_format(self):
        ids = mapping.TxnIds("md", {"contributions": "md:con:{id}"})
        self.assertEqual(ids.make("contributions", {"txn_id": "123"}), "md:con:123")
        self.assertEqual(ids.make("expenditures", {"txn_id": "9"}), "md:9")

    def test_hashed_ids_are_stable_and_count_twins(self):
        row = {"state_filer_id": "16171", "date": "2026-01-02", "amount": "25",
               "contributor_name": "JANE DOE", "transaction_type": "31-A"}
        a = mapping.TxnIds("oh").make("contributions", row)
        b = mapping.TxnIds("oh").make("contributions", dict(row, amount="25.00",
                                                             raw_file="x.csv", row_num="9"))
        self.assertEqual(a, b)                        # amount normalised; file/row ignored
        self.assertTrue(a.startswith("oh:h:"))
        ids = mapping.TxnIds("oh")
        first, second = ids.make("contributions", row), ids.make("contributions", row)
        self.assertEqual(second, first + "-1")        # two identical gifts stay two rows

    def test_to_cf_routes_loans_inkind_and_payments(self):
        t, r = mapping.to_cf("contributions", {"amount": "500", "date": "2026-01-01",
                                               "transaction_type": "Loan Received",
                                               "contributor_name": "JANE DOE"})
        self.assertEqual(t, "cf_loans")
        self.assertEqual(r["lender_last_name"], "DOE")
        t, r = mapping.to_cf("contributions", {"amount": "50", "date": "2026-01-01",
                                               "transaction_type": "Non-Monetary (Itemized)",
                                               "contributor_name": "ACME LLC"})
        self.assertEqual((t, r["source_form_type"], r["contributor_type"]),
                         ("cf_contributions", "INKIND", "ENTITY"))
        self.assertIsNone(mapping.to_cf("loans_debts", {"original_amount": "10", "record_type": "P"}))
        self.assertIsNone(mapping.to_cf("loans_debts", {"original_amount": "10", "record_type": "Debt"}))
        t, r = mapping.to_cf("loans_debts", {"original_amount": "10", "record_type": "O",
                                             "counterparty_name": "BARB KIRKMEYER"})
        self.assertEqual((t, r["amount"], r["lender_last_name"], r["lender_first_name"]),
                         ("cf_loans", 10.0, "BARB KIRKMEYER", None))
        t, r = mapping.to_cf("expenditures", {"amount": "9", "transaction_type": "Monetary",
                                              "purpose": "Mail", "payee_name": "HSP DIRECT"})
        self.assertEqual((r["category"], r["description"]), ("Monetary", "Mail"))
        co_exp = {"amount": "9", "category": "Monetary (Itemized)",
                  "transaction_type": "Fundraising Expenses"}
        _, r = mapping.to_cf("expenditures", co_exp, category_field="transaction_type")
        self.assertEqual(r["category"], "Fundraising Expenses")

    def test_loan_records_map_as_receipts_or_spending(self):
        rec = {"original_amount": "500000", "date": "2025-12-31", "txn_id": "12569596",
               "state_filer_id": "11948157", "record_type": "Loan Forgiven",
               "counterparty_name": "Bill Berrien", "counterparty_city": "New Berlin",
               "counterparty_state": "WI", "counterparty_zip": "53151"}
        routes = {"loan forgiven": "contributions", "personal loan payment": "expenditures"}
        self.assertEqual(mapping.loan_record_target(rec, routes), "contributions")
        self.assertIsNone(mapping.loan_record_target(dict(rec, record_type="Incurred Obligation"),
                                                     routes))
        self.assertIsNone(mapping.loan_record_target(rec, None))
        row = mapping.loan_record_as("contributions", rec)
        self.assertEqual((row["txn_id"], row["state_filer_id"], row["amount"]),
                         ("12569596", "11948157", "500000"))
        # Without the flag "Loan Forgiven" hits the loan rule and is dropped.
        self.assertIsNone(mapping.to_cf("contributions", row, ["individual"]))
        t, r = mapping.to_cf("contributions", row, ["individual"], loan_record=True)
        self.assertEqual((t, r["contributor_type"], r["contributor_first_name"],
                          r["contributor_last_name"], r["amount"], r["city"], r["zip"]),
                         ("cf_contributions", "INDIVIDUAL", "Bill", "Berrien", 500000.0,
                          "New Berlin", "53151"))
        pay = dict(rec, record_type="Personal Loan Payment", original_amount="8013.57")
        t, r = mapping.to_cf("expenditures", mapping.loan_record_as("expenditures", pay),
                             category_field="purpose", loan_record=True)
        self.assertEqual((t, r["payee_last_name"], r["category"], r["description"],
                          r["payee_state"], r["amount"]),
                         ("cf_expenditures", "Bill Berrien", "Personal Loan Payment", None,
                          "WI", 8013.57))

    def test_unitemized_lumps_keep_the_pilots_label_and_type(self):
        ga = {"label": "Unitemized (small-dollar) contributions", "type": None}
        _, r = mapping.to_cf("contributions", {"amount": "900", "contributor_type": "",
                                               "transaction_type": "Unitemized Contribution"},
                             ["individual", "self"], unitemized=ga)
        self.assertEqual((r["contributor_type"], r["contributor_last_name"]),
                         (None, "Unitemized (small-dollar) contributions"))
        ar = dict(ga, type="ENTITY")
        row = {"amount": "30", "contributor_type": "Individual",
               "contributor_name": ar["label"], "contributor_last": ar["label"]}
        _, r = mapping.to_cf("contributions", row, ["individual", "candidate"], unitemized=ar)
        self.assertEqual(r["contributor_type"], "ENTITY")
        _, r = mapping.to_cf("contributions", {"amount": "30", "contributor_type": "Individual",
                                               "contributor_name": "JANE DOE",
                                               "transaction_type": "Unitemized"},
                             ["individual"], unitemized=ar)
        self.assertEqual(r["contributor_type"], "INDIVIDUAL")   # a named row is a person

    def test_category_none_inkind_types_entity_words_and_loan_types(self):
        _, r = mapping.to_cf("expenditures", {"amount": "9", "category": "8B",
                                              "transaction_type": "8B"}, category_field=None)
        self.assertIsNone(r["category"])
        _, r = mapping.to_cf("contributions", {"amount": "9", "contributor_name": "X",
                                               "transaction_type": "5A"}, inkind_types={"5a"})
        self.assertEqual(r["source_form_type"], "INKIND")
        _, r = mapping.to_cf("contributions", {"amount": "9", "contributor_type": "",
                                               "contributor_name": "SEIU HEALTHCARE PA COPE"},
                             entity_words=["PA", "FRIENDS OF"])
        self.assertEqual(r["contributor_type"], "ENTITY")
        _, r = mapping.to_cf("contributions", {"amount": "9", "contributor_type": "",
                                               "contributor_name": "PAT SMITH"},
                             entity_words=["PA"])
        self.assertEqual(r["contributor_type"], "INDIVIDUAL")   # whole words only
        for first, want in (("Tom", "INDIVIDUAL"), ("", "ENTITY")):
            _, r = mapping.to_cf("contributions", {"amount": "9", "contributor_type": "",
                                                   "contributor_name": "EVERAGE TOM",
                                                   "contributor_first": first,
                                                   "contributor_last": "Everage"},
                                 ["individual"], type_from_name_parts=True)
            self.assertEqual(r["contributor_type"], want)
        t, _ = mapping.to_cf("loans_debts", {"original_amount": "500", "record_type": "Loan Payable",
                                             "counterparty_name": "MIKE LINDELL"})
        self.assertEqual(t, "cf_loans")
        for rt in ("Unpaid Expenditure", "Durable Asset"):
            self.assertIsNone(mapping.to_cf("loans_debts", {"original_amount": "5",
                                                            "record_type": rt}), rt)

    def test_unitemized_form_type(self):
        al = {"form_type": "NON-ITEMIZED"}
        _, r = mapping.to_cf("contributions", {"amount": "20", "contributor_type": "Individual",
                                               "transaction_type": "Non-Itemized"}, unitemized=al)
        self.assertEqual(r["source_form_type"], "NON-ITEMIZED")
        _, r = mapping.to_cf("contributions", {"amount": "20", "contributor_type": "Individual",
                                               "transaction_type": "Non-Itemized In-Kind"},
                             unitemized=al)
        self.assertEqual(r["source_form_type"], "INKIND")

    def test_nonmoney_payee_parts_and_loan_balances(self):
        _, r = mapping.to_cf("contributions", {"amount": "5", "contributor_name": "X",
                                               "transaction_type": "Itemized Nonmoney"})
        self.assertEqual(r["source_form_type"], "INKIND")
        _, r = mapping.to_cf("expenditures", {"amount": "9", "payee_name": "SPEED, MARY BETH",
                                              "payee_last": "Speed", "payee_first": "Mary Beth"})
        self.assertEqual((r["payee_last_name"], r["payee_first_name"]), ("Speed", "Mary Beth"))
        for t in ("Outstanding Loan", "Loan Payment", "Loan Forgiven"):
            self.assertIsNone(mapping.to_cf("contributions", {"amount": "5", "transaction_type": t}), t)
        t, _ = mapping.to_cf("contributions", {"amount": "5", "transaction_type": "Loan Received"})
        self.assertEqual(t, "cf_loans")

    def test_source_name_parts_and_pilot_type_rule(self):
        row = {"amount": "5", "contributor_name": "JOHN A VAN NORTWICK JR",
               "contributor_first": "JOHN", "contributor_last": "VAN NORTWICK",
               "contributor_type": "Individual"}
        _, r = mapping.to_cf("contributions", row, ["individual"])
        self.assertEqual((r["contributor_last_name"], r["contributor_first_name"],
                          r["contributor_type"]), ("VAN NORTWICK", "JOHN", "INDIVIDUAL"))
        _, r = mapping.to_cf("contributions", {"amount": "5", "contributor_type": ""},
                             ["individual"])
        self.assertEqual(r["contributor_type"], "ENTITY")   # the pilot's rule: blank = ENTITY
        self.assertIsNone(mapping.to_cf("expenditures", {"amount": ""}))


class PlanTest(unittest.TestCase):
    STATES = {
        "mi": {"pipeline": "pilot"}, "co": {"pipeline": "pilot"},
        "oh": {"pipeline": "slcf", "nightly": False}, "ga": {"pipeline": "slcf"},
        "nv": {"pipeline": "slcf", "dry_run_only": True},
        "tx": {"pipeline": "tec"}, "ca": {"pipeline": "calaccess"},
        "me": {"pipeline": "none"},
    }

    def plan(self, codes, dry_run=False):
        return plan_matrix.plan(codes, dry_run, self.STATES)

    def test_schedule_runs_every_nightly_state(self):
        self.assertEqual(self.plan([]), (["mi", "co"], ["ga"]))

    def test_pilot_rosters_state_is_in_both_jobs(self):
        states = {"mi": {"pipeline": "slcf", "pilot_rosters": True}, "ga": {"pipeline": "slcf"}}
        self.assertEqual(plan_matrix.plan([], states=states), (["mi"], ["mi", "ga"]))
        self.assertEqual(plan_matrix.plan(["mi"], dry_run=True, states=states), ([], ["mi"]))

    def test_named_states_ignore_nightly(self):
        self.assertEqual(self.plan(["OH", "mi"]), (["mi"], ["oh"]))

    def test_dry_run_sends_everything_to_slcf(self):
        self.assertEqual(self.plan(["co", "oh"], dry_run=True), ([], ["co", "oh"]))

    def test_dry_run_only_states(self):
        self.assertEqual(self.plan(["nv"], dry_run=True), ([], ["nv"]))
        with self.assertRaises(ValueError):
            self.plan(["nv"])                     # a console Sync can't load it for real

    def test_refusals(self):
        for codes, dry in ((["tx"], False), (["ca"], False), (["ca"], True),
                           (["me"], False), (["zz"], False),
                           ([], True)):
            with self.assertRaises(ValueError):
                self.plan(codes, dry)


class RunStateTest(unittest.TestCase):
    def test_scrape_errors_read_from_the_run_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(run_state, "PIPELINES", Path(tmp)):
                d = Path(tmp) / "slcf" / "logs" / "prod" / "r1"
                d.mkdir(parents=True)
                (d / "log.jsonl").write_text("\n".join(json.dumps(e) for e in [
                    {"operation": "scrape", "type": "file_download", "status": "ok"},
                    {"operation": "scrape", "type": "file_download", "status": "error",
                     "filename": "2026-09.csv", "error": "HTTP 500"},
                    {"operation": "parse", "status": "error"},
                ]))
                self.assertEqual(run_state.scrape_errors("r1"), ["2026-09.csv: HTTP 500"])
                self.assertTrue(run_state.scrape_errors("missing"))   # no log = not clean


class ManifestTest(unittest.TestCase):
    def test_texas_keeps_its_infrastructure_and_michigan_keeps_its_rosters(self):
        states = json.loads((PIPELINES / "states.json").read_text())["states"]
        self.assertEqual(states["tx"]["pipeline"], "tec")
        # Michigan's finance is on SLCF (2026-10-18); the pilot importer still
        # derives its legislature roster and ballot status every night.
        self.assertEqual(states["mi"]["pipeline"], "slcf")
        self.assertTrue(states["mi"].get("pilot_rosters"))
        for st, e in states.items():
            self.assertIn(e["pipeline"], ("slcf", "pilot", "tec", "calaccess", "none"), st)
        self.assertEqual(states["ca"]["pipeline"], "calaccess")

    def test_arizona_small_gift_lumps_are_individuals(self):
        # "Multiple Contributors": a period's lump sum of in-state gifts of
        # $100 or less, which SeeTheMoney reports without donor names.
        az = set(json.loads((PIPELINES / "states.json").read_text())["states"]["az"]["individual_types"])
        for raw in ("In-State Contributions $100 or Less", "Refund Contribution Less than $50"):
            self.assertEqual(mapping.contributor_type(raw, "Multiple Contributors", az), "INDIVIDUAL")
        self.assertEqual(mapping.contributor_type("Contribution from PACs", "Some PAC", az), "ENTITY")

    def test_arizona_lumps_take_the_unitemized_label_whatever_the_filer_named_them(self):
        az = json.loads((PIPELINES / "states.json").read_text())["states"]["az"]
        for name in ("Multiple Contributors", "Multiple Vendors"):
            row = {"contributor_name": name, "contributor_type": "In-State Contributions $100 or Less",
                   "transaction_type": "In-State Contributions $100 or Less", "amount": "513371.38",
                   "date": "2026-09-30"}
            table, out = mapping.to_cf("contributions", row, set(az["individual_types"]),
                                       az["category_field"], az["unitemized"])
            self.assertEqual((table, out["contributor_type"], out["contributor_last_name"], out["contributor_first_name"]),
                             ("cf_contributions", "INDIVIDUAL", "Unitemized (small-dollar) contributions", None))
        named = {"contributor_name": "Smith, Jane", "contributor_type": "Contribution from Individuals",
                 "transaction_type": "Contribution from Individuals", "amount": "500", "date": "2026-09-30"}
        _, out = mapping.to_cf("contributions", named, set(az["individual_types"]), az["category_field"], az["unitemized"])
        self.assertEqual((out["contributor_last_name"], out["contributor_first_name"]), ("Smith", "Jane"))

    def test_schedule_covers_every_pilot_state_once(self):
        # Every state the pilot imported before the merge is still scheduled
        # by one finance pipeline; Texas never is. Michigan is in both lists:
        # SLCF for finance, the pilot job for its rosters (pilot_rosters).
        pilot, slcf = plan_matrix.plan([])
        before = "mi al ak ar az co ct fl ga hi ia id il ks ky ma md mn pa wi".split()
        finance = [c for c in pilot if c != "mi"] + slcf
        self.assertEqual(sorted(finance), sorted(set(finance)))
        self.assertTrue(set(before) <= set(pilot + slcf))
        self.assertIn("mi", pilot)
        self.assertIn("mi", slcf)
        self.assertNotIn("tx", pilot + slcf)
        self.assertNotIn("ca", pilot + slcf)

    def test_loader_columns_stay_out_of_slcf_master_db(self):
        for t in ("CONTRIBUTIONS", "EXPENDITURES", "LOANS_DEBTS"):
            for col in ("state_filer_id", "txn_id", "superseded"):
                self.assertIn(col, getattr(C, t))
                self.assertNotIn(col, getattr(C, t + "_AGG"))
        for col in ("payee_first", "payee_last"):
            self.assertIn(col, C.EXPENDITURES)
            self.assertNotIn(col, C.EXPENDITURES_AGG)


def write_gz(path, fields, rows):
    with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, restval="", extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


class LoaderTest(unittest.TestCase):
    REFS = {"co:1": ("uuid-weiser", "phil-weiser"), "co:2": ("uuid-marx", "victor-marx")}
    ENTRY = {"pipeline": "pilot", "cycle": "2026"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clean = Path(self.tmp.name) / "Colorado" / "cleaned"
        self.clean.mkdir(parents=True)
        c = lambda **kw: dict({"state_filer_id": "1", "date": "2026-02-01", "amount": "10",
                               "contributor_name": "JANE DOE", "contributor_type": "Individual",
                               "transaction_type": "Monetary (Itemized)"}, **kw)
        write_gz(self.clean / "contributions.csv.gz", C.CONTRIBUTIONS, [
            c(txn_id="100"),
            c(txn_id="101", superseded="1"),                 # replaced by an amendment
            c(txn_id="102", date="2024-12-31"),              # before since
            c(txn_id="103", state_filer_id="999"),           # untracked committee
            c(txn_id="100"),                                 # overlapping year file
            c(txn_id="104", state_filer_id="2", amount="-10"),
        ])
        write_gz(self.clean / "expenditures.csv.gz", C.EXPENDITURES, [
            {"state_filer_id": "2", "date": "2026-03-01", "amount": "5", "txn_id": "200",
             "payee_name": "HSP DIRECT"},
            {"state_filer_id": "2", "date": "2026-03-01", "amount": "5", "txn_id": "201",
             "transaction_type": "FEC_NONFEDERAL_IE"},
        ])

    def tearDown(self):
        self.tmp.cleanup()

    def rows(self):
        return list(load_cf.rows_for_state("co", self.ENTRY, self.clean, self.REFS))

    def test_filters_and_ids(self):
        got = [(t, slug, r["source_txn_id"], r["amount"]) for t, slug, r in self.rows()]
        self.assertEqual(got, [
            ("cf_contributions", "phil-weiser", "co:100", 10.0),
            ("cf_contributions", "victor-marx", "co:104", -10.0),
            ("cf_expenditures", "victor-marx", "co:200", 5.0),
        ])
        _, _, r = self.rows()[0]
        self.assertEqual((r["candidate_id"], r["committee_id"], r["source"], r["cycle"]),
                         ("uuid-weiser", "co:1", "slcf", "2026"))

    def test_skip_types(self):
        entry = dict(self.ENTRY, skip_types={"contributions": ["Interest"]})
        write_gz(self.clean / "contributions.csv.gz", C.CONTRIBUTIONS, [
            {"state_filer_id": "1", "date": "2026-02-01", "amount": "9", "txn_id": "1",
             "transaction_type": "interest", "contributor_name": "CHAIN BRIDGE BANK"},
            {"state_filer_id": "1", "date": "2026-02-01", "amount": "9", "txn_id": "2",
             "transaction_type": "Individual", "contributor_name": "JANE DOE"}])
        got = [r["source_txn_id"] for _, _, r in
               load_cf.rows_for_state("co", entry, self.clean, self.REFS)]
        self.assertEqual(got[0], "co:2")

    def test_loan_records(self):
        l = lambda txn, rt: {"state_filer_id": "1", "date": "2026-02-01",
                             "original_amount": "100", "txn_id": txn, "record_type": rt,
                             "counterparty_name": "PHIL WEISER"}
        write_gz(self.clean / "loans_debts.csv.gz", C.LOANS_DEBTS, [
            l("300", "Personal Loan"), l("301", "Loan Forgiven"),
            l("302", "personal loan payment"), l("303", "Incurred Obligation")])
        entry = dict(self.ENTRY, loan_records={"Loan Forgiven": "contributions",
                                               "Personal Loan Payment": "expenditures"},
                     id_format={"expenditures": "co:e{id}"})
        got = {r["source_txn_id"]: t for t, _, r in
               load_cf.rows_for_state("co", entry, self.clean, self.REFS)}
        # Ids follow the target table's format; the unlisted obligation is
        # still dropped, the loan still lands in cf_loans.
        self.assertEqual({k: v for k, v in got.items() if k.startswith(("co:3", "co:e3"))},
                         {"co:300": "cf_loans", "co:301": "cf_contributions",
                          "co:e302": "cf_expenditures"})
        with self.assertRaises(SystemExit):
            list(load_cf.rows_for_state("co", dict(entry, loan_records={"Loan Forgiven": "loans"}),
                                        self.clean, self.REFS))

    def test_hashed_cutover_prunes_against_the_rows_live_before_the_load(self):
        # A hashed-id state's first run: none of SLCF's ids are live yet, the
        # pilot's three rows are. Judged after the upsert, live would be six
        # rows (50%) and the guard would refuse, leaving both copies live.
        write_gz(self.clean / "contributions.csv.gz", C.CONTRIBUTIONS, [
            {"state_filer_id": "1", "date": "2026-02-0%d" % d, "amount": "10",
             "contributor_name": "JANE DOE %d" % d} for d in (1, 2, 3)])
        write_gz(self.clean / "expenditures.csv.gz", C.EXPENDITURES, [])
        db = {("cf_contributions", "co:%032x" % i): (10.0, "2026-02-01") for i in range(3)}
        deleted = []

        def live_stats(st, refs):
            stats = defaultdict(load_cf.new_stat)
            for (t, txn), (amt, d) in db.items():
                load_cf.add(stats[("phil-weiser", t)], amt, d, txn)
            return stats

        def upsert(table, rows, **kw):
            db.update({(table, r["source_txn_id"]): (r["amount"], r["contribution_date"])
                       for r in rows})

        def delete(path):
            deleted.append(path)
            for txn in path.split("source_txn_id=in.(")[1].rstrip(")").split(","):
                db.pop(("cf_contributions", txn.strip('"')), None)

        with mock.patch.object(load_cf, "manifest_entry", return_value=dict(self.ENTRY, prune=True)), \
             mock.patch.object(load_cf, "candidate_refs", return_value=self.REFS), \
             mock.patch.object(load_cf, "live_stats", side_effect=live_stats), \
             mock.patch.object(load_cf.rest, "SUPABASE_URL", "http://db"), \
             mock.patch.object(load_cf.rest, "KEY", "k"), \
             mock.patch.object(load_cf.rest, "upsert", side_effect=upsert), \
             mock.patch.object(load_cf.rest, "delete", side_effect=delete), \
             contextlib.redirect_stdout(io.StringIO()):
            load_cf.main(["--state", "co", "--data-dir", self.tmp.name])
        self.assertEqual(len(deleted), 1)
        self.assertEqual(len(db), 3)
        self.assertTrue(all(txn.startswith("co:h:") for _, txn in db))

    def test_missing_loader_columns_is_an_error(self):
        write_gz(self.clean / "contributions.csv.gz", ["state", "amount"], [{"amount": "1"}])
        with self.assertRaises(SystemExit):
            self.rows()

    def stats(self, rows):
        s = load_cf.defaultdict(load_cf.new_stat)
        for key, amount, date, txn in rows:
            load_cf.add(s[key], amount, date, txn)
        return s

    def test_stale_rows_are_those_slcf_no_longer_has_inside_the_window(self):
        k = ("victor-marx", "cf_expenditures")
        new = self.stats([(k, 5, "2026-03-01", "co:200")])
        live = self.stats([(k, 5, "2026-03-01", "co:200"),
                           (k, 187687.85, "2026-08-31", "co:1702268"),   # superseded
                           (k, 7, "2024-06-01", "co:1")])               # before since
        self.assertEqual(load_cf.stale_ids(new, live, "2025-01-01"), {k: {"co:1702268": 187687.85}})

    def test_prune_min_share_override(self):
        k = ("victor-marx", "cf_expenditures")
        live = self.stats([(k, 1, "2026-03-01", f"co:{i}") for i in range(10)])
        half = self.stats([(k, 1, "2026-03-01", f"co:{i}") for i in range(5)])
        with mock.patch.object(rest, "delete") as delete:
            load_cf.prune("co", self.REFS, half, live, "2025-01-01", min_share=0.45)
        self.assertTrue(delete.called)

    def test_prune_deletes_stale_rows_and_refuses_a_truncated_load(self):
        k = ("victor-marx", "cf_expenditures")
        live = self.stats([(k, 1, "2026-03-01", f"co:{i}") for i in range(10)])
        full = self.stats([(k, 1, "2026-03-01", f"co:{i}") for i in range(9)])
        with mock.patch.object(rest, "delete") as delete:
            load_cf.prune("co", self.REFS, full, live, "2025-01-01")
        (path,), _ = delete.call_args
        self.assertIn("source=eq.slcf", path)
        self.assertIn("candidate_id=eq.uuid-marx", path)
        self.assertIn('source_txn_id=in.("co:9")', path)
        truncated = self.stats([(k, 1, "2026-03-01", "co:0")])
        with mock.patch.object(rest, "delete") as delete, self.assertRaises(SystemExit):
            load_cf.prune("co", self.REFS, truncated, live, "2025-01-01")
        delete.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class ScrapeScope(unittest.TestCase):
    def test_entities_follow_ie_unless_switched_off(self):
        import run_state
        self.assertEqual(run_state.scrape_scope({}), ["--transactions"])
        self.assertEqual(run_state.scrape_scope({"ie": True}), ["--transactions", "--entities"])
        self.assertEqual(run_state.scrape_scope({"ie": True, "entities": False}), ["--transactions"])
        states = json.loads((PIPELINES / "states.json").read_text())["states"]
        self.assertEqual(run_state.scrape_scope(states["ak"]), ["--transactions"])
        self.assertEqual(run_state.scrape_scope(states["fl"]), ["--transactions", "--entities"])
