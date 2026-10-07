import { describe, it, expect } from "vitest";
import {
  STATES,
  getState,
  legacyRedirect,
  liveStates,
  pollingSourceKey,
  pollingSourceLabel,
  statePollingLabel,
} from "@/states/registry";

describe("state registry", () => {
  it("contains all 50 states with unique codes", () => {
    expect(STATES).toHaveLength(50);
    const codes = new Set(STATES.map((s) => s.code));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/);
  });

  it("marks California external with a URL", () => {
    const s = getState("ca");
    expect(s?.status).toBe("external");
    expect(s?.externalUrl).toMatch(/^https:\/\//);
  });

  it("tracks Texas as a live state with its three statewide races", () => {
    const tx = getState("tx")!;
    expect(tx.status).toBe("live");
    expect(tx.externalUrl).toBeUndefined();
    expect(tx.agency?.name).toBe("Texas Ethics Commission");
    expect(tx.races!.map((r) => r.office)).toEqual(["governor", "lt-governor", "attorney-general"]);
    // Only the governor's race is polled, and by FiftyPlusOne rather than 270toWin.
    const [gov, ltgov] = tx.races!;
    expect(pollingSourceKey(gov)).toBe("fiftyplusone");
    expect(pollingSourceLabel(gov)).toBe("FiftyPlusOne");
    expect(gov.pollingSourceUrl).toMatch(/^https:\/\/fiftyplusone\.news\//);
    expect(ltgov.pollingSourceUrl).toBeUndefined();
    expect(statePollingLabel(tx)).toBe("FiftyPlusOne");
  });

  it("defaults every other race's polling to 270toWin", () => {
    const mi = getState("mi")!;
    expect(pollingSourceKey(mi.races![0])).toBe("270towin");
    expect(statePollingLabel(mi)).toBe("270toWin");
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

  it("marks the live states live and the rest of SLCF ready", () => {
    const live = [
      "fl", "mi", "ga", "az", "ky", "me",
      "pa", "ma", "mn", "co", "ia", "md", "hi",
      "oh", "wi", "nv",
      "al", "ak", "ar", "ct", "id", "il", "ks",
      "tx",
    ];
    for (const code of live) {
      expect(getState(code)?.status).toBe("live");
    }
    for (const code of ["de", "in", "la", "ms"]) {
      expect(getState(code)?.status).toBe("ready");
    }
    // 24 SLCF states, minus the 20 live SLCF states (OH/WI/NV are live
    // without an SLCF pipeline).
    expect(STATES.filter((s) => s.status === "ready")).toHaveLength(4);
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
