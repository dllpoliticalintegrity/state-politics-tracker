import { describe, it, expect } from "vitest";
import {
  SIZE_BINS,
  cumulativeByMonth,
  monthLabel,
  monthRange,
  sizeBinFor,
  sizeMix,
  timelineWindow,
} from "@/lib/fundraisingCharts";

describe("size bins", () => {
  it("mirrors the SQL CASE, refunds included in the smallest bin", () => {
    expect(sizeBinFor(-50)).toBe("under_200");
    expect(sizeBinFor(199.99)).toBe("under_200");
    expect(sizeBinFor(200)).toBe("200_to_999");
    expect(sizeBinFor(999.99)).toBe("200_to_999");
    expect(sizeBinFor(1000)).toBe("1k_to_9999");
    expect(sizeBinFor(9999.99)).toBe("1k_to_9999");
    expect(sizeBinFor(10000)).toBe("10k_plus");
    expect(SIZE_BINS).toEqual(["under_200", "200_to_999", "1k_to_9999", "10k_plus"]);
  });

  it("sums a candidate's bins into shares of their total", () => {
    const mix = sizeMix([
      { candidate_id: "a", size_bin: "under_200", amount: 25, contribution_count: 5 },
      { candidate_id: "a", size_bin: "10k_plus", amount: 75, contribution_count: 1 },
      { candidate_id: "a", size_bin: "bogus", amount: 999, contribution_count: 9 },
      { candidate_id: "b", size_bin: "under_200", amount: -10, contribution_count: 1 },
    ]);
    const a = mix.get("a")!;
    expect(a.total).toBe(100);
    expect(a.shares.under_200).toBe(0.25);
    expect(a.shares["10k_plus"]).toBe(0.75);
    expect(a.counts.under_200).toBe(5);
    const b = mix.get("b")!;
    expect(b.total).toBe(-10);
    expect(b.shares.under_200).toBe(0);
  });
});

describe("timeline", () => {
  it("lists months inclusively across a year end", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthRange("2026-02", "2026-01")).toEqual([]);
    expect(monthLabel("2026-03")).toBe("Mar '26");
  });

  it("starts at the first month with money, floored at January of the year before the election", () => {
    const rows = [
      { candidate_id: "a", month: "0025-03-01", amount: 1 },
      { candidate_id: "a", month: "2025-04-01", amount: 1 },
    ];
    expect(timelineWindow(rows, "2026-11-03", "2026-10-28")).toEqual({ start: "2025-01", end: "2026-10" });
    expect(timelineWindow([{ candidate_id: "a", month: "2025-06-01", amount: 1 }], "2026-11-03", "2026-10-28")).toEqual({
      start: "2025-06",
      end: "2026-10",
    });
    expect(timelineWindow([], "2026-11-03", "2026-10-28")).toBeNull();
  });

  it("accumulates per series and folds out-of-window months into the edges", () => {
    const rows = [
      { candidate_id: "a", month: "0025-03-01", amount: 5 },
      { candidate_id: "a", month: "2026-01-01", amount: 10 },
      { candidate_id: "a", month: "2026-03-01", amount: 20 },
      { candidate_id: "a", month: "2028-08-01", amount: 1 },
      { candidate_id: "b", month: "2026-02-01", amount: 7 },
      { candidate_id: "c", month: "2026-02-01", amount: 3 },
      { candidate_id: "zzz", month: "2026-02-01", amount: 99 },
    ];
    const pts = cumulativeByMonth(rows, { a: ["a"], others: ["b", "c"] }, { start: "2026-01", end: "2026-03" });
    expect(pts).toEqual([
      { month: "2026-01", a: 15, others: 0 },
      { month: "2026-02", a: 15, others: 10 },
      { month: "2026-03", a: 36, others: 10 },
    ]);
  });
});
