import { describe, it, expect } from "vitest";
import { cleanQuery, toResults, type CandidateSearchRow } from "@/lib/candidateSearch";

const row = (r: Partial<CandidateSearchRow>): CandidateSearchRow => ({
  slug: "x", name: "X", party: null, state: "mi", office: "governor", district: null, status: null, ...r,
});

describe("candidate search", () => {
  it("strips wildcards and filter syntax from the query", () => {
    expect(cleanQuery("  Jocelyn   Benson ")).toBe("Jocelyn Benson");
    expect(cleanQuery("o'brien-smith")).toBe("o'brien-smith");
    expect(cleanQuery("*%_,()name.eq")).toBe("name.eq");
    expect(cleanQuery("José")).toBe("José");
  });

  it("links statewide and district candidates to their race profile", () => {
    const res = toResults(
      [
        row({ slug: "jocelyn-benson", name: "Jocelyn Benson", party: "Democrat" }),
        row({ slug: "hashim-bakari-sd11", name: "Hashim Bakari", office: "state-senate", district: "11" }),
      ],
      { showState: false },
    );
    expect(res.map((r) => r.href)).toEqual([
      "/mi/state-senate/11/candidates/hashim-bakari-sd11",
      "/mi/governor/candidates/jocelyn-benson",
    ]);
    expect(res[1].context).toBe("Governor");
  });

  it("adds the state on the hub, drops unroutable rows, and puts off-ballot candidates last", () => {
    const res = toResults(
      [
        row({ slug: "a", name: "Aaron Out", office: "state-senate", district: "3", status: "not_on_ballot" }),
        row({ slug: "z", name: "Zed In", office: "state-senate", district: "3", status: "active" }),
        row({ slug: "bad", name: "No Race", office: "dog-catcher" }),
        row({ slug: "zz", name: "Unknown State", state: "zz" }),
      ],
      { showState: true },
    );
    expect(res.map((r) => r.slug)).toEqual(["z", "a"]);
    expect(res[0].context).toMatch(/^Michigan · /);
    expect(res[1].statusLabel).toBe("Not on ballot");
  });

  it("caps the list", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ slug: `c${i}`, name: `C ${i}` }));
    expect(toResults(rows, { showState: false })).toHaveLength(8);
  });
});
