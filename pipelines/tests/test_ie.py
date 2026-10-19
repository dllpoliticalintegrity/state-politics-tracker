"""Offline tests for the outside-spending stage (pipelines/load/ie.py).

    python3 -m unittest pipelines.tests.test_ie
"""

import sys
import unittest
from pathlib import Path

PIPELINES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINES / "load"))

import ie  # noqa: E402
import mapping  # noqa: E402

NICK = {"RICK": "RICHARD", "CHRIS": "CHRISTOPHER"}
CANDS = [
    {"id": "c-paton", "slug": "chad-paton", "name": "Chad Paton", "committee_name": "Paton for Georgia"},
    {"id": "c-jones", "slug": "burt-jones", "name": "Burt Jones", "committee_name": "Burt Jones for Georgia"},
    {"id": "c-jackson", "slug": "rick-jackson", "name": "Rick Jackson", "committee_name": "Jackson for Governor, Inc."},
    {"id": "c-djackson", "slug": "derrick-jackson", "name": "Derrick Jackson", "committee_name": None},
    {"id": "c-carr", "slug": "chris-carr", "name": "Chris Carr", "committee_name": "Carr for Georgia, Inc."},
    {"id": "c-miller", "slug": "zell-miller", "name": "Zell Miller", "committee_name": None},
]
COMMITTEES = [
    {"state_filer_id": "76", "committee_name": "Paton for Georgia", "candidate_name": "PATON, CHAD",
     "committee_type": "Candidate Committee", "affiliated_candidate_name": "", "support_oppose": ""},
    {"state_filer_id": "1911", "committee_name": "AMERICAN CONSERVATIVE FUND ACTION GEORGIA",
     "candidate_name": "", "committee_type": "Independent Committee",
     "affiliated_candidate_name": "", "support_oppose": ""},
    {"state_filer_id": "0606134", "committee_name": "Mission Michigan", "candidate_name": "",
     "committee_type": "Independent", "affiliated_candidate_name": "BURT JONES", "support_oppose": "S"},
]


def exp(fid, date, amount, target, stance, purpose="Independent Expenditure", txn="", payee="TV Co",
        committee="ACF ACTION", filing_id=""):
    return {"state_filer_id": fid, "committee_name": committee, "date": date, "amount": str(amount),
            "payee_name": payee, "purpose": purpose, "transaction_type": "Independent Expenditure",
            "affiliated_candidate_name": target, "support_oppose": stance, "txn_id": txn,
            "filing_id": filing_id, "superseded": ""}


class NormAndNames(unittest.TestCase):
    def test_norm_drops_filler_and_punctuation(self):
        self.assertEqual(ie.norm("Jackson for Governor, Inc."), "JACKSON GOVERNOR")
        self.assertEqual(ie.norm("Friends of Frank Ginn"), "FRANK GINN")
        self.assertEqual(ie.norm("  "), "")

    def test_name_parts(self):
        self.assertEqual(ie.name_parts("JACKSON, RICHARD L."), ("JACKSON", "RICHARD"))
        self.assertEqual(ie.name_parts("Rick Jackson"), ("JACKSON", "RICK"))
        self.assertEqual(ie.name_parts("John D. Sikes Jr."), ("SIKES", "JOHN"))
        self.assertEqual(ie.name_parts(""), ("", ""))

    def test_nicknames_file_loads(self):
        nick = ie.load_nicknames()
        self.assertEqual(nick.get("RICK"), "RICHARD")


class TargetResolution(unittest.TestCase):
    def setUp(self):
        self.index = ie.TargetIndex(CANDS, COMMITTEES, nicknames=NICK)

    def test_committee_name_direct(self):
        self.assertEqual(self.index.resolve("PATON FOR GEORGIA"), "c-paton")
        self.assertEqual(self.index.resolve("Jackson for Governor Inc"), "c-jackson")

    def test_via_slcf_committee_to_candidate_name(self):
        # "Paton for Georgia" -> committees.csv -> "PATON, CHAD" -> Chad Paton
        self.index.by_committee.pop("PATON GEORGIA")
        self.assertEqual(self.index.resolve("Paton for Georgia"), "c-paton")

    def test_candidate_name_forms_and_nicknames(self):
        self.assertEqual(self.index.resolve("JONES, BURT"), "c-jones")
        self.assertEqual(self.index.resolve("Burt Jones"), "c-jones")
        self.assertEqual(self.index.resolve("JONES"), "c-jones")
        self.assertEqual(self.index.resolve("JACKSON, RICHARD L."), "c-jackson")
        self.assertEqual(self.index.resolve("JACKSON, R."), "c-jackson")   # a lone initial, unique among the Jacksons
        self.assertEqual(self.index.resolve("JACKSON, D."), "c-djackson")

    def test_surname_only_needs_a_unique_tracked_surname(self):
        self.assertIsNone(self.index.resolve("JACKSON"))
        self.assertEqual(self.index.resolve("JACKSON, DERRICK"), "c-djackson")

    def test_wrong_first_name_never_matches_on_surname(self):
        self.assertIsNone(self.index.resolve("CARR, CHARLIE"))
        self.assertIsNone(self.index.resolve("FRIENDS OF JACK MILLER"))
        self.assertIsNone(self.index.resolve("Committee to Elect Matt Dubnik"))

    def test_unknown_is_none(self):
        self.assertIsNone(self.index.resolve("Hatchett for House"))
        self.assertIsNone(self.index.resolve(""))


class Affiliations(unittest.TestCase):
    def test_committee_affiliations_from_registry(self):
        aff = ie.committee_affiliations(COMMITTEES)
        self.assertEqual(aff, {"0606134": ("BURT JONES", "S")})

    def test_ie_target_prefers_the_row_then_the_committee(self):
        aff = ie.committee_affiliations(COMMITTEES)
        row = exp("1911", "2026-03-01", 100, "Paton for Georgia", "S")
        self.assertEqual(ie.ie_target(row, aff), ("Paton for Georgia", "S"))
        plain = {"state_filer_id": "0606134", "support_oppose": "", "affiliated_candidate_name": "",
                 "transaction_type": "Independent Expenditures"}
        self.assertEqual(ie.ie_target(plain, aff), ("BURT JONES", "S"))
        self.assertIsNone(ie.ie_target({"state_filer_id": "76", "support_oppose": ""}, aff))

    def test_only_real_independent_expenditures_count(self):
        aff = ie.committee_affiliations(COMMITTEES)
        # A committee-level affiliation alone is not enough: the row's own
        # type must say IE (Florida's "Friends of" committees never do).
        for ttype in ("MON", "Direct Expenditures", "", "Fundraising Expenses"):
            row = {"state_filer_id": "0606134", "support_oppose": "", "affiliated_candidate_name": "",
                   "transaction_type": ttype, "purpose": "PLACED MEDIA"}
            self.assertIsNone(ie.ie_target(row, aff), ttype)
        # Money handed to another committee is never outside spending,
        # whether the row is marked by the state or inherits the committee.
        for purpose in ("CONTRIBUTION", "Transfer", "REFUND", "Contributions to committees"):
            marked = dict(exp("1911", "2026-03-01", 100, "Paton for Georgia", "S"), purpose=purpose)
            self.assertIsNone(ie.ie_target(marked, aff), purpose)
            inherited = {"state_filer_id": "0606134", "support_oppose": "", "affiliated_candidate_name": "",
                         "transaction_type": "Independent Expenditures", "purpose": purpose}
            self.assertIsNone(ie.ie_target(inherited, aff), purpose)
        marked = dict(exp("1911", "2026-03-01", 100, "Paton for Georgia", "S"), transaction_type="Transfer", purpose="")
        self.assertIsNone(ie.ie_target(marked, aff))
        # Real IEs still count.
        ad = dict(exp("1911", "2026-03-01", 100, "Paton for Georgia", "S"), purpose="Digital ads")
        self.assertEqual(ie.ie_target(ad, aff), ("Paton for Georgia", "S"))

    def test_spender_key(self):
        by_name = ie.committees_by_name(COMMITTEES)
        self.assertEqual(ie.spender_key({"state_filer_id": "1911", "committee_name": "x"}, by_name), "1911")
        self.assertEqual(ie.spender_key({"state_filer_id": "", "committee_name": "American Conservative Fund Action Georgia"}, by_name), "1911")
        hashed = ie.spender_key({"state_filer_id": "", "committee_name": "Planned Parenthood Votes"}, by_name)
        self.assertTrue(hashed.startswith("n:") and len(hashed) == 14)
        self.assertIsNone(ie.spender_key({"state_filer_id": "", "committee_name": ""}, by_name))


class Rows(unittest.TestCase):
    def setUp(self):
        self.index = ie.TargetIndex(CANDS, COMMITTEES, nicknames=NICK)
        self.aff = ie.committee_affiliations(COMMITTEES)
        self.by_name = ie.committees_by_name(COMMITTEES)
        self.logs = []

    def run_rows(self, rows, since="2025-01-01", ids=None):
        return ie.ie_rows("ga", rows, self.index, self.aff, ids or mapping.TxnIds("ga"), since, "2026",
                          self.by_name, self.logs.append)

    def test_matched_rows_become_cf_rows(self):
        out, stats = self.run_rows([exp("1911", "2026-03-01", 1000, "Paton for Georgia", "S", txn="t1")])
        self.assertEqual(stats["matched"], 1)
        rec = out[0]
        self.assertEqual(rec["ie_filer_ident"], "ga:1911")
        self.assertEqual(rec["target_candidate_id"], "c-paton")
        self.assertEqual(rec["support_oppose"], "S")
        self.assertEqual(rec["amount"], 1000.0)
        self.assertTrue(rec["source_txn_id"].startswith("ga:t1:"))
        self.assertEqual(rec["source"], "slcf")
        self.assertEqual(rec["expenditure_date"], "2026-03-01")

    def test_blank_filer_id_spender_resolves_by_name(self):
        rows = [exp("", "2026-03-01", 500, "Paton for Georgia", "S", filing_id="234674",
                    committee="AMERICAN CONSERVATIVE FUND ACTION GEORGIA"),
                exp("", "2026-03-02", 600, "Burt Jones for Georgia", "S", filing_id="234675",
                    committee="Planned Parenthood Votes"),
                exp("", "2026-03-03", 700, "Burt Jones for Georgia", "S", filing_id="234676", committee="")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["no_spender"], 1)
        self.assertEqual(out[0]["ie_filer_ident"], "ga:1911")
        self.assertTrue(out[1]["ie_filer_ident"].startswith("ga:n:"))
        self.assertTrue(out[0]["source_txn_id"].startswith("ga:234674:"))
        comms = ie.ie_committees("ga", out, COMMITTEES)
        self.assertEqual([c["name"] for c in comms],
                         ["AMERICAN CONSERVATIVE FUND ACTION GEORGIA", "Planned Parenthood Votes"])

    def test_one_buy_splits_across_distinct_targets_once_each(self):
        # Georgia's export: one $100,643.25 buy listed 64 times for one target and once for another.
        rows = [exp("", "2026-02-17", 100643.25, "Steven McNeel for Senate", "S", filing_id="234674",
                    committee="AMERICAN CONSERVATIVE FUND ACTION GEORGIA") for _ in range(64)]
        rows.append(exp("", "2026-02-17", 100643.25, "Paton for Georgia", "S", filing_id="234674",
                        committee="AMERICAN CONSERVATIVE FUND ACTION GEORGIA"))
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["matched"], 1)
        self.assertEqual(stats["unmatched"], 64)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0]["amount"], 100643.25 / 2, places=1)
        self.assertIn("1 of 2 targets", out[0]["description"])

    def test_repeated_pair_is_kept_once_and_ids_ignore_matching(self):
        rows = [exp("1911", "2026-03-01", 3000, t, "S", txn="t9")
                for t in ("Paton for Georgia", "Paton for Georgia", "Hatchett for House")]
        out, stats = self.run_rows(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(stats["repeated"], 1)
        self.assertEqual(out[0]["amount"], 1500.0)
        # Hashed ids: assigned before filtering, so a matched twin's id is the
        # same whether or not its unmatched neighbour was filtered.
        hashed = [exp("1911", "2026-03-01", 10, "Hatchett for House", "S"),
                  exp("1911", "2026-03-01", 10, "Paton for Georgia", "S", payee="Other Co")]
        a, _ = self.run_rows(hashed)
        b, _ = self.run_rows(hashed[1:])
        self.assertEqual(a[0]["source_txn_id"], b[0]["source_txn_id"])

    def test_refiled_buy_keeps_only_the_latest_report(self):
        # Georgia: Defend US PAC's $50,905 for Gooch under filings 241569 and 241612.
        rows = [exp("1911", "2026-04-22", 50905, "Paton for Georgia", "S", txn="a", filing_id="241569"),
                exp("1911", "2026-04-22", 50905, "Paton for Georgia", "S", txn="b", filing_id="241612")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["refiled"], 1)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["source_txn_id"].startswith("ga:b:"))
        # Numeric order, not string order: report 1000 is later than 999.
        rows = [exp("1911", "2026-04-22", 10, "Paton for Georgia", "S", txn="x", filing_id="999"),
                exp("1911", "2026-04-22", 10, "Paton for Georgia", "S", txn="y", filing_id="1000")]
        out, _ = self.run_rows(rows)
        self.assertTrue(out[0]["source_txn_id"].startswith("ga:y:"))

    def test_identical_rows_on_one_report_all_count(self):
        rows = [exp("1911", "2026-07-21", 13423.12, "Paton for Georgia", "S", txn=t, filing_id="77")
                for t in ("m1", "m2", "m3")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["refiled"], 0)
        self.assertEqual(len(out), 3)

    def test_without_report_ids_identical_rows_collapse_to_latest_txn(self):
        # Arizona: no report id; the same buys in three transaction-id batches.
        rows = [exp("1911", "2026-09-28", 17340.35, "Paton for Georgia", "S", txn=t)
                for t in ("16251177", "16251215", "16251203")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["refiled"], 2)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0]["source_txn_id"].startswith("ga:16251215:"))

    def test_refiled_needs_every_field_to_agree(self):
        base = dict(fid="1911", date="2026-04-22", amount=500, target="Paton for Georgia", stance="S")
        rows = [exp(**base, txn="1", filing_id="1"),
                exp(**{**base, "amount": 501}, txn="2", filing_id="2"),
                exp(**{**base, "date": "2026-04-23"}, txn="3", filing_id="3"),
                exp(**base, txn="4", filing_id="4", payee="Mail Co"),
                exp(**{**base, "stance": "O"}, txn="5", filing_id="5")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["refiled"], 0)
        self.assertEqual(len(out), 5)

    def test_filters_and_unmatched_log(self):
        rows = [
            exp("1911", "2024-06-01", 50, "Paton for Georgia", "S"),           # before since
            dict(exp("1911", "2026-01-01", 60, "Paton for Georgia", "S"), superseded="1"),
            exp("1911", "2026-01-02", 70, "Hatchett for House", "O"),          # unmatched
            exp("76", "2026-01-03", 80, "", ""),                               # not an IE
        ]
        out, stats = self.run_rows(rows)
        self.assertEqual(out, [])
        self.assertEqual((stats["before_since"], stats["superseded"], stats["unmatched"]), (1, 1, 1))
        self.assertTrue(any("Hatchett for House $70" in l for l in self.logs))

    def test_contributions_follow_real_spender_ids_only(self):
        contribs = [
            {"state_filer_id": "1911", "txn_id": "c1", "date": "2026-02-01", "amount": "500",
             "contributor_name": "Acme Corp", "contributor_type": "Business", "transaction_type": "Contribution",
             "contributor_city": "Atlanta", "contributor_state": "GA", "superseded": ""},
            {"state_filer_id": "76", "txn_id": "c2", "date": "2026-02-01", "amount": "5",
             "contributor_name": "Nobody", "contributor_type": "Individual", "transaction_type": "Contribution"},
            {"state_filer_id": "", "txn_id": "c3", "date": "2026-02-01", "amount": "9",
             "contributor_name": "Blank", "contributor_type": "Individual", "transaction_type": "Contribution"},
        ]
        got = ie.ie_contributions("ga", contribs, {"1911", "n:abc", ""}, mapping.TxnIds("ga"),
                                  "2025-01-01", "2026", individual_types=["individual"])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["ie_filer_ident"], "ga:1911")
        self.assertEqual(got[0]["contributor_type"], "ENTITY")
        self.assertEqual(got[0]["contributor_last_name"], "Acme Corp")
        self.assertEqual(got[0]["source_txn_id"], "ga:c1")
        self.assertNotIn("zip", got[0])


if __name__ == "__main__":
    unittest.main()
