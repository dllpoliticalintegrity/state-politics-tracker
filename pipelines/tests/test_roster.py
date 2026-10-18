"""Offline tests for the LPT legislative roster sync (pipelines/load/roster.py).

    python3 -m unittest pipelines.tests.test_roster
"""

import sys
import unittest
from pathlib import Path

PIPELINES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PIPELINES / "load"))

import roster  # noqa: E402


class Names(unittest.TestCase):
    def test_display_name(self):
        self.assertEqual(roster.display_name("BOTTOMS, KEISHA L."), "Keisha L. Bottoms")
        self.assertEqual(roster.display_name("JAMES MCDONALD"), "James McDonald")
        self.assertEqual(roster.display_name("Katie Hobbs"), "Katie Hobbs")
        self.assertEqual(roster.display_name("  "), "")

    def test_name_slug(self):
        self.assertEqual(roster.name_slug("Keisha L. Bottoms"), "keisha-bottoms")
        self.assertEqual(roster.name_slug("Löki Tobin"), "loki-tobin")
        self.assertEqual(roster.name_slug("John Sikes Jr."), "john-sikes")

    def test_party_and_status(self):
        self.assertEqual(roster.party(["DEMOCRAT", "WORKING FAMILIES"]), "Democrat")
        self.assertEqual(roster.party("Republican Party"), "Republican")
        self.assertEqual(roster.party("NONPARTISAN"), "Independent")
        self.assertIsNone(roster.party(None))
        self.assertEqual(roster.status("lost_primary", False), "lost_primary")
        self.assertEqual(roster.status("eliminated", False), "lost_primary")
        self.assertEqual(roster.status("Not listed by Green Papers", False), "not_on_ballot")
        self.assertEqual(roster.status(None, True), "active")


class Resolution(unittest.TestCase):
    def setUp(self):
        scrape = [
            {"state_filer_id": "101067", "committee_name": "GEORGIA FOR JASON, INC."},
            {"state_filer_id": "0016178", "committee_name": "RAMASWAMY FOR OHIO"},
            {"state_filer_id": "Margaret E. Bellamy", "committee_name": "MARGARET E. BELLAMY"},
            {"state_filer_id": "", "committee_name": "NOBODY"},
        ]
        committees = [{"state_filer_id": "1055", "committee_name": "Georgia for Jason, Inc."}]
        self.r = roster.FilerResolver(scrape, committees)

    def test_same_id_ignoring_leading_zeros(self):
        self.assertEqual(self.r.resolve("16178"), "0016178")

    def test_other_id_system_bridged_by_committee_name(self):
        # Georgia: LPT's registration number -> committees.csv name -> the transactions' id
        self.assertEqual(self.r.resolve("1055"), "101067")

    def test_committee_name_and_candidate_name(self):
        self.assertEqual(self.r.resolve("x", ["Georgia for Jason Inc"]), "101067")
        self.assertEqual(self.r.resolve(None, [], "BELLAMY, MARGARET E."), "Margaret E. Bellamy")
        self.assertIsNone(self.r.resolve("999", ["Unknown Committee"], "Nobody Here"))


class Conflicts(unittest.TestCase):
    def test_lumped_scrape_id_is_refused(self):
        r = roster.FilerResolver([
            {"state_filer_id": "Bauer", "committee_name": "PETER BAUER"},
            {"state_filer_id": "Bauer", "committee_name": "PAUL A BAUER JR"},
        ])
        self.assertIsNone(r.resolve("Bauer"))
        self.assertEqual(r.how, "ambiguous")

    def test_shared_and_claimed_refs_are_dropped(self):
        rows = [{"slug": "william-harris-ga-hd126", "filer_refs": ["ga:100918"]},
                {"slug": "william-harris-ga-hd82", "filer_refs": ["ga:100918"]},
                {"slug": "new-one-ga-sd1", "filer_refs": ["ga:103524"]},
                {"slug": "clean-ga-sd2", "filer_refs": ["ga:5"]}]
        stats, logs = {}, []
        roster.drop_conflicting_refs(rows, {"ga:103524": "rick-jackson"}, stats, logs.append)
        self.assertEqual([r["filer_refs"] for r in rows], [[], [], [], ["ga:5"]])
        self.assertEqual(stats["ref_conflict"], 3)
        self.assertTrue(any("held by rick-jackson" in l for l in logs))


class Texas(unittest.TestCase):
    def test_ident_resolver(self):
        r = roster.IdentResolver()
        self.assertEqual(r.resolve("00019652"), "19652")
        self.assertIsNone(r.resolve("openstates:ocd-person/x"))
        self.assertIsNone(r.resolve(None))


class Build(unittest.TestCase):
    def test_build_roster(self):
        races = [{"race_id": "r1", "office": "state-senate", "office_num": 11},
                 {"race_id": "r2", "office": "state-representative", "office_num": 3},
                 {"race_id": "r3", "office": "state-senate", "office_num": None}]
        participants = [
            {"race_id": "r1", "candidate_id": "c1", "candidate_name": "x", "party": "DEMOCRAT",
             "disposition": None, "on_ballot": True},
            {"race_id": "r1", "candidate_id": "c1", "candidate_name": "x", "party": "DEMOCRAT",
             "disposition": None, "on_ballot": True},                      # listed twice
            {"race_id": "r2", "candidate_id": "c2", "candidate_name": "SMITH, ANN",
             "party": None, "disposition": "lost_primary", "on_ballot": False},
            {"race_id": "r3", "candidate_id": "c3", "candidate_name": "Skip Me", "party": None,
             "disposition": None, "on_ballot": True},
        ]
        candidates = [
            {"candidate_id": "c1", "candidate_name": "WIELECHOWSKI, WILLIAM", "party": ["DEMOCRAT"],
             "state_filer_id": "77", "committee_name": ["Bill for Senate"]},
            {"candidate_id": "c2", "candidate_name": "SMITH, ANN", "party": ["REPUBLICAN"],
             "state_filer_id": None, "committee_name": None},
        ]
        resolver = roster.FilerResolver([{"state_filer_id": "77", "committee_name": "BILL FOR SENATE"}])
        rows, stats = roster.build_roster("ak", races, participants, candidates, resolver)
        by_slug = {r["slug"]: r for r in rows}
        self.assertEqual(set(by_slug), {"william-wielechowski-ak-sd11", "ann-smith-ak-hd3"})
        w = by_slug["william-wielechowski-ak-sd11"]
        self.assertEqual((w["office"], w["district"], w["party"], w["status"]), ("state-senate", "11", "Democrat", "active"))
        self.assertEqual(w["filer_refs"], ["ak:77"])
        self.assertEqual(w["committee_name"], "Bill for Senate")
        a = by_slug["ann-smith-ak-hd3"]
        self.assertEqual((a["office"], a["party"], a["status"], a["filer_refs"]), ("state-house", "Republican", "lost_primary", []))
        self.assertEqual(stats["resolved"], 2)   # c1 counted per listing
        self.assertEqual(stats["unresolved"], 1)


if __name__ == "__main__":
    unittest.main()
