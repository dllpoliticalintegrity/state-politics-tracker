import { describe, expect, it } from "vitest";
import { partyColor, partyKey, partyLabel } from "@/lib/finance";
import { comparisonDefaults, comparisonTextClass, overviewOrder } from "@/lib/headToHead";
import { partyBucket, PARTY_SLICE_COLOR } from "@/lib/raceSummary";
import { leadClass } from "@/components/DistrictMap";

describe("Green Party", () => {
  it("maps every spelling of Green, and the money river's code", () => {
    for (const p of ["Green", "GREEN", "green", "Green Party", "Florida Green Party",
                     "Green Party of Arizona", "Arizona Greens", " Green ", "G"]) {
      expect(partyKey(p)).toBe("G");
      expect(partyLabel(p)).toBe("Green");
      expect(partyColor(p)).toBe("hsl(var(--grn))");
      expect(partyBucket(p)).toBe("Green");
    }
  });

  it("leaves names that only start with G, or merely contain the letters, alone", () => {
    expect(partyKey("GOP")).toBe("");
    expect(partyKey("Greenback")).toBe("");
    expect(partyKey("Evergreen Coalition")).toBe("");
    expect(partyBucket("Greenback")).toBe("Other");
  });

  it("reads a state-prefixed party name as its party", () => {
    expect(partyLabel("Florida Democratic Party")).toBe("Democrat");
    expect(partyColor("Florida Democratic Party")).toBe("hsl(var(--dem))");
    expect(partyBucket("Florida Democratic Party")).toBe("Democrat");
    expect(partyLabel("Republican Party of Florida")).toBe("Republican");
    expect(partyBucket("Republican Party of Florida")).toBe("Republican");
    expect(partyLabel("Arizona Republican Party")).toBe("Republican");
    // Still third parties:
    expect(partyLabel("American Solidarity Party Of Florida")).toBe("Other");
    expect(partyLabel("Constitution Party Of Florida")).toBe("Other");
    expect(partyLabel("No Labels Party")).toBe("Other");
    expect(partyLabel("Write-In")).toBe("Other");
  });

  it("does not change the other parties", () => {
    expect(partyLabel("Democrat")).toBe("Democrat");
    expect(partyLabel("Democratic")).toBe("Democrat");
    expect(partyLabel("D")).toBe("Democrat");
    expect(partyLabel("Republican")).toBe("Republican");
    expect(partyLabel("REP")).toBe("Republican");
    expect(partyLabel("Independent")).toBe("Independent");
    expect(partyLabel("I")).toBe("Independent");
    expect(partyLabel("Libertarian")).toBe("Other");
    expect(partyLabel(null)).toBe("Other");
    expect(partyLabel("")).toBe("Other");
    expect(partyColor("Libertarian")).toBe("hsl(var(--muted-foreground))");
  });

  it("colours Green in the head-to-head and the party donut", () => {
    expect(comparisonTextClass("Green")).toBe("text-grn");
    expect(comparisonTextClass("Libertarian")).toBe("text-muted-foreground");
    expect(PARTY_SLICE_COLOR.Green).toBe("hsl(var(--grn))");
  });

  it("keeps Green a third party for the pairings", () => {
    // Arizona Secretary of State: the Green nominee has more money than the
    // Republican, but the unpolled pair is still the two major-party nominees.
    const cands = [
      { id: "f", slug: "f", name: "Fontes", party: "Democrat", status: "won_primary", raised: 2_650_000 },
      { id: "c", slug: "c", name: "Collier", party: "Green", status: "nominee", raised: 739_000 },
      { id: "k", slug: "k", name: "Kolodin", party: "Republican", status: "won_primary", raised: 400_000 },
    ];
    expect(comparisonDefaults(cands, (c) => c.raised, () => null).map((c) => c.id)).toEqual(["f", "k"]);
    const rows = cands.map((c) => ({ c, raised: c.raised, pct: null }));
    expect(overviewOrder(rows, false).map((r) => r.c.id)).toEqual(["f", "k", "c"]);
  });
});

describe("district map shading", () => {
  const row = (party: string) => ({ cands: [{ party }] }) as unknown as Parameters<typeof leadClass>[0];
  const raised = () => 100;
  it("shades a state-prefixed Democrat blue and a Green as another party", () => {
    expect(leadClass(row("Florida Democratic Party"), raised)).toBe("dem");
    expect(leadClass(row("Democrat"), raised)).toBe("dem");
    expect(leadClass(row("Republican"), raised)).toBe("rep");
    expect(leadClass(row("Green"), raised)).toBe("other");
    expect(leadClass(row("Libertarian"), raised)).toBe("other");
  });
});
