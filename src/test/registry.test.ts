import { describe, it, expect } from "vitest";
import {
  STATES,
  getState,
  hiddenStates,
  legacyRedirect,
  liveStates,
  pollingSourceKey,
  pollingSourceLabel,
  statePollingLabel,
} from "@/states/registry";

describe("state registry", () => {
  it("covers the statemoney.us states plus Michigan and California, reading Georgia from LPT", () => {
    expect(liveStates().map((s) => s.code).sort()).toEqual(["ak", "az", "ca", "fl", "ga", "mi", "oh", "or", "tx", "wi"]);
    expect(liveStates().filter((s) => s.source === "lpt").map((s) => s.code)).toEqual(["ga", "oh", "or"]);
    for (const s of STATES) expect(["lpt", "tracker"]).toContain(s.source);
    // Hidden states keep their dashboards and pipelines; the hub just does not list them as live.
    const hidden = hiddenStates().map((s) => s.code).sort();
    expect(hidden).toEqual(["al", "ar", "co", "ct", "hi", "ia", "id", "il", "ks", "ky", "ma", "md", "me", "mn", "nv", "pa"]);
    for (const s of hiddenStates()) {
      expect(s.status).not.toBe("live");
      expect(s.races?.length).toBeGreaterThan(0);
    }
    // Georgia's legislature comes with the LPT data.
    expect(getState("ga")!.chambers!.map((c) => [c.office, c.districts])).toEqual([["state-senate", 56], ["state-house", 180]]);
  });

  it("contains all 50 states with unique codes", () => {
    expect(STATES).toHaveLength(50);
    const codes = new Set(STATES.map((s) => s.code));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/);
  });

  it("tracks California as a live state with its governor race", () => {
    const ca = getState("ca")!;
    expect(ca.status).toBe("live");
    expect(ca.externalUrl).toBeUndefined();
    expect(ca.races!.map((r) => r.raceSlug)).toEqual(["california-governor-2026"]);
    expect(pollingSourceKey(ca.races![0])).toBe("fiftyplusone");
    expect(ca.races![0].pollingSourceUrl).toBe("https://fiftyplusone.news/polls/governor/general/california");
    // No state links out to a separate site any more.
    expect(STATES.filter((s) => s.status === "external")).toEqual([]);
  });

  it("maps cagovtracker.com's pre-hub URLs onto the governor's race pages", () => {
    const ca = getState("ca")!;
    expect(legacyRedirect(ca, "/candidates")).toBe("/governor/candidates");
    expect(legacyRedirect(ca, "/polling")).toBe("/governor/polling");
    expect(legacyRedirect(ca, "/top-donors")).toBe("/governor/money/donors");
    expect(legacyRedirect(ca, "/independent-expenditures/")).toBe("/governor/money/outside-spending");
    expect(legacyRedirect(ca, "/faq")).toBe("/about");
    expect(legacyRedirect(ca, "/governor")).toBeNull();
  });

  it("tracks Texas as a live state with its three statewide races", () => {
    const tx = getState("tx")!;
    expect(tx.status).toBe("live");
    expect(tx.externalUrl).toBeUndefined();
    expect(tx.agency?.name).toBe("Texas Ethics Commission");
    expect(tx.races!.map((r) => r.office)).toEqual(["governor", "lt-governor", "attorney-general"]);
    // Only the governor's race is polled.
    const [gov, ltgov] = tx.races!;
    expect(pollingSourceKey(gov)).toBe("fiftyplusone");
    expect(pollingSourceLabel(gov)).toBe("FiftyPlusOne");
    expect(gov.pollingSourceUrl).toMatch(/^https:\/\/fiftyplusone\.news\//);
    expect(ltgov.pollingSourceUrl).toBeUndefined();
    expect(statePollingLabel(tx)).toBe("FiftyPlusOne");
  });

  it("polls every tracker race through FiftyPlusOne and every LPT race through the Local Politics Tracker", () => {
    const polled = liveStates().flatMap((s) => (s.races ?? []).filter((r) => r.pollingSourceUrl).map((r) => [s, r] as const));
    expect(polled.length).toBeGreaterThanOrEqual(9);
    for (const [s, r] of polled) {
      if (s.source === "lpt") {
        expect(pollingSourceKey(r)).toBe("lpt");
        expect(pollingSourceLabel(r)).toBe("Local Politics Tracker");
        expect(r.pollingSourceUrl).toMatch(new RegExp(`^https://statemoney\\.us/${s.code}/races/[a-z0-9-]+$`));
        continue;
      }
      expect(pollingSourceKey(r)).toBe("fiftyplusone");
      expect(r.pollingSourceUrl).toMatch(/^https:\/\/fiftyplusone\.news\/polls\/governor\/general\/[a-z-]+$/);
    }
    expect(getState("ak")!.races![0].pollingSourceUrl).toBe("https://fiftyplusone.news/polls/governor/general/alaska");
    expect(statePollingLabel(getState("mi")!)).toBe("FiftyPlusOne");
    // A state with no polled race has no polling credit at all.
    expect(statePollingLabel(getState("hi")!)).toBeNull();
  });

  it("maps the Texas site's pre-hub URLs onto its race pages", () => {
    const tx = getState("tx")!;
    expect(legacyRedirect(tx, "/polling")).toBe("/governor/polling");
    expect(legacyRedirect(tx, "/money/river/")).toBe("/governor/money/river");
    expect(legacyRedirect(tx, "/statewide")).toBe("/lt-governor");
    expect(legacyRedirect(tx, "/faq")).toBe("/about");
    // Current paths and other states are left alone.
    expect(legacyRedirect(tx, "/governor/polling")).toBeNull();
    expect(legacyRedirect(tx, "/")).toBeNull();
    expect(legacyRedirect(getState("mi"), "/polling")).toBeNull();
    expect(legacyRedirect(null, "/polling")).toBeNull();
    // Every target is a real page: a race (or its sub-page) or /about.
    const offices = new Set(tx.races!.map((r) => r.office));
    for (const to of Object.values(tx.legacyPaths!)) {
      const first = to.split("/")[1];
      expect(first === "about" || offices.has(first), to).toBe(true);
    }
  });

  it("marks the live states live, hidden and other SLCF states ready, the rest planned", () => {
    for (const code of ["fl", "mi", "ga", "az", "oh", "or", "wi", "ak", "tx", "ca"]) {
      expect(getState(code)?.status).toBe("live");
    }
    // Hidden states with an SLCF pipeline read as ready; Nevada has no SLCF pipeline.
    for (const code of ["ky", "me", "pa", "ma", "mn", "co", "ia", "md", "hi", "al", "ar", "ct", "id", "il", "ks", "de", "in", "la", "ms"]) {
      expect(getState(code)?.status).toBe("ready");
    }
    expect(getState("nv")?.status).toBe("planned");
    // 24 SLCF states minus the 5 live SLCF states (OH, WI, TX and CA have other pipelines).
    expect(STATES.filter((s) => s.status === "ready")).toHaveLength(19);
  });

  it("live states carry the config the dashboard needs", () => {
    expect(liveStates().length).toBeGreaterThan(0);
    for (const s of liveStates()) {
      expect(s.agency?.name, `${s.code} agency`).toBeTruthy();
      expect(s.races?.length, `${s.code} races`).toBeGreaterThan(0);
      const offices = new Set(s.races!.map((r) => r.office));
      expect(offices.size, `${s.code} unique offices`).toBe(s.races!.length);
      for (const r of s.races!) {
        expect(r.office).toMatch(/^[a-z0-9-]+$/);
        expect(r.title, `${s.code}/${r.office} title`).toBeTruthy();
        expect(r.generalDate, `${s.code}/${r.office} generalDate`).toBeTruthy();
        // Slug year must match the race's general-election year (KY is 2027).
        expect(r.raceSlug, `${s.code}/${r.office} raceSlug`).toMatch(
          new RegExp(`-${r.generalDate.slice(0, 4)}$`),
        );
      }
    }
  });

  it("looks up states case-insensitively and rejects unknowns", () => {
    expect(getState("MI")?.name).toBe("Michigan");
    expect(getState("zz")).toBeUndefined();
    expect(getState(undefined)).toBeUndefined();
  });
});
