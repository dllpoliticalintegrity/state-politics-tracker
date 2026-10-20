import { describe, expect, it } from "vitest";
import { comparisonDefaults, comparisonPair } from "./headToHead";

const candidates = [
  { id: "a", slug: "a", name: "A", status: "lost_primary", raised: 1000, poll: 60 },
  { id: "b", slug: "b", name: "B", status: "nominee", raised: 100, poll: 40 },
  { id: "c", slug: "c", name: "C", status: "won_primary", raised: 200, poll: 45 },
  { id: "d", slug: "d", name: "D", status: "running", raised: 500, poll: 50 },
];
const defaults = comparisonDefaults(candidates, (c) => c.raised, (c) => c.poll);

describe("two-candidate election comparisons", () => {
  it("defaults to two confirmed nominees rather than off-ballot candidates", () => {
    expect(defaults.map((c) => c.id)).toEqual(["c", "b"]);
  });
  it("does not compare a candidate against themselves", () => {
    expect(comparisonPair(candidates, defaults, "b", "b").map((c) => c?.slug)).toEqual(["b", "c"]);
  });
  it("permits explicitly selected candidates and restores invalid links to defaults", () => {
    expect(comparisonPair(candidates, defaults, "a", "d").map((c) => c?.slug)).toEqual(["a", "d"]);
    expect(comparisonPair(candidates, defaults, "unknown", "invalid").map((c) => c?.slug)).toEqual(["c", "b"]);
  });
  it("leaves the second slot empty for an uncontested election", () => {
    const only = candidates.slice(1, 2);
    expect(comparisonPair(only, only, null, null)).toEqual([only[0], undefined]);
  });
  it("puts Democrats left and Republicans right regardless of fundraising or reversed URL selections", () => {
    const dem = { id: "dem", slug: "dem", name: "Democrat", party: "Democrat", status: "nominee", raised: 1 };
    const rep = { id: "rep", slug: "rep", name: "Republican", party: "Republican", status: "nominee", raised: 1000 };
    const pair = comparisonDefaults([rep, dem], (c) => c.raised, () => null);
    expect(pair.map((c) => c.slug)).toEqual(["dem", "rep"]);
    expect(comparisonPair([rep, dem], pair, "rep", "dem").map((c) => c?.slug)).toEqual(["dem", "rep"]);
  });
  it("prefers the major-party nominees over a better-funded third party in an unpolled race", () => {
    const fontes = { id: "f", slug: "f", name: "Fontes", party: "Democrat", status: "won_primary", raised: 2_650_000 };
    const collier = { id: "c", slug: "c", name: "Collier", party: "Green", status: "nominee", raised: 739_000 };
    const kolodin = { id: "k", slug: "k", name: "Kolodin", party: "Republican", status: "won_primary", raised: 511_000 };
    expect(comparisonDefaults([fontes, collier, kolodin], (c) => c.raised, () => null).map((c) => c.slug)).toEqual(["f", "k"]);
  });
  it("still pairs a third party that polls ahead of a major-party nominee", () => {
    const dem = { id: "d", slug: "d", name: "Dem", party: "Democrat", status: "nominee", poll: 40 };
    const ind = { id: "i", slug: "i", name: "Ind", party: "Independent", status: "nominee", poll: 35 };
    const rep = { id: "r", slug: "r", name: "Rep", party: "Republican", status: "nominee", poll: 12 };
    expect(comparisonDefaults([dem, ind, rep], () => 0, (c) => c.poll).map((c) => c.slug)).toEqual(["d", "i"]);
  });
  it("keeps a lone Republican on the right and a lone Democrat on the left", () => {
    const rep = { slug: "rep", party: "R" };
    const dem = { slug: "dem", party: "D" };
    expect(comparisonPair([rep], [rep], null, null)).toEqual([undefined, rep]);
    expect(comparisonPair([dem], [dem], null, null)).toEqual([dem, undefined]);
  });
});