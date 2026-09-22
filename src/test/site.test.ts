import { describe, it, expect } from "vitest";
import {
  SINGLE_STATE_HOSTS,
  SINGLE_STATE_SITES,
  normalizeHost,
  resolveSiteState,
  siteNameFor,
  siteStateForHost,
  statePathFor,
} from "../../shared/site";
import { getState } from "@/states/registry";

describe("single-state site resolution", () => {
  it("maps every dedicated host to a live registry state", () => {
    for (const [host, code] of Object.entries(SINGLE_STATE_HOSTS)) {
      expect(host).toMatch(/^[a-z0-9.-]+$/);
      expect(host.startsWith("www.")).toBe(false);
      const cfg = getState(code);
      expect(cfg?.status, `${host} → ${code}`).toBe("live");
      expect(cfg?.races?.length).toBeGreaterThan(0);
      expect(SINGLE_STATE_SITES[code]).toBe(`https://${host}`);
    }
  });

  it("recognises michiganpoliticstracker.com, with or without www, port or trailing dot", () => {
    expect(siteStateForHost("michiganpoliticstracker.com")).toBe("mi");
    expect(siteStateForHost("www.michiganpoliticstracker.com")).toBe("mi");
    expect(siteStateForHost("WWW.MichiganPoliticsTracker.com.")).toBe("mi");
    expect(siteStateForHost("michiganpoliticstracker.com:8788")).toBe("mi");
    expect(normalizeHost("www.Example.com:443")).toBe("example.com");
  });

  it("treats every other host as the hub", () => {
    expect(siteStateForHost("localhost")).toBeNull();
    expect(siteStateForHost("state-politics-tracker.pages.dev")).toBeNull();
    expect(siteStateForHost("michiganpoliticstracker.com.evil.example")).toBeNull();
    expect(siteStateForHost(undefined)).toBeNull();
    expect(siteStateForHost("")).toBeNull();
  });

  it("lets an explicit override win over the hostname", () => {
    expect(resolveSiteState({ override: "mi", hostname: "localhost" })).toBe("mi");
    expect(resolveSiteState({ override: " GA ", hostname: "michiganpoliticstracker.com" })).toBe("ga");
    // A non-code override ("hub") forces the multi-state site even on a dedicated host.
    expect(resolveSiteState({ override: "hub", hostname: "michiganpoliticstracker.com" })).toBeNull();
    // Blank overrides fall through to the hostname.
    expect(resolveSiteState({ override: "", hostname: "michiganpoliticstracker.com" })).toBe("mi");
    expect(resolveSiteState({ override: null, hostname: undefined })).toBeNull();
  });

  it("drops the state prefix only on that state's own site", () => {
    expect(statePathFor("mi", "mi")).toBe("");
    expect(statePathFor("mi", "ga")).toBe("/ga");
    expect(statePathFor(null, "mi")).toBe("/mi");
  });

  it("brands the site after the pinned state", () => {
    expect(siteNameFor("Michigan")).toBe("Michigan Politics Tracker");
    expect(siteNameFor(null)).toBe("State Politics Tracker");
    expect(siteNameFor(undefined)).toBe("State Politics Tracker");
  });
});
