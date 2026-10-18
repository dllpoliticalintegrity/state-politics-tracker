"""Texas: which cover-sheet election dates are believable enough to decide a
filer's election year. No network. Run: python3 tests/test_texas.py"""
from _harness import run
from src.pipeline.parsers.texas import plausible_election_date as plausible


def test_typoed_odd_year_primary_is_ignored():
    # Trent Ashby's July 2025 report named a March 2027 primary; Texas
    # primaries are only in even years. Kept, it moved him out of 2026.
    assert plausible("2027-03-02", "2025-07-15", "PRIMARY") == ""


def test_even_year_primary_is_kept():
    assert plausible("2026-03-03", "2025-07-15", "PRIMARY") == "2026-03-03"


def test_odd_year_general_is_kept():
    # November elections in odd years are real (local offices, amendments).
    assert plausible("2025-11-04", "2025-07-14", "GENERAL") == "2025-11-04"


def test_date_far_after_filing_is_ignored():
    # a 2036 general on a report filed in 2026
    assert plausible("2036-11-03", "2026-07-15", "GENERAL") == ""


def test_senator_naming_primary_two_years_out_is_kept():
    # a sitting senator's January 2026 semiannual names the March 2028 primary
    assert plausible("2028-03-07", "2026-01-15", "PRIMARY") == "2028-03-07"


def test_blank_dates():
    assert plausible("", "2026-01-15", "PRIMARY") == ""
    assert plausible("2026-11-03", "", "GENERAL") == "2026-11-03"


if __name__ == "__main__":
    raise SystemExit(run(globals()))
