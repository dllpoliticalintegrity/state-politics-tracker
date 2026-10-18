"""Offline tests for the California legislative seed (pipelines/load/roster_ca.py)."""

import sys
import unittest
from pathlib import Path

PIPELINES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINES / "load"))

import roster_ca  # noqa: E402


class Helpers(unittest.TestCase):
    def test_split_and_keys(self):
        self.assertEqual(roster_ca.split_display("Cecilia M. Aguiar-Curry"), ("Cecilia M.", "Aguiar-Curry"))
        self.assertEqual(roster_ca.name_key("Cecilia M.", "Aguiar-Curry"), ("AGUIARCURRY", "CECILIA"))
        self.assertEqual(roster_ca._date_key("1/22/2025 12:00:00 AM"), (2025, 1, 22))

    def test_match_committee_prefers_exact_then_initial_then_latest(self):
        idx = {("ASM", 4): [("AGUIARCURRY", "CECILIA", (2025, 1, 16), 111),
                            ("AGUIARCURRY", "CECILIA", (2026, 7, 31), 222),
                            ("SMITH", "JOHN", (2026, 1, 1), 333)],
               ("SEN", 2): [("CONNOLLY", "D", (2026, 3, 1), 444)]}
        self.assertEqual(roster_ca.match_committee(idx, "state-house", 4, "Cecilia", "Aguiar-Curry"), 222)
        self.assertEqual(roster_ca.match_committee(idx, "state-senate", 2, "Damon", "Connolly"), 444)
        self.assertIsNone(roster_ca.match_committee(idx, "state-house", 4, "Jane", "Doe"))
        self.assertIsNone(roster_ca.match_committee(idx, "state-house", 5, "Cecilia", "Aguiar-Curry"))

    def test_build_rows(self):
        cert = [{"office": "state-senate", "district": 2, "name": "Damon Connolly", "party": "Democrat", "incumbent": False},
                {"office": "state-house", "district": 1, "name": "Heather Hadwick", "party": "Republican", "incumbent": True}]
        comm = {("SEN", 2): [("CONNOLLY", "DAMON", (2026, 3, 1), 1479878)]}
        cand = {("CONNOLLY", "DAMON"): 1275505}
        rows, stats = roster_ca.build(cert, comm, cand)
        a, b = rows
        self.assertEqual(a["row"]["slug"], "damon-connolly-ca-sd2")
        self.assertEqual(a["row"]["filer_refs"], ["ca:1479878"])
        self.assertEqual((a["candidate_filer_id"], a["committee_filer_id"]), (1275505, 1479878))
        self.assertEqual(b["row"]["slug"], "heather-hadwick-ca-hd1")
        self.assertEqual(b["row"]["title"], "Incumbent")
        self.assertEqual(b["row"]["filer_refs"], [])
        self.assertEqual(stats, {"committee": 1, "no_committee": 1, "candidate_id": 1, "no_candidate_id": 1})


if __name__ == "__main__":
    unittest.main()
