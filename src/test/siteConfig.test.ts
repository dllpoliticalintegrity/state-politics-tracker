import { describe, expect, it } from "vitest";
import { applySiteConfig, type StateSiteRow } from "@/lib/siteConfig";
import { getState } from "@/states/registry";

const row = (over: Partial<StateSiteRow> = {}): StateSiteRow => ({
  state: "ga",
  hostname: "georgiapoliticstracker.com",
  worker_name: "georgia-politics-tracker",
  display_name: "Georgia Money Tracker",
  tagline: "Follow the money under the Gold Dome",
  logo_url: "https://example.com/logo.svg",
  accent_color: "#1a7f5a",
  about_text: "About Georgia.",
  credits_text: "Data: Georgia Government Transparency & Campaign Finance Commission",
  hidden_races: ["georgia-attorney-general-2026"],
  published: true,
  ...over,
});

describe("applySiteConfig", () => {
  const ga = getState("ga")!;

  it("falls back to the registry with no row", () => {
    const c = applySiteConfig(ga, null);
    expect(c.siteName).toBe("Georgia Politics Tracker");
    expect(c.tagline).toBeNull();
    expect(c.races.map((r) => r.raceSlug)).toEqual(ga.races!.map((r) => r.raceSlug));
  });

  it("ignores an unpublished row", () => {
    const c = applySiteConfig(ga, row({ published: false }));
    expect(c.siteName).toBe("Georgia Politics Tracker");
    expect(c.races).toHaveLength(ga.races!.length);
  });

  it("applies a published row and hides the listed races", () => {
    const c = applySiteConfig(ga, row());
    expect(c.siteName).toBe("Georgia Money Tracker");
    expect(c.tagline).toBe("Follow the money under the Gold Dome");
    expect(c.accentColor).toBe("#1a7f5a");
    expect(c.races.map((r) => r.raceSlug)).not.toContain("georgia-attorney-general-2026");
    expect(c.races.length).toBe(ga.races!.length - 1);
  });

  it("never hides every race", () => {
    const all = ga.races!.map((r) => r.raceSlug);
    const c = applySiteConfig(ga, row({ hidden_races: all }));
    expect(c.races).toHaveLength(ga.races!.length);
  });

  it("is the hub with no state", () => {
    const c = applySiteConfig(null, row());
    expect(c.siteName).toBe("State Politics Tracker");
    expect(c.races).toEqual([]);
  });
});
