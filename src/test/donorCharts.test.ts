import { describe, it, expect } from "vitest";
import {
  cellLabelLines,
  donorKindClass,
  donorPartyKey,
  fitLabel,
  pieSlices,
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
  it("ranks by amount, caps at the limit and classes each donor", () => {
    const cells = treemapCells(
      [donor("small", 1), donor("pac", 50, "ENTITY"), donor("big", 100), donor("none", 20, null)],
      3,
    );
    expect(cells.map((c) => c.key)).toEqual(["big", "pac", "none"]);
    expect(cells.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(cells.map((c) => c.kind)).toEqual(["individual", "entity", "unknown"]);
    expect(cells[0].value).toBe(100);
  });

  it("classes contributor types, parties first", () => {
    expect(donorKindClass("individual")).toBe("individual");
    expect(donorKindClass("ENTITY")).toBe("entity");
    expect(donorKindClass("PAC")).toBe("entity");
    expect(donorKindClass(null)).toBe("unknown");
    expect(donorKindClass("ENTITY", "REPUBLICAN GOVERNORS ASSOCIATION")).toBe("republican");
    expect(donorKindClass("ENTITY", "Democratic Party of Oregon")).toBe("democratic");
    expect(donorKindClass("ENTITY", "MICHIGAN GOP")).toBe("republican");
    // A person is never a party, whatever their name says.
    expect(donorKindClass("INDIVIDUAL", "GOP SMITH")).toBe("individual");
  });

  it("reads a donor's party from its name", () => {
    expect(donorPartyKey("Democratic Governors Association")).toBe("D");
    expect(donorPartyKey("HOUSE REPUBLICAN CAMPAIGN COMMITTEE")).toBe("R");
    expect(donorPartyKey("Democrats for Republican Values")).toBe("");
    expect(donorPartyKey("Independent Bankers PAC")).toBe("");
    expect(donorPartyKey("Republican Smith", "INDIVIDUAL")).toBe("");
    expect(sliceColor({ series: 2, party: "R" })).toBe("hsl(var(--rep))");
    expect(sliceColor({ series: 2, party: "" })).toBe("var(--viz-3)");
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
