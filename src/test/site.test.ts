import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SINGLE_STATE_HOSTS,
  SINGLE_STATE_SITES,
  makeStateSitesLookup,
  normalizeHost,
  resolveSiteState,
  resolveSiteStateAsync,
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

  it("recognises cagovtracker.com", () => {
    expect(siteStateForHost("cagovtracker.com")).toBe("ca");
    expect(siteStateForHost("www.cagovtracker.com")).toBe("ca");
    expect(SINGLE_STATE_SITES.ca).toBe("https://cagovtracker.com");
  });

  it("recognises texaspoliticstracker.com", () => {
    expect(siteStateForHost("texaspoliticstracker.com")).toBe("tx");
    expect(siteStateForHost("www.texaspoliticstracker.com")).toBe("tx");
    expect(SINGLE_STATE_SITES.tx).toBe("https://texaspoliticstracker.com");
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

describe("state_sites hostname lookup", () => {
  afterEach(() => vi.restoreAllMocks());
  const ok = (rows: unknown[]) =>
    (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;

  it("maps a saved hostname to its state and caches it", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      expect(url).toContain("state_sites?select=state&hostname=eq.georgiapoliticstracker.com&limit=1");
      return new Response(JSON.stringify([{ state: "ga" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = makeStateSitesLookup({ supabaseUrl: "https://x.supabase.co", anonKey: "k", fetchImpl });
    expect(await lookup("www.georgiapoliticstracker.com")).toBe("ga");
    expect(await lookup("georgiapoliticstracker.com")).toBe("ga");
    expect(calls).toBe(1);
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

  it("resolves override, then the lookup, then the hard-coded hosts, then the hub", async () => {
    const lookup = async (h: string) => (h === "georgiapoliticstracker.com" ? "ga" : null);
    expect(await resolveSiteStateAsync({ override: "oh", hostname: "georgiapoliticstracker.com", lookup })).toBe("oh");
    expect(await resolveSiteStateAsync({ override: "", hostname: "www.georgiapoliticstracker.com", lookup })).toBe("ga");
    expect(await resolveSiteStateAsync({ hostname: "michiganpoliticstracker.com", lookup })).toBe("mi");
    expect(await resolveSiteStateAsync({ hostname: "localhost", lookup })).toBeNull();
    expect(await resolveSiteStateAsync({ hostname: "michiganpoliticstracker.com" })).toBe("mi");
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
