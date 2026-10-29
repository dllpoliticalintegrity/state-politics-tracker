import { describe, it, expect } from "vitest";
import {
  cellLabelLines,
  donorKindClass,
  donorPartyKey,
  fitLabel,
  givesOwnMoney,
  isOwnMoney,
  pieSlices,
  recipientParty,
  sliceColor,
  treemapCells,
  vizColor,
} from "@/lib/donorCharts";

const donor = (key: string, amount: number, type: string | null = "INDIVIDUAL") => ({
  key,
  display_name: key.toUpperCase(),
  contributor_type: type,
  contribution_count: 1,
  total_amount: amount,
});

describe("pie slices", () => {
  it("keeps the top six and folds the rest into Other, with shares of the whole", () => {
    const donors = Array.from({ length: 10 }, (_, i) => donor(`d${i}`, 100 - i * 5));
    const slices = pieSlices(donors);
    expect(slices).toHaveLength(7);
    expect(slices.slice(0, 6).map((s) => s.series)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(slices[0].party).toBe("");
    const other = slices[6];
    expect(other.key).toBe("__other");
    expect(other.name).toBe("Other (4 donors)");
    expect(other.series).toBeNull();
    expect(other.donors).toBe(4);
    expect(other.amount).toBe(70 + 65 + 60 + 55);
    expect(slices.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(1);
  });

  it("folds even one extra donor, so no slice goes without a colour slot", () => {
    const slices = pieSlices(Array.from({ length: 7 }, (_, i) => donor(`d${i}`, 10 + i)));
    expect(slices).toHaveLength(7);
    expect(slices[6]).toMatchObject({ key: "__other", name: "Other (1 donor)", series: null, amount: 10 });
    expect(pieSlices(Array.from({ length: 6 }, (_, i) => donor(`d${i}`, 10 + i))).every((s) => s.series !== null)).toBe(true);
  });

  it("drops zero-dollar donors and is empty with nothing charted", () => {
    expect(pieSlices([donor("a", 0)])).toEqual([]);
    expect(pieSlices([donor("a", 0), donor("b", 5)]).map((s) => s.key)).toEqual(["b"]);
  });
});

describe("treemap cells", () => {
  it("ranks by amount, caps at the limit and classes each donor by the party they gave to", () => {
    const cells = treemapCells(
      [
        { ...donor("small", 1), party: "D" },
        { ...donor("pac", 50, "ENTITY"), party: "mixed" },
        { ...donor("big", 100), party: "R" },
        { ...donor("rga", 30, "ENTITY"), display_name: "REPUBLICAN GOVERNORS ASSOCIATION" },
        donor("none", 20, null),
      ],
      4,
    );
    expect(cells.map((c) => c.key)).toEqual(["big", "pac", "rga", "none"]);
    expect(cells.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
    expect(cells.map((c) => c.kind)).toEqual(["republican", "both", "republican", "unknown"]);
    expect(cells.map((c) => c.typeLabel)).toEqual(["Individual", "Entity / PAC", "Entity / PAC", "Unknown"]);
    expect(cells[0].value).toBe(100);
  });

  it("designates a donor's party the way the site designates a candidate's", () => {
    const partyOf = (id: string) => ({ a: "Republican", b: "Democrat", c: "R", d: null as string | null })[id];
    expect(recipientParty([{ candidate_id: "a", total_amount: 10 }], partyOf)).toBe("R");
    expect(recipientParty([{ candidate_id: "a", total_amount: 10 }, { candidate_id: "c", total_amount: 5 }], partyOf)).toBe("R");
    expect(recipientParty([{ candidate_id: "a", total_amount: 10 }, { candidate_id: "b", total_amount: 5 }], partyOf)).toBe("mixed");
    // A refund-only split carries no party; an unknown party carries none.
    expect(recipientParty([{ candidate_id: "a", total_amount: 10 }, { candidate_id: "b", total_amount: 0 }], partyOf)).toBe("R");
    expect(recipientParty([{ candidate_id: "d", total_amount: 10 }], partyOf)).toBe("");
    expect(recipientParty([], partyOf)).toBe("");
    expect(donorKindClass("D")).toBe("democratic");
    expect(donorKindClass("I")).toBe("other_party");
    expect(donorKindClass("")).toBe("unknown");
  });

  it("falls back to the organisation's name when no recipient is known", () => {
    expect(donorPartyKey("Democratic Governors Association")).toBe("D");
    expect(donorPartyKey("HOUSE REPUBLICAN CAMPAIGN COMMITTEE")).toBe("R");
    expect(donorPartyKey("Democrats for Republican Values")).toBe("");
    expect(donorPartyKey("Independent Bankers PAC")).toBe("");
    expect(donorPartyKey("Republican Smith", "INDIVIDUAL")).toBe("");
  });

  it("colours slices by party, stepping shades within a party", () => {
    expect(sliceColor({ series: 2, party: "R", partyNth: 0 })).toBe("hsl(var(--rep))");
    expect(sliceColor({ series: 2, party: "R", partyNth: 1 })).toContain("color-mix");
    // Six distinct steps; beyond that the last repeats.
    const shades = [0, 1, 2, 3, 4, 5].map((n) => sliceColor({ series: 0, party: "R", partyNth: n }));
    expect(new Set(shades).size).toBe(6);
    expect(sliceColor({ series: 0, party: "R", partyNth: 9 })).toBe(shades[5]);
    expect(sliceColor({ series: 2, party: "mixed", partyNth: 0 })).toBe("var(--viz-3)");
    expect(sliceColor({ series: 2, party: "", partyNth: 0 })).toBe("var(--viz-3)");
    const slices = pieSlices([
      { ...donor("a", 50), party: "R" },
      { ...donor("b", 40), party: "R" },
      { ...donor("c", 30), party: "D" },
    ]);
    expect(slices.map((s) => [s.party, s.partyNth])).toEqual([["R", 0], ["R", 1], ["D", 0]]);
  });

  it("labels only cells that can hold text", () => {
    expect(cellLabelLines(20, 20)).toBe(0);
    expect(cellLabelLines(50, 20)).toBe(1);
    expect(cellLabelLines(80, 40)).toBe(2);
    expect(fitLabel("JOHN SMITH", 100)).toBe("JOHN SMITH");
    expect(fitLabel("A VERY LONG COMMITTEE NAME", 66)).toBe("A VERY…");
    expect(fitLabel("ABCDEFG", 30)).toBe("");
  });
});

describe("colours", () => {
  it("cycles the six slots and uses the neutral for null", () => {
    expect(vizColor(0)).toBe("var(--viz-1)");
    expect(vizColor(5)).toBe("var(--viz-6)");
    expect(vizColor(6)).toBe("var(--viz-1)");
    expect(vizColor(null)).toBe("var(--viz-neutral)");
  });
});

describe("own money", () => {
  const ind = (name: string) => ({ display_name: name, contributor_type: "INDIVIDUAL" });
  const org = (name: string) => ({ display_name: name, contributor_type: "ENTITY" });

  it("mirrors the database's self-funding rule for individuals", () => {
    expect(isOwnMoney(ind("MICHAEL COX"), "Mike Cox")).toBe(true);
    expect(isOwnMoney(ind("Mike Cox Jr."), "Mike Cox")).toBe(true);
    expect(isOwnMoney(ind("LAURA COX"), "Mike Cox")).toBe(false);
    expect(isOwnMoney(ind("COX"), "Mike Cox")).toBe(false);
    expect(isOwnMoney(ind("MICHAEL COXWELL"), "Mike Cox")).toBe(false);
    expect(isOwnMoney(ind("MICHAEL COX"), null)).toBe(false);
    expect(isOwnMoney({ display_name: "MICHAEL COX", contributor_type: null }, "Mike Cox")).toBe(false);
  });

  it("reads an organisation named for the candidate as their own money", () => {
    expect(isOwnMoney(org("Jesse Gabriel for Assembly 2024"), "Jesse Gabriel")).toBe(true);
    expect(isOwnMoney(org("FRIENDS OF MIKE COX"), "Mike Cox")).toBe(true);
    expect(isOwnMoney(org("COX MAJORITY PAC"), "Mike Cox")).toBe(false);
    expect(isOwnMoney(org("Cox Communications"), "Mike Cox")).toBe(false);
    expect(isOwnMoney(org("Elect Nobody PAC"), "A Li")).toBe(false);
  });

  it("flags a donor whose gifts include their own campaign", () => {
    const nameOf = (id: string) => ({ cox: "Mike Cox", benson: "Jocelyn Benson" })[id];
    expect(
      givesOwnMoney({ ...ind("MICHAEL COX"), splits: [{ candidate_id: "cox", total_amount: 100 }] }, nameOf),
    ).toBe(true);
    expect(
      givesOwnMoney({ ...ind("MICHAEL COX"), splits: [{ candidate_id: "benson", total_amount: 100 }] }, nameOf),
    ).toBe(false);
    expect(
      givesOwnMoney({ ...ind("MICHAEL COX"), splits: [{ candidate_id: "cox", total_amount: 0 }] }, nameOf),
    ).toBe(false);
  });
});
