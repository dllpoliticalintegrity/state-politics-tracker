"""Alaska: the plain-HTTP grid export covers the independent-expenditure
pages too. No network. Run: python3 tests/test_alaska.py"""
from _harness import run
from src.pipeline.scrapers import alaska as scraper


def test_ie_pages_use_their_own_path_and_the_parsers_file_names():
    assert scraper.grid_url("ie_expenditures") == \
        "https://aws.state.ak.us/ApocReports/IndependentExpenditures/IEExpenditures.aspx"
    assert scraper.grid_url("income") == \
        "https://aws.state.ak.us/ApocReports/CampaignDisclosure/CDIncome.aspx"
    # parsers/alaska.py reads IEExpenditures_*.csv / IEContributions_*.csv.
    assert scraper.grid_filename("ie_expenditures", "2026") == "IEExpenditures_2026.csv"
    assert scraper.grid_filename("ie_contributions", "2025") == "IEContributions_2025.csv"
    assert scraper.grid_filename("income", "2026") == "grid_CDIncome_2026.csv"


def test_the_search_form_fits_both_page_layouts():
    html = '<input id="__VIEWSTATE" value="v"/><input id="__VIEWSTATEGENERATOR" value="g"/>'
    # CampaignDisclosure pages: "M$C$<x>$csfFilter$..."; the IE pages: "M$C$csfFilter$...".
    cd = scraper._grid_form(html, "M$C$sf$", "IncomeTypes", "2026", "btnSearch", "Search")
    assert cd["M$C$sf$csfFilter$ddlNameType"] == "CandidateName"
    ie = scraper._grid_form(html, "M$C$", "IEFilerTypes", "2026", "btnSearch", "Search", "Any")
    assert ie["M$C$csfFilter$ddlNameType"] == "Any"
    assert ie["M$C$csfFilter$ddlReportYear"] == "2026"


if __name__ == "__main__":
    run(globals())
