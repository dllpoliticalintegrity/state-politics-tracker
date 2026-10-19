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


class Settle(unittest.TestCase):
    def test_only_unsettled_statuses_move(self):
        self.assertEqual(roster.settle("active", "not_on_ballot"), "not_on_ballot")
        self.assertEqual(roster.settle(None, "won_primary"), "won_primary")
        self.assertIsNone(roster.settle("active", "active"))
        self.assertIsNone(roster.settle("won_primary", "not_on_ballot"))   # curated / settled
        self.assertIsNone(roster.settle("withdrawn", "won_primary"))


class BallotStatus(unittest.TestCase):
    def test_only_a_ballot_sourced_race_settles_and_blank_is_not_off_ballot(self):
        self.assertEqual(roster.ballot_status(None, False, False, "Republican"), "active")   # no source
        self.assertEqual(roster.ballot_status(None, None, True, "Republican"), "active")     # blank
        self.assertEqual(roster.ballot_status(None, False, True, "Republican"), "not_on_ballot")
        self.assertEqual(roster.ballot_status(None, True, True, "Democrat"), "won_primary")
        self.assertEqual(roster.ballot_status(None, True, True, "Green"), "nominee")
        self.assertEqual(roster.ballot_status("eliminated", None, True, None), "lost_primary")


class Statewide(unittest.TestCase):
    """Arizona Secretary of State, 2026-10-18: Collier missing, Kolodin's
    committee unlinked, Swoboda off the ballot."""

    def plan(self, live):
        races = [{"race_id": "sos", "office": "secretary-of-state"}]
        participants = [
            {"race_id": "sos", "candidate_id": "f", "candidate_name": "Adrian Fontes", "party": "Democratic",
             "disposition": "Renominated", "on_ballot": True, "source": "greenpapers"},
            {"race_id": "sos", "candidate_id": "k", "candidate_name": "Alex Kolodin", "party": "Republican",
             "disposition": None, "on_ballot": True, "source": "greenpapers"},
            {"race_id": "sos", "candidate_id": "c", "candidate_name": "Duwayne Collier", "party": "Green",
             "disposition": None, "on_ballot": True, "source": "greenpapers"},
            {"race_id": "sos", "candidate_id": "s", "candidate_name": "Gina Swoboda", "party": None,
             "disposition": "Not listed by Green Papers", "on_ballot": False, "source": None},
            {"race_id": "sos", "candidate_id": "g", "candidate_name": "Mark Gordon", "party": None,
             "disposition": "Not listed by Green Papers", "on_ballot": False, "source": None},
        ]
        candidates = [
            {"candidate_id": "f", "candidate_name": "Adrian Fontes", "party": ["Democratic"],
             "state_filer_id": "100622", "committee_name": ["Fontes for AZ"]},
            {"candidate_id": "k", "candidate_name": "Alex Kolodin", "party": ["Republican"],
             "state_filer_id": "100625", "committee_name": ["Alex For Arizona"]},
            {"candidate_id": "c", "candidate_name": "Duwayne Collier", "party": ["Green"],
             "state_filer_id": "102163", "committee_name": ["Duwayne Collier for Secretary of State"]},
            {"candidate_id": "s", "candidate_name": "Gina Swoboda", "party": None,
             "state_filer_id": "102117", "committee_name": ["Gina Swoboda for Arizona Secretary of State"]},
            {"candidate_id": "g", "candidate_name": "Mark Gordon", "party": None,
             "state_filer_id": "201800312", "committee_name": None},
        ]
        resolver = roster.FilerResolver([{"state_filer_id": i} for i in ("100622", "100625", "102163", "102117")])
        return roster.plan_statewide("az", races, participants, candidates, live, resolver)

    def test_arizona_secretary_of_state(self):
        live = [
            {"id": "1", "slug": "adrian-fontes", "name": "Adrian Fontes", "office": "secretary-of-state",
             "party": "Democrat", "status": "active", "filer_refs": ["az:100622"]},
            {"id": "2", "slug": "alexander-kolodin", "name": "Alexander Kolodin", "office": "secretary-of-state",
             "party": "Republican", "status": "active", "filer_refs": []},
            {"id": "3", "slug": "gina-swoboda", "name": "Gina Swoboda", "office": "secretary-of-state",
             "party": "Republican", "status": "active", "filer_refs": ["az:102117"]},
        ]
        inserts, updates, stats = self.plan(live)
        self.assertEqual([r["slug"] for r in inserts], ["duwayne-collier-az"])
        c = inserts[0]
        self.assertEqual((c["party"], c["status"], c["filer_refs"]), ("Green", "nominee", ["az:102163"]))
        patches = {slug: patch for _, patch, slug in updates}
        self.assertEqual(patches["alexander-kolodin"], {"status": "won_primary", "filer_refs": ["az:100625"]})
        self.assertEqual(patches["adrian-fontes"], {"status": "won_primary"})
        self.assertEqual(patches["gina-swoboda"], {"status": "not_on_ballot"})
        self.assertEqual(stats["skipped_off_ballot"], 1)   # Mark Gordon: never added

    def test_surname_match_needs_the_first_initial(self):
        self.assertEqual(roster.name_key("Alex Kolodin"), roster.name_key("Alexander Kolodin"))
        self.assertNotEqual(roster.name_key("Rick Jackson"), roster.name_key("Olu Jackson"))

    def test_a_namesake_with_another_first_name_is_held_for_review(self):
        live = [{"id": "7", "slug": "duwayne-x", "name": "Bob Collier", "office": "secretary-of-state",
                 "party": None, "status": "active", "filer_refs": []}]
        inserts, updates, stats = self.plan(live)
        self.assertNotIn("duwayne-collier-az", [r["slug"] for r in inserts])
        self.assertEqual(stats["possible_duplicate"], 1)

    def test_curated_status_and_claimed_refs_are_left_alone(self):
        live = [
            {"id": "3", "slug": "gina-swoboda", "name": "Gina Swoboda", "office": "secretary-of-state",
             "party": "Republican", "status": "nominee", "filer_refs": ["az:102117"]},
            # Another office's candidate already holds Collier's committee id.
            {"id": "9", "slug": "someone-else", "name": "Someone Else", "office": "attorney-general",
             "party": None, "status": "nominee", "filer_refs": ["az:102163"]},
        ]
        inserts, updates, stats = self.plan(live)
        self.assertNotIn("gina-swoboda", {slug for _, _, slug in updates})
        collier = next(r for r in inserts if r["slug"] == "duwayne-collier-az")
        self.assertEqual(collier["filer_refs"], [])        # 102163 already held
        self.assertGreaterEqual(stats["ref_conflict"], 1)


class StatewideExtraOffices(unittest.TestCase):
    """lpt_statewide: an office with no cf_candidates rows yet is fetched and
    seeded (Iowa's row offices, 2026-10-18); legislative names are ignored."""

    def setUp(self):
        self.asked = []
        self._get_all, self._fetch = roster.rest.get_all, roster.fetch_lpt_statewide
        roster.rest.get_all = lambda path: [
            {"id": "1", "slug": "rob-sand", "name": "Rob Sand", "office": "governor",
             "party": "Democrat", "status": "active", "filer_refs": ["ia:5185"]}]

        def fetch(st, offices):
            self.asked.append(set(offices))
            races = [{"race_id": "ag", "office": "attorney-general"}]
            participants = [
                {"race_id": "ag", "candidate_id": "b", "candidate_name": "BIRD, BRENNA", "party": "Republican",
                 "disposition": "Renominated", "on_ballot": True, "source": "greenpapers"}]
            candidates = [{"candidate_id": "b", "candidate_name": "BIRD, BRENNA", "party": ["Republican"],
                           "state_filer_id": "5206", "committee_name": ["Bird for Iowa"]}]
            return races, participants, candidates
        roster.fetch_lpt_statewide = fetch

    def tearDown(self):
        roster.rest.get_all, roster.fetch_lpt_statewide = self._get_all, self._fetch

    def test_new_office_is_seeded(self):
        resolver = roster.FilerResolver([{"state_filer_id": "5206"}])
        stats = roster.sync_statewide("ia", resolver, dry_run=True, log=lambda *_: None,
                                      extra_offices=["attorney-general", "state-senate"])
        self.assertEqual(self.asked, [{"governor", "attorney-general"}])
        self.assertEqual(stats["insert"], 1)

    def test_without_extra_offices_only_existing_ones(self):
        roster.sync_statewide("ia", roster.FilerResolver([]), dry_run=True, log=lambda *_: None)
        self.assertEqual(self.asked, [{"governor"}])


class StatewideRaces2026(unittest.TestCase):
    """The down-ballot statewide races added 2026-10-18 (AZ, GA, TX, WI)."""

    def test_credentials_leave_the_name(self):
        self.assertEqual(roster.display_name("DAWN C. BUCKINGHAM MD"), "Dawn C. Buckingham")
        self.assertEqual(roster.name_slug(roster.display_name("BUCKINGHAM, DAWN MD")), "dawn-buckingham")
        self.assertEqual(roster.display_name("SMITH, JOHN, PH.D."), "John Smith")
        self.assertEqual(roster.display_name("Mary Esq Jones"), "Mary Esq Jones")   # only trailing

    def test_lpt_office_is_renamed_both_ways(self):
        asked = []
        orig = roster.lpt_get
        def fake(path, page=1000):
            asked.append(path)
            return [{"race_id": "r1", "office": "ga-comptroller-general-insurance-commissioner"}] if path.startswith("races") else []
        roster.lpt_get = fake
        try:
            races, _, _ = roster.fetch_lpt_statewide("ga", ["insurance-commissioner"])
        finally:
            roster.lpt_get = orig
        self.assertIn("office=in.(ga-comptroller-general-insurance-commissioner)", asked[0])
        self.assertEqual(races[0]["office"], "insurance-commissioner")

    def _commission(self, unconfirmed):
        races = [{"race_id": "cc", "office": "corporation-commissioner"}]
        participants = [{"race_id": "cc", "candidate_id": "m", "candidate_name": "Nick Myers", "party": "Republican",
                         "disposition": None, "on_ballot": None, "source": None}]
        candidates = [{"candidate_id": "m", "candidate_name": "Nick Myers", "party": ["Republican"],
                       "state_filer_id": "100484", "committee_name": ["Myers for AZ"]}]
        return roster.plan_statewide("az", races, participants, candidates, [],
                                     roster.FilerResolver([{"state_filer_id": "100484"}]),
                                     unconfirmed_offices=unconfirmed)

    def test_a_race_with_no_ballot_list_adds_nobody_unless_opted_in(self):
        inserts, _, stats = self._commission(())
        self.assertEqual(inserts, [])
        inserts, _, stats = self._commission(["corporation-commissioner"])
        self.assertEqual([(r["slug"], r["status"]) for r in inserts], [("nick-myers-az", "active")])
        self.assertEqual(stats["unconfirmed_added"], 1)

    def test_texas_statewide_rows_carry_the_tec_office(self):
        races = [{"race_id": "c", "office": "comptroller"}]
        participants = [
            {"race_id": "c", "candidate_id": "h", "candidate_name": "DONALD HUFFINES", "party": "Republican",
             "disposition": "Won primary", "on_ballot": True, "source": "greenpapers"},
            {"race_id": "c", "candidate_id": "k", "candidate_name": "KELLY HANCOCK", "party": "Republican",
             "disposition": "Lost primary", "on_ballot": False, "source": "greenpapers"},
            {"race_id": "c", "candidate_id": "e", "candidate_name": "SARAH ECKHARDT", "party": "Democrat",
             "disposition": None, "on_ballot": True, "source": "greenpapers"}]
        candidates = [{"candidate_id": "h", "candidate_name": "DONALD HUFFINES", "state_filer_id": "00069651"},
                      {"candidate_id": "k", "candidate_name": "KELLY HANCOCK", "state_filer_id": "00067555"},
                      {"candidate_id": "e", "candidate_name": "SARAH ECKHARDT", "state_filer_id": "00084783"}]
        # Eckhardt's TEC account already belongs to another tx_candidates row.
        live = [{"id": "1", "slug": "sarah-eckhardt-tx-sd14", "name": "Sarah Eckhardt", "office": "STATESEN",
                 "filer_ident": "84783"}]
        rows, stats = roster.plan_texas_statewide(races, participants, candidates, live)
        self.assertEqual([(r["slug"], r["office"], r["filer_ident"]) for r in rows],
                         [("donald-huffines-tx", "COMPTROLLER", "69651")])
        self.assertEqual(stats["skipped_off_ballot"], 1)
        self.assertEqual(stats["skipped_no_or_dup_ident"], 1)


if __name__ == "__main__":
    unittest.main()
