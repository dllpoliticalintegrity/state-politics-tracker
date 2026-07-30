import { describe, it, expect } from "vitest";
import { STATES, getState, liveStates } from "@/states/registry";

describe("state registry", () => {
  it("contains all 50 states with unique codes", () => {
    expect(STATES).toHaveLength(50);
    const codes = new Set(STATES.map((s) => s.code));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/);
  });

  it("marks Texas and California external with URLs", () => {
    for (const code of ["tx", "ca"]) {
      const s = getState(code);
      expect(s?.status).toBe("external");
      expect(s?.externalUrl).toMatch(/^https:\/\//);
    }
  });

  it("marks the live states live and the rest of SLCF ready", () => {
    for (const code of ["fl", "mi", "ga", "az", "ky", "me"]) {
      expect(getState(code)?.status).toBe("live");
    }
    for (const code of ["pa", "al", "mn"]) {
      expect(getState(code)?.status).toBe("ready");
    }
    // 24 SLCF states + ME, minus the 6 live states (AZ/KY/ME were SLCF-listed).
    expect(STATES.filter((s) => s.status === "ready")).toHaveLength(18);
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
