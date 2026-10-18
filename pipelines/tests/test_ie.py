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

CANDS = [
    {"id": "c-paton", "slug": "chad-paton", "name": "Chad Paton", "committee_name": "Paton for Georgia"},
    {"id": "c-jones", "slug": "burt-jones", "name": "Burt Jones", "committee_name": "Burt Jones for Georgia"},
    {"id": "c-jackson", "slug": "rick-jackson", "name": "Rick Jackson", "committee_name": "Jackson for Governor, Inc."},
    {"id": "c-djackson", "slug": "derrick-jackson", "name": "Derrick Jackson", "committee_name": None},
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


def exp(fid, date, amount, target, stance, purpose="Independent Expenditure", txn="", payee="TV Co"):
    return {"state_filer_id": fid, "committee_name": "ACF ACTION", "date": date, "amount": str(amount),
            "payee_name": payee, "purpose": purpose, "transaction_type": "Independent Expenditure",
            "affiliated_candidate_name": target, "support_oppose": stance, "txn_id": txn, "superseded": ""}


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


class TargetResolution(unittest.TestCase):
    def setUp(self):
        self.index = ie.TargetIndex(CANDS, COMMITTEES)

    def test_committee_name_direct(self):
        self.assertEqual(self.index.resolve("PATON FOR GEORGIA"), "c-paton")
        self.assertEqual(self.index.resolve("Jackson for Governor Inc"), "c-jackson")

    def test_via_slcf_committee_to_candidate_name(self):
        # "Paton for Georgia" -> committees.csv -> "PATON, CHAD" -> Chad Paton
        self.index.by_committee.pop("PATON GEORGIA")
        self.assertEqual(self.index.resolve("Paton for Georgia"), "c-paton")

    def test_candidate_name_forms(self):
        self.assertEqual(self.index.resolve("JONES, BURT"), "c-jones")
        self.assertEqual(self.index.resolve("Burt Jones"), "c-jones")
        self.assertEqual(self.index.resolve("JONES"), "c-jones")

    def test_ambiguous_surname_needs_an_initial(self):
        self.assertIsNone(self.index.resolve("JACKSON"))
        self.assertEqual(self.index.resolve("JACKSON, DERRICK"), "c-djackson")
        self.assertEqual(self.index.resolve("JACKSON, RICHARD L."), "c-jackson")

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
        plain = {"state_filer_id": "0606134", "support_oppose": "", "affiliated_candidate_name": ""}
        self.assertEqual(ie.ie_target(plain, aff), ("BURT JONES", "S"))
        self.assertIsNone(ie.ie_target({"state_filer_id": "76", "support_oppose": ""}, aff))


class Rows(unittest.TestCase):
    def setUp(self):
        self.index = ie.TargetIndex(CANDS, COMMITTEES)
        self.aff = ie.committee_affiliations(COMMITTEES)
        self.ids = mapping.TxnIds("ga")
        self.logs = []

    def run_rows(self, rows, since="2025-01-01"):
        return ie.ie_rows("ga", rows, self.index, self.aff, self.ids, since, "2026", self.logs.append)

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

    def test_multi_target_twins_split_the_amount(self):
        rows = [exp("1911", "2026-03-01", 3000, t, "S", txn="t9")
                for t in ("Paton for Georgia", "Hatchett for House", "Burt Jones for Georgia")]
        out, stats = self.run_rows(rows)
        self.assertEqual(stats["matched"], 2)
        self.assertEqual(stats["unmatched"], 1)
        self.assertEqual([r["amount"] for r in out], [1000.0, 1000.0])
        self.assertIn("1 of 3 targets", out[0]["description"])
        self.assertNotEqual(out[0]["source_txn_id"], out[1]["source_txn_id"])

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

    def test_committees_and_contributions(self):
        out, _ = self.run_rows([exp("1911", "2026-03-01", 1000, "Paton for Georgia", "S", txn="t1")])
        comms = ie.ie_committees("ga", out, COMMITTEES, {"1911": "ACF ACTION"})
        self.assertEqual(comms, [{"filer_ident": "ga:1911", "state": "ga",
                                  "name": "AMERICAN CONSERVATIVE FUND ACTION GEORGIA",
                                  "committee_type": "Independent Committee"}])
        contribs = [
            {"state_filer_id": "1911", "txn_id": "c1", "date": "2026-02-01", "amount": "500",
             "contributor_name": "Acme Corp", "contributor_type": "Business", "transaction_type": "Contribution",
             "contributor_city": "Atlanta", "contributor_state": "GA", "superseded": ""},
            {"state_filer_id": "76", "txn_id": "c2", "date": "2026-02-01", "amount": "5",
             "contributor_name": "Nobody", "contributor_type": "Individual", "transaction_type": "Contribution"},
        ]
        got = ie.ie_contributions("ga", contribs, {"1911"}, mapping.TxnIds("ga"), "2025-01-01", "2026",
                                  individual_types=["individual"])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["ie_filer_ident"], "ga:1911")
        self.assertEqual(got[0]["contributor_type"], "ENTITY")
        self.assertEqual(got[0]["contributor_last_name"], "Acme Corp")
        self.assertEqual(got[0]["source_txn_id"], "ga:c1")
        self.assertNotIn("zip", got[0])


if __name__ == "__main__":
    unittest.main()
