import { describe, it, expect } from "vitest";
import { liveStates } from "@/states/registry";
import {
  OFFICE_TO_OS_ROLE,
  chamberLabel,
  formatTermEnd,
  isSamePerson,
  memberLabel,
  officeIsCoveredByOpenStates,
  partyAbbrev,
} from "@/lib/openstates";

describe("open states office mapping", () => {
  it("maps every role the importer knows to a registry-shaped office slug", () => {
    for (const office of Object.keys(OFFICE_TO_OS_ROLE)) {
      expect(office).toMatch(/^[a-z0-9-]+$/);
      expect(officeIsCoveredByOpenStates(office)).toBe(true);
    }
  });

  it("covers the statewide offices Open States tracks, and only those", () => {
    // Open States' executive files stop at the constitutional officers; FL's
    // CFO and Agriculture Commissioner have no record, so those races must
    // report themselves uncovered rather than render an empty incumbent card.
    const liveOffices = new Set(
      liveStates().flatMap((s) => (s.races ?? []).map((r) => r.office)),
    );
    expect(liveOffices.has("governor")).toBe(true);
    for (const office of ["governor", "attorney-general", "secretary-of-state"]) {
      expect(officeIsCoveredByOpenStates(office), office).toBe(true);
    }
    for (const office of ["cfo", "agriculture-commissioner"]) {
      expect(officeIsCoveredByOpenStates(office), office).toBe(false);
    }
  });
});

describe("chamber vocabulary", () => {
  it("uses each state's own name for its lower chamber", () => {
    expect(chamberLabel("mi", "upper")).toBe("Senate");
    expect(chamberLabel("mi", "lower")).toBe("House");
    expect(chamberLabel("ca", "lower")).toBe("Assembly");
    expect(chamberLabel("md", "lower")).toBe("House of Delegates");
  });

  it("titles members to match the chamber", () => {
    expect(memberLabel("ga", "upper")).toBe("Senator");
    expect(memberLabel("ga", "lower")).toBe("Representative");
    expect(memberLabel("va", "lower")).toBe("Delegate");
  });
});

describe("party and term formatting", () => {
  it("abbreviates the party names Open States spells out", () => {
    expect(partyAbbrev("Democratic")).toBe("D");
    expect(partyAbbrev("Republican")).toBe("R");
    expect(partyAbbrev("Independent")).toBe("I");
    expect(partyAbbrev("")).toBeNull();
    expect(partyAbbrev(null)).toBeNull();
  });

  it("formats term end dates and tolerates missing ones", () => {
    expect(formatTermEnd("2027-01-01")).toBe("Term ends Jan 2027");
    expect(formatTermEnd(null)).toBeNull();
    expect(formatTermEnd("not-a-date")).toBeNull();
  });
});

describe("matching officeholders to curated candidates", () => {
  it("links an incumbent to their candidate record", () => {
    expect(isSamePerson("Jocelyn Benson", "Jocelyn Benson")).toBe(true);
    expect(isSamePerson("Garlin Gilchrist II", "Garlin Gilchrist")).toBe(true);
    expect(isSamePerson("Brad Raffensperger", "B. Raffensperger")).toBe(true);
  });

  it("does not collapse different people who share a surname", () => {
    expect(isSamePerson("Chris Carr", "Tanya Carr")).toBe(false);
    expect(isSamePerson("Brian Kemp", "Brian Jones")).toBe(false);
  });
});
