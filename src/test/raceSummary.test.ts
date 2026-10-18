import { describe, it, expect } from "vitest";
import { fundingSlices, partyBucket, partySlices, runningCounts } from "@/lib/raceSummary";

describe("race summary", () => {
  it("sums funding categories for the race's candidates only, in display order", () => {
    const rows = [
      { candidate_id: "a", category: "individuals", amount: 60 },
      { candidate_id: "a", category: "pac", amount: "30" },
      { candidate_id: "b", category: "self", amount: 10 },
      { candidate_id: "z", category: "party", amount: 999 },
    ];
    const s = fundingSlices(rows, new Set(["a", "b"]));
    expect(s.map((x) => x.key)).toEqual(["individuals", "self", "pac"]);
    expect(s.map((x) => x.amount)).toEqual([60, 10, 30]);
    expect(s[0].pct).toBeCloseTo(60);
    // A category with money appears; an empty optional one doesn't.
    expect(fundingSlices([{ candidate_id: "a", category: "public", amount: 5 }], new Set(["a"])).map((x) => x.key))
      .toContain("public");
  });

  it("folds party labels", () => {
    expect(partyBucket("D")).toBe("Democrat");
    expect(partyBucket("Democratic")).toBe("Democrat");
    expect(partyBucket("REP")).toBe("Republican");
    expect(partyBucket("Libertarian")).toBe("Libertarian");
    expect(partyBucket("No Party Preference")).toBe("Independent");
    expect(partyBucket(null)).toBe("Other");
    expect(partyBucket("Peace and Freedom")).toBe("Other");
  });

  it("groups money and candidates by party, and counts who is still running", () => {
    const cands = [
      { id: "a", party: "Democrat", status: "active" },
      { id: "b", party: "Republican", status: "won_primary" },
      { id: "c", party: "Republican", status: "not_on_ballot" },
      { id: "d", party: null, status: null },
    ];
    const raised = new Map([["a", 100], ["b", 250], ["c", 50]]);
    const { slices, counts } = partySlices(cands, raised);
    expect(slices.map((s) => [s.label, s.amount])).toEqual([["Democrat", 100], ["Republican", 300], ["Other", 0]]);
    expect(counts).toEqual([{ label: "Democrat", count: 1 }, { label: "Republican", count: 2 }, { label: "Other", count: 1 }]);
    expect(runningCounts(cands)).toEqual({ running: 3, out: 1 });
  });
});
