import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SINGLE_STATE_HOSTS,
  makePublishedSitesLookup,
  makeStateSitesLookup,
  publishedSitesFrom,
  normalizeHost,
  resolveSiteState,
  resolveSiteStateAsync,
  siteNameFor,
  siteStateForHost,
  statePathFor,
} from "../../shared/site";
import { getState } from "@/states/registry";

describe("single-state site resolution", () => {
  it("has no hard-coded dedicated hosts: each site is its own Worker", () => {
    expect(SINGLE_STATE_HOSTS).toEqual({});
    expect(siteStateForHost("michiganpoliticstracker.com")).toBeNull();
  });

  it("normalizes hostnames", () => {
    expect(normalizeHost("WWW.MichiganPoliticsTracker.com.")).toBe("michiganpoliticstracker.com");
    expect(normalizeHost("michiganpoliticstracker.com:8788")).toBe("michiganpoliticstracker.com");
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
    expect(resolveSiteState({ override: "", hostname: "michiganpoliticstracker.com" })).toBeNull();
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

describe("state_sites hostname lookup", () => {
  afterEach(() => vi.restoreAllMocks());
  const ok = (rows: unknown[]) =>
    (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;

  it("maps a saved hostname to its state and caches it", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      expect(url).toContain("state_sites?select=state&hostname=eq.georgiapoliticstracker.com&published=eq.true&limit=1");
      return new Response(JSON.stringify([{ state: "ga" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl });
    expect(await lookup("www.georgiapoliticstracker.com")).toBe("ga");
    expect(await lookup("georgiapoliticstracker.com")).toBe("ga");
    expect(calls).toBe(1);
  });

  it("never returns a row for an unpublished host (the published filter yields none)", async () => {
    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl });
    expect(await lookup("draft.example.com")).toBeNull();
    expect(requested).toContain("published=eq.true");
  });

  it("expires the cache after ttlMs", async () => {
    let t = 0;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify([{ state: "ga" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl, ttlMs: 1000, now: () => t });
    await lookup("a.example");
    t = 999;
    await lookup("a.example");
    t = 1001;
    await lookup("a.example");
    expect(calls).toBe(2);
  });

  it("returns null for an unknown host, a non-2xx response or a thrown fetch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const miss = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl: ok([]) });
    expect(await miss("nobody.example")).toBeNull();
    const bad = makeStateSitesLookup({
      supabaseUrl: "https://x.supabase.co", anonKey: "k",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(await bad("a.example")).toBeNull();
    const boom = makeStateSitesLookup({
      supabaseUrl: "https://x.supabase.co", anonKey: "k",
      fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    });
    expect(await boom("a.example")).toBeNull();
  });

  it("resolves override, then the lookup, then the hub", async () => {
    const lookup = async (h: string) => (h === "georgiapoliticstracker.com" ? "ga" : null);
    expect(await resolveSiteStateAsync({ override: "oh", hostname: "georgiapoliticstracker.com", lookup })).toBe("oh");
    expect(await resolveSiteStateAsync({ override: "", hostname: "www.georgiapoliticstracker.com", lookup })).toBe("ga");
    expect(await resolveSiteStateAsync({ hostname: "localhost", lookup })).toBeNull();
    expect(await resolveSiteStateAsync({ hostname: "georgiapoliticstracker.com" })).toBeNull();
  });

  it("re-fetches an error after errorTtlMs but keeps a success until ttlMs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    const calls = { bad: 0, good: 0 };
    const fetchImpl = (async (url: string) => {
      if (url.includes("bad.example")) {
        calls.bad += 1;
        return new Response("nope", { status: 500 });
      }
      calls.good += 1;
      return new Response(JSON.stringify([{ state: "ga" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({
      supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl, ttlMs: 10_000, errorTtlMs: 100, now: () => t,
    });
    await lookup("bad.example");
    await lookup("good.example");
    t = 50;
    await lookup("bad.example");
    await lookup("good.example");
    expect(calls).toEqual({ bad: 1, good: 1 });
    t = 150;
    await lookup("bad.example");
    await lookup("good.example");
    expect(calls).toEqual({ bad: 2, good: 1 });
  });

  it("shares one fetch between concurrent lookups of the same cold host", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify([{ state: "ga" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl });
    const out = await Promise.all([lookup("a.example"), lookup("a.example")]);
    expect(out).toEqual(["ga", "ga"]);
    expect(calls).toBe(1);
  });

  it("returns null when the fetch hangs past timeoutMs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_, rej) => {
        init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl, timeoutMs: 20 });
    expect(await lookup("slow.example")).toBeNull();
  });
});

describe("published sites lookup", () => {
  it("maps published rows to https URLs and skips malformed ones", () => {
    expect(
      publishedSitesFrom([
        { state: "MI", hostname: "www.MichiganPoliticsTracker.com" },
        { state: "tx", hostname: "texaspoliticstracker.com" },
        { state: "zzz", hostname: "bad.example" },
        { state: "oh", hostname: "not a host" },
        { state: null, hostname: null },
      ]),
    ).toEqual({ mi: "https://michiganpoliticstracker.com", tx: "https://texaspoliticstracker.com" });
  });

  it("fetches published rows once per ttl and reads a failure as no sites", async () => {
    let t = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify([{ state: "fl", hostname: "floridapoliticstracker.com" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const sites = makePublishedSitesLookup({ supabaseUrl: "https://x.supabase.co/", anonKey: "k", fetchImpl, ttlMs: 1000, now: () => t });
    expect(await sites()).toEqual({ fl: "https://floridapoliticstracker.com" });
    expect(await sites()).toEqual({ fl: "https://floridapoliticstracker.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://x.supabase.co/rest/v1/state_sites?select=state,hostname&published=eq.true");
    t = 2000;
    await sites();
    expect(calls).toHaveLength(2);

    const failing = makePublishedSitesLookup({
      supabaseUrl: "https://x.supabase.co",
      anonKey: "k",
      fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    });
    expect(await failing()).toEqual({});
  });
});
