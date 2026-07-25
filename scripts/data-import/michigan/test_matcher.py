#!/usr/bin/env python3
"""Tests for the Michigan matcher's normalization rules.

Run: python3 scripts/data-import/michigan/test_matcher.py

These are the rules that decide whether a legislator is credited with the right
committee, so each case below is a real disagreement between how Michigan
records a name and how Open States does — found while matching the 148 sitting
members, not invented.
"""

import importlib.util
import sys
from datetime import date
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "mi", Path(__file__).with_name("import_mi_legislature.py"))
mi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mi)

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}: got {got!r}, want {want!r}")


# Surnames: Michigan files them as written on the committee registration,
# Open States writes the person's name. Only separators and suffixes differ.
check("suffix Jr.", mi.surname_key("WILSON JR."), mi.surname_key("Wilson"))
check("suffix IV", mi.surname_key("ANDREWS IV"), mi.surname_key("Andrews"))
check("spaced prefix", mi.surname_key("DE BOER"), mi.surname_key("DeBoer"))
check("punctuation", mi.surname_key("St. Germaine"), mi.surname_key("St Germaine"))
check("hyphen", mi.surname_key("JENKINS-ARNO"), "jenkinsarno")
check("empty", mi.surname_key(""), "")
# Different people must stay different — normalization must never merge names.
if mi.surname_key("Carr") == mi.surname_key("Carter"):
    failures.append("distinct surnames collapsed")

# Districts: "32nd District" on filings, "32" on the roster.
check("ordinal", mi.district_number("32nd District"), 32)
check("bare", mi.district_number("5"), 5)
check("blank", mi.district_number(""), None)
check("non-numeric", mi.district_number("At Large"), None)

# Dates decide the cycle, so an unparseable date must be dropped, never
# defaulted into the window.
check("mdy", mi.parse_mdy("03/14/2026"), date(2026, 3, 14))
check("iso", mi.parse_mdy("2026-03-14"), date(2026, 3, 14))
check("junk", mi.parse_mdy("0025"), None)
check("blank date", mi.parse_mdy(""), None)

check("money", mi.parse_money("$1,234.56"), 1234.56)
check("money blank", mi.parse_money(""), 0.0)
check("money junk", mi.parse_money("n/a"), 0.0)

if failures:
    print("FAILED:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("all matcher tests passed")
