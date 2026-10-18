import { describe, it, expect } from "vitest";
import {
  buildPollingBundle,
  flipName,
  fromLptOffice,
  lptDistrict,
  lptRaceSlug,
  normalizeParty,
  pollCandidateName,
  surnameOf,
  toLptOffice,
  toRacePollRows,
  type LptPoll,
} from "@/lib/lpt";
import { getState } from "@/states/registry";
import { readCandidatePct } from "@/lib/lpt";

describe("LPT vocabulary", () => {
  it("maps the registry's state-house onto LPT's state-representative and back", () => {
    expect(toLptOffice("state-house")).toBe("state-representative");
    expect(toLptOffice("governor")).toBe("governor");
    expect(fromLptOffice("state-representative")).toBe("state-house");
    expect(fromLptOffice("lt-governor")).toBe("lt-governor");
  });

  it("derives office_num: 0 statewide, the district number, null for a chamber overview", () => {
    const ga = getState("ga")!;
    expect(lptDistrict(ga, { office: "governor" })).toBe(0);
    expect(lptDistrict(ga, { office: "state-senate", district: "11" })).toBe(11);
    expect(lptDistrict(ga, { office: "state-senate" })).toBeNull();
  });

  it("builds LPT race slugs", () => {
    expect(lptRaceSlug({ office: "governor", generalDate: "2026-11-03" })).toBe("governor-2026");
    expect(lptRaceSlug({ office: "state-house", district: "3", generalDate: "2026-11-03" })).toBe("state-representative-3-2026");
  });

  it("flips filing names and strips suffixes for surname matching", () => {
    expect(flipName("JACKSON, RICHARD L.")).toBe("RICHARD L. JACKSON");
    expect(flipName("Bottoms, Keisha L., Jr.")).toBe("Keisha L. Bottoms Jr.");
    expect(flipName("JACKSON, JR., RICHARD")).toBe("RICHARD JACKSON JR.");
    expect(flipName("Sully Sullivan")).toBe("Sully Sullivan");
    expect(flipName(null)).toBe("");
    expect(pollCandidateName("Jackson, Richard L.")).toBe("Richard L. Jackson");
    expect(surnameOf("Jackson, Richard L.")).toBe("Jackson");
    expect(surnameOf("Richard Jackson Jr.")).toBe("Jackson");
    expect(surnameOf("Keisha Lance Bottoms")).toBe("Bottoms");
  });

  it("normalizes party spellings", () => {
    expect(normalizeParty("Democratic")).toBe("Democrat");
    expect(normalizeParty("Democrat")).toBe("Democrat");
    expect(normalizeParty("Republican")).toBe("Republican");
    expect(normalizeParty("Non-Partisan")).toBe("Independent");
    expect(normalizeParty("Libertarian")).toBe("Libertarian");
    expect(normalizeParty(null)).toBeNull();
  });
});

const polls: LptPoll[] = [
  {
    poll_id: "p1", source: "Wedgewood Polls", poll_date: "2026-10-04", sample_size: 600, sample_type: "LV", margin_of_error: "4.0",
    race_poll_results: [
      { label: "Jackson, Richard L.", party: "Republican", pct: 51, candidate_id: "a" },
      { label: "Bottoms, Keisha L.", party: "Democratic", pct: 49, candidate_id: "b" },
      { label: "Undecided", party: null, pct: 0, candidate_id: null },
    ],
  },
  {
    poll_id: "p2", source: "InsiderAdvantage", poll_date: "2026-09-25", sample_size: 1200, sample_type: "LV", margin_of_error: null,
    race_poll_results: [
      { label: "Jackson, Richard L.", party: "Republican", pct: "48", candidate_id: "a" },
      { label: "Bottoms, Keisha L.", party: "Democratic", pct: 46, candidate_id: "b" },
      { label: "Undecided", party: null, pct: 6, candidate_id: null },
    ],
  },
  { poll_id: "p3", source: "Empty", poll_date: "2026-09-01", sample_size: null, sample_type: null, margin_of_error: null, race_poll_results: [] },
];

describe("LPT polling", () => {
  it("averages the most recent polls per surname and reports the spread", () => {
    const b = buildPollingBundle(polls, { pollingSourceUrl: "https://example.test/ga" }, "Local Politics Tracker")!;
    expect(b.average?.Jackson).toBe("49.5");
    expect(b.average?.Bottoms).toBe("47.5");
    // Keyed by candidate id too, so a namesake off the ballot never inherits the average.
    expect(b.average?.["id:a"]).toBe("49.5");
    expect(b.average?.["id:b"]).toBe("47.5");
    expect(readCandidatePct(b.average, "Richard Jackson", "a")).toBe(49.5);
    expect(readCandidatePct(b.average, "Derrick Jackson", "zzz")).toBeNull();
    expect(readCandidatePct({ Poll: "x", Date: "", Sample: "", MoE: "", Jackson: "40" }, "Derrick Jackson", "zzz")).toBe(40);
    expect(b.average?.Undecided).toBeUndefined();
    expect(b.average?.Poll).toBe("Local Politics Tracker Average");
    expect(b.spread).toBe("Jackson +2");
    expect(b.last_updated).toBe("2026-10-04");
    expect(b.rcp_url).toBe("https://example.test/ga");
    expect(b.polls).toEqual([]);
  });

  it("returns null without polls", () => {
    expect(buildPollingBundle([], {}, "x")).toBeNull();
    expect(buildPollingBundle([polls[2]], {}, "x")).toBeNull();
  });

  it("flattens polls into per-candidate rows the trend chart reads", () => {
    const rows = toRacePollRows(polls);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      candidate_name: "Richard L. Jackson", candidate_party: "Republican", candidate_id: "a", pct: 51, pollster: "Wedgewood Polls",
      field_end: "2026-10-04", sample_size: 600, sample_kind: "LV", source_url: null, matchup: "general",
    });
    expect(rows[2].pct).toBe(48);
  });
});
