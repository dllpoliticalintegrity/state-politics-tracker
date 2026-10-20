"""Florida: splitting a contributor name into a person's first / last, or
keeping an organisation whole. No network. Run: python3 tests/test_florida.py"""
from _harness import run
from src.pipeline.parsers import florida as parser

parts = parser.contributor_name_parts


def test_people_split_surname_first():
    assert parts("BLOOM JOHN") == ("John", "Bloom")
    assert parts("DELBRIDGE KEVIN") == ("Kevin", "Delbridge")
    assert parts("CROCKER JAMES P.") == ("James P.", "Crocker")


def test_a_suffix_stays_with_the_surname():
    assert parts("MANUEL III CLIFFORD E.") == ("Clifford E.", "Manuel III")
    assert parts("OAKLEY II THOMAS") == ("Thomas", "Oakley II")
    assert parts("SMITH JR JOHN") == ("John", "Smith Jr")


def test_organisations_found_on_2026_10_20_stay_whole():
    # Each was split as a person and ranked among candidates' top individual donors.
    for name, occ in [("FRIENDS OF COREY SIMON", "POLITICAL ORGANIZATION"),
                      ("FRIENDS OF JONATHAN MARTIN", ""),
                      ("ABC MERIT SHOP PC", "POLITICAL ORGANIZATION"),
                      ("BLOSSOM STRATEGIES ORANGE", "FUNDRAISING CONSULTING"),
                      ("UNIVERSAL SPINE AND JOINT SPECIALISTS", "MEDICAL"),
                      ("GRIMES GALVANO PL", "LAW FIRM"),
                      ("OCALA EQUINE HOSPITAL", "VETERINARIAN"),
                      ("SHARP ENERGY", "PROPANE SUPPLIER"),
                      ("SUGAR CANE GROWERS COOPERATIVE", "AGRICULTURE"),
                      ("SALVATORE J. SICUSO, P.A.", "LAW FIRM"),
                      ("616 MEMBERS @ $.75 EACH", "LAW ENFORCEMENT"),
                      ("RUTH'S LIST", "POLITICAL COMMITTEE"),
                      ("GUNSTER", "LAW FIRM")]:
        assert parts(name, occ) == ("", name), name


def test_surnames_that_are_also_organisation_words_stay_people():
    assert parts("LAW HEATHER BEAUCHAMP", "") == ("Heather Beauchamp", "Law")
    assert parts("CHURCH LYNNE", "LANDSCAPE DESIGNER") == ("Lynne", "Church")
    assert parts("HOMES MADELEINE", "") == ("Madeleine", "Homes")


if __name__ == "__main__":
    run(globals())
