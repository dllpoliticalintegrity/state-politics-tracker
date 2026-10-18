// Legislative chambers: district races synthesized from the registry, URL
// resolution for chamber / district paths, and their SEO metadata.
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import {
  chamberDistricts,
  districtRace,
  getChamber,
  getState,
  isValidDistrict,
  liveStates,
} from "@/states/registry";
import { raceFromSegments, racePath, useActiveRace, useActiveRaceBase } from "@/states/StateContext";
import { humanizeSlug, routeMeta, sitemapEntries } from "../../shared/seo";

const mi = getState("mi")!;
const senate = getChamber(mi, "state-senate")!;
const at = (path: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
);

describe("chamber registry", () => {
  it("gives Michigan both chambers with the real seat counts", () => {
    expect(senate.districts).toBe(38);
    expect(getChamber(mi, "state-house")!.districts).toBe(110);
    expect(getChamber(mi, "governor")).toBeUndefined();
    expect(getChamber(getState("ga")!, "state-senate")!.districts).toBe(56);
    expect(getChamber(getState("ga")!, "state-house")!.districts).toBe(180);
    expect(getChamber(getState("fl")!, "state-senate")!.seatsUp).toHaveLength(20);
    expect(getChamber(getState("tx")!, "state-senate")!.seatsUp).toHaveLength(16);
  });

  it("keeps chamber offices distinct from statewide offices in every live state", () => {
    for (const s of liveStates()) {
      const offices = new Set(s.races!.map((r) => r.office));
      for (const c of s.chambers ?? []) {
        expect(offices.has(c.office), `${s.code}/${c.office}`).toBe(false);
        expect(c.office).toMatch(/^[a-z0-9-]+$/);
        expect(c.districts).toBeGreaterThan(0);
        expect(c.generalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("validates district numbers strictly", () => {
    expect(isValidDistrict(senate, "1")).toBe(true);
    expect(isValidDistrict(senate, "38")).toBe(true);
    expect(isValidDistrict(senate, "39")).toBe(false);
    expect(isValidDistrict(senate, "0")).toBe(false);
    expect(isValidDistrict(senate, "011")).toBe(false);
    expect(isValidDistrict(senate, "abc")).toBe(false);
    expect(isValidDistrict(senate, undefined)).toBe(false);
    expect(chamberDistricts(senate)).toHaveLength(38);
    expect(chamberDistricts(senate)[0]).toBe("1");
  });

  it("synthesizes a finance-only race per district", () => {
    const r = districtRace(mi, senate, "11");
    expect(r).toMatchObject({ office: "state-senate", district: "11", title: "State Senate District 11" });
    expect(r.pollingSourceUrl).toBeUndefined();
    expect(r.raceSlug).toBe("michigan-state-senate-11-2026");
  });
});

describe("chamber URL resolution", () => {
  it("resolves statewide offices, districts, and chamber overviews", () => {
    expect(raceFromSegments(mi, "governor", undefined)!.office).toBe("governor");
    expect(raceFromSegments(mi, "state-senate", "11")!.district).toBe("11");
    expect(raceFromSegments(mi, "state-senate", undefined)).toBeNull(); // overview
    expect(raceFromSegments(mi, "state-senate", "99")).toBeNull();
    expect(raceFromSegments(mi, "nope", undefined)).toBeNull();
  });

  it("builds race paths with the district segment", () => {
    expect(racePath(mi, districtRace(mi, senate, "11"))).toBe("/mi/state-senate/11");
    expect(racePath(mi, mi.races![0])).toBe("/mi/governor");
  });

  it("reads the active race from hub URLs, with no race on a chamber overview", () => {
    const d = renderHook(() => useActiveRace(), { wrapper: at("/mi/state-house/110/money/donors") });
    expect(d.result.current).toMatchObject({ office: "state-house", district: "110" });
    const base = renderHook(() => useActiveRaceBase(), { wrapper: at("/mi/state-house/110/money/donors") });
    expect(base.result.current).toBe("/mi/state-house/110");
    const overview = renderHook(() => useActiveRace(), { wrapper: at("/mi/state-senate") });
    expect(overview.result.current).toBeNull();
    const about = renderHook(() => useActiveRace(), { wrapper: at("/mi/about") });
    expect(about.result.current?.office).toBe("governor");
  });
});

describe("chamber SEO", () => {
  it("titles the chamber overview and district pages", () => {
    expect(routeMeta("/state-senate", "mi")!.title).toBe(
      "Michigan State Senate 2026 — Campaign Finance by District | Michigan Politics Tracker",
    );
    expect(routeMeta("/state-senate/11", "mi")!.title).toBe(
      "Michigan State Senate District 11 2026 Race — Campaign Finance | Michigan Politics Tracker",
    );
    expect(routeMeta("/state-house/110/money/donors", "mi")!.h1).toBe(
      "Michigan State House District 110 2026: Top Donors",
    );
    // No polling page for a district race.
    expect(routeMeta("/state-senate/11/polling", "mi")).toBeNull();
    expect(routeMeta("/state-senate/39", "mi")).toBeNull();
    expect(routeMeta("/state-senate/0", "mi")).toBeNull();
  });

  it("titles district candidate profiles without the district slug tag", () => {
    expect(humanizeSlug("hashim-bakari-sd11")).toBe("Hashim Bakari");
    expect(humanizeSlug("jocelyn-benson")).toBe("Jocelyn Benson");
    expect(routeMeta("/state-senate/11/candidates/hashim-bakari-sd11", "mi")!.title).toBe(
      "Hashim Bakari — Michigan State Senate District 11 2026 Candidate | Michigan Politics Tracker",
    );
  });

  it("lists chamber overviews and every district home in the sitemap", () => {
    const paths = sitemapEntries("mi").map((e) => e.path);
    expect(paths).toContain("/state-senate");
    expect(paths).toContain("/state-house");
    expect(paths).toContain("/state-senate/38");
    expect(paths).toContain("/state-house/110");
    expect(paths).not.toContain("/state-senate/39");
    expect(paths).not.toContain("/state-senate/1/candidates");
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("staggered chambers", () => {
  it("lists only the seats on the ballot and keeps every map district numbered", async () => {
    const { chamberDistricts, chamberScope } = await import("@/states/registry");
    const tx = getChamber(getState("oh")!, "state-senate")!;
    expect(chamberDistricts(tx)).toEqual(["1", "3", "5", "7", "9", "11", "13", "15", "17", "19", "21", "23", "25", "27", "29", "31", "33"]);
    expect(chamberScope(tx)).toBe("the 17 of 33 State Senate seats on the 2026 ballot");
    const ga = getChamber(getState("ga")!, "state-house")!;
    expect(chamberDistricts(ga)).toHaveLength(180);
    expect(chamberScope(ga)).toBe("all 180 State House districts");
    for (const code of ["ak", "az", "fl", "ga", "oh", "or", "wi", "mi", "tx", "ca"]) {
      for (const c of getState(code)!.chambers!) {
        expect(c.map, `${code} ${c.office}`).toMatch(new RegExp(`^/maps/${code}-${c.office}\\.json$`));
        for (const d of c.seatsUp ?? []) expect(d).toBeLessThanOrEqual(c.districts);
      }
    }
  });
});
