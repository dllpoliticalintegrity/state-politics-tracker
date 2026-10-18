import { describe, it, expect } from "vitest";
import { mergeIeCycles } from "@/lib/outsideSpending";
import type { TxIeByCandidate } from "@/hooks/useCandidates";

const row = (over: Partial<TxIeByCandidate>): TxIeByCandidate => ({
  candidate_id: "a",
  slug: "a",
  name: "A",
  cycle: "primary-2026",
  total_supporting: 0,
  total_opposing: 0,
  supporting_count: 0,
  opposing_count: 0,
  committee_count: 0,
  as_of: null,
  ...over,
});

describe("mergeIeCycles", () => {
  it("gives each candidate one row across cycles", () => {
    const merged = mergeIeCycles([
      row({ cycle: "primary-2026", total_opposing: 100, opposing_count: 2, committee_count: 3, as_of: "2026-05-30" }),
      row({ cycle: "general-2026", total_supporting: 5, total_opposing: 50, supporting_count: 1, opposing_count: 1, committee_count: 2, as_of: "2026-10-01" }),
      row({ cycle: "unknown", total_opposing: null, committee_count: null }),
      row({ candidate_id: "b", slug: "b", total_supporting: 7, supporting_count: 1, committee_count: 1 }),
    ]);
    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.candidate_id === "a")!;
    expect(a.total_supporting).toBe(5);
    expect(a.total_opposing).toBe(150);
    expect(a.supporting_count).toBe(1);
    expect(a.opposing_count).toBe(3);
    // A distinct count per cycle: the merge keeps the largest, never the sum.
    expect(a.committee_count).toBe(3);
    expect(a.as_of).toBe("2026-10-01");
    expect(merged.find((r) => r.candidate_id === "b")!.total_supporting).toBe(7);
  });

  it("does not modify the rows it is given", () => {
    const input = [row({ total_opposing: 1 }), row({ cycle: "general-2026", total_opposing: 2 })];
    mergeIeCycles(input);
    expect(input[0].total_opposing).toBe(1);
  });
});
