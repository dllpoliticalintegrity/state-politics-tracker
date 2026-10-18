// Single-state site mode — the one codebase also ships as dedicated
// per-state sites (michiganpoliticstracker.com), pinned to one registry
// state: no landing grid, no switcher, race routes at the root
// (/governor instead of /mi/governor), state-branded chrome and SEO.
//
// Shared by the SPA (src/states/site.ts), the Worker (worker/index.ts) and
// the Pages functions, so keep it free of React, DOM and Cloudflare types.
//
// How the state gets pinned, in precedence order:
//   1. an explicit override — VITE_SITE_STATE at build time for the SPA,
//      the SITE_STATE var for the Worker / Pages function, or the
//      <meta name="site-state"> tag the Worker injects into the HTML so the
//      SPA agrees with it even on a *.workers.dev preview hostname;
//   2. the request hostname, looked up in the tracker project's
//      `state_sites` table, published rows only (Worker only, via resolveSiteStateAsync);
//   3. the request hostname, looked up in SINGLE_STATE_HOSTS.
// Anything else is the multi-state hub.

/**
 * Hostname → state code for dedicated sites served by the hub Worker. Empty
 * since Oct 2026: every dedicated site is its own Worker (deploy-site.yml)
 * pinned by its SITE_STATE var, published from the `state_sites` table.
 * Kept as the last-resort fallback for a hostname attached to the hub Worker.
 */
export const SINGLE_STATE_HOSTS: Record<string, string> = {};

/**
 * The multi-state hub's public URL, for "All states" links on a dedicated
 * site (chrome hides those links when it is null). The hub has served
 * statepoliticstracker.com since Oct 2026.
 */
export const HUB_URL: string | null = "https://statepoliticstracker.com";

/** Name of the <meta> tag the Worker injects to pin the SPA's state. */
export const SITE_STATE_META = "site-state";

export function normalizeHost(hostname: string | null | undefined): string {
  return (hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** State code a hostname is dedicated to, or null for the hub. */
export function siteStateForHost(hostname: string | null | undefined): string | null {
  return SINGLE_STATE_HOSTS[normalizeHost(hostname)] ?? null;
}

const CODE_RE = /^[a-z]{2}$/;

/**
 * Resolve the pinned state for a request or page load. `override` wins when
 * it is a two-letter code; "hub" (or any non-code) forces the multi-state
 * site even on a dedicated hostname, which is handy for previews.
 */
export function resolveSiteState(opts: {
  override?: string | null;
  hostname?: string | null;
}): string | null {
  const o = (opts.override ?? "").trim().toLowerCase();
  if (o) return CODE_RE.test(o) ? o : null;
  return siteStateForHost(opts.hostname);
}

/** state code → https://<hostname> of each published dedicated site. */
export type PublishedSites = Record<string, string>;

/** PublishedSites from `state_sites` rows; skips malformed rows. */
export function publishedSitesFrom(rows: { state?: string | null; hostname?: string | null }[]): PublishedSites {
  const out: PublishedSites = {};
  for (const r of rows) {
    const code = (r.state ?? "").toLowerCase();
    const host = normalizeHost(r.hostname);
    if (CODE_RE.test(code) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) out[code] = `https://${host}`;
  }
  return out;
}

/**
 * Every published dedicated site, from `state_sites`, cached for `ttlMs`
 * (5 minutes by default; a failure is remembered for 30 s and reads as no
 * sites, so the hub then treats every state as its own).
 */
export function makePublishedSitesLookup(opts: {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}): () => Promise<PublishedSites> {
  const ttl = opts.ttlMs ?? 5 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  let entry: { promise: Promise<PublishedSites>; expires: number } | null = null;
  const load = async (): Promise<{ sites: PublishedSites; ok: boolean }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
    try {
      const res = await doFetch(
        `${opts.supabaseUrl.replace(/\/$/, "")}/rest/v1/state_sites?select=state,hostname&published=eq.true`,
        { headers: { apikey: opts.anonKey, Authorization: `Bearer ${opts.anonKey}` }, signal: ctrl.signal },
      );
      if (!res.ok) return { sites: {}, ok: false };
      return { sites: publishedSitesFrom((await res.json()) as { state?: string; hostname?: string }[]), ok: true };
    } catch {
      return { sites: {}, ok: false };
    } finally {
      clearTimeout(timer);
    }
  };
  return () => {
    if (entry && entry.expires > now()) return entry.promise;
    const e = { promise: null as unknown as Promise<PublishedSites>, expires: Infinity };
    e.promise = load().then((r) => {
      e.expires = now() + (r.ok ? ttl : 30_000);
      return r.sites;
    });
    entry = e;
    return e.promise;
  };
}

/** Async hostname → state code resolver (the Worker's state_sites lookup). */
export type HostLookup = (hostname: string) => Promise<string | null>;

/**
 * Hostname → state via the tracker project's public `state_sites` table,
 * cached per hostname for `ttlMs` (5 minutes by default) so a busy site
 * costs one REST call per isolate per window. Any failure is a null: the
 * caller falls back to SINGLE_STATE_HOSTS (empty) and then the hub, never an error.
 */
export function makeStateSitesLookup(opts: {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /** How long a failed lookup is remembered (default 30 s). */
  errorTtlMs?: number;
  /** Abort a lookup that takes longer than this (default 1500 ms). */
  timeoutMs?: number;
  now?: () => number;
}): HostLookup {
  const ttl = opts.ttlMs ?? 5 * 60 * 1000;
  const errorTtl = opts.errorTtlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const MAX_ENTRIES = 500;
  // `expires` is Infinity while the fetch is in flight, so concurrent callers
  // share its promise; it is set to the real expiry when the fetch settles.
  const cache = new Map<string, { promise: Promise<string | null>; expires: number }>();
  let warned = false;

  const warnOnce = (msg: string) => {
    if (warned) return;
    warned = true;
    console.warn(`state_sites lookup failed: ${msg}`);
  };

  const fetchState = async (host: string): Promise<{ state: string | null; ok: boolean }> => {
    // AbortController + timer rather than AbortSignal.timeout: the latter is
    // missing from some runtimes (jsdom), and this clears its timer.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url =
        `${opts.supabaseUrl.replace(/\/$/, "")}/rest/v1/state_sites` +
        `?select=state&hostname=eq.${encodeURIComponent(host)}&published=eq.true&limit=1`;
      const res = await doFetch(url, {
        headers: { apikey: opts.anonKey, Authorization: `Bearer ${opts.anonKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        warnOnce(`HTTP ${res.status}`);
        return { state: null, ok: false };
      }
      const rows = (await res.json()) as { state?: string }[];
      const code = (rows[0]?.state ?? "").toLowerCase();
      return { state: CODE_RE.test(code) ? code : null, ok: true };
    } catch (e) {
      warnOnce(e instanceof Error ? e.message : String(e));
      return { state: null, ok: false };
    } finally {
      clearTimeout(timer);
    }
  };

  return async (hostname: string) => {
    const host = normalizeHost(hostname);
    if (!host) return null;
    const hit = cache.get(host);
    if (hit && hit.expires > now()) return hit.promise;
    if (cache.size >= MAX_ENTRIES) cache.clear();
    const entry = { promise: null as unknown as Promise<string | null>, expires: Infinity };
    entry.promise = fetchState(host).then((r) => {
      entry.expires = now() + (r.ok ? ttl : errorTtl);
      return r.state;
    });
    cache.set(host, entry);
    return entry.promise;
  };
}

/**
 * resolveSiteState with the state_sites lookup in the middle: override →
 * saved hostname → SINGLE_STATE_HOSTS → hub. The Worker uses this; the SPA
 * keeps the synchronous version because the Worker already injected the pin.
 */
export async function resolveSiteStateAsync(opts: {
  override?: string | null;
  hostname?: string | null;
  lookup?: HostLookup;
}): Promise<string | null> {
  const o = (opts.override ?? "").trim().toLowerCase();
  if (o) return CODE_RE.test(o) ? o : null;
  if (opts.lookup && opts.hostname) {
    const found = await opts.lookup(normalizeHost(opts.hostname));
    if (found) return found;
  }
  return siteStateForHost(opts.hostname);
}

/**
 * URL prefix for a state's pages: "" on that state's dedicated site,
 * "/<code>" everywhere else.
 */
export function statePathFor(siteState: string | null, code: string): string {
  return siteState === code ? "" : `/${code}`;
}

/** Brand name rendered in the header, footer, titles. */
export function siteNameFor(stateName: string | null | undefined): string {
  return stateName ? `${stateName} Politics Tracker` : "State Politics Tracker";
}
