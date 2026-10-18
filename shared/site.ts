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
//      `state_sites` table (Worker only, via resolveSiteStateAsync);
//   3. the request hostname, looked up in SINGLE_STATE_HOSTS.
// Anything else is the multi-state hub.

/** Production hostnames of the dedicated per-state sites → state code. */
export const SINGLE_STATE_HOSTS: Record<string, string> = {
  "michiganpoliticstracker.com": "mi",
  // Like michiganpoliticstracker.com, attached as a custom domain to the main
  // state-politics-tracker Worker, which pins the state from the hostname —
  // so every deploy of main updates both dedicated sites with the hub.
  "texaspoliticstracker.com": "tx",
  // Same arrangement, since Oct 2026 (it was the ca-poll-boost site).
  "cagovtracker.com": "ca",
};

/** Public URL of each dedicated site, for cross-links from the hub. */
export const SINGLE_STATE_SITES: Record<string, string> = Object.fromEntries(
  Object.entries(SINGLE_STATE_HOSTS).map(([host, code]) => [code, `https://${host}`]),
);

/**
 * The multi-state hub's public URL, for "All states" links on a dedicated
 * site. Null until the hub has a domain (docs/bootstrap-checklist.md, Phase 3);
 * chrome hides those links while it is null.
 */
export const HUB_URL: string | null = null;

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

/** Async hostname → state code resolver (the Worker's state_sites lookup). */
export type HostLookup = (hostname: string) => Promise<string | null>;

/**
 * Hostname → state via the tracker project's public `state_sites` table,
 * cached per hostname for `ttlMs` (5 minutes by default) so a busy site
 * costs one REST call per isolate per window. Any failure is a null: the
 * caller falls back to SINGLE_STATE_HOSTS and then the hub, never an error.
 */
export function makeStateSitesLookup(opts: {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): HostLookup {
  const ttl = opts.ttlMs ?? 5 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, { state: string | null; expires: number }>();
  let warned = false;

  return async (hostname: string) => {
    const host = normalizeHost(hostname);
    if (!host) return null;
    const hit = cache.get(host);
    if (hit && hit.expires > now()) return hit.state;
    let state: string | null = null;
    try {
      const url =
        `${opts.supabaseUrl.replace(/\/$/, "")}/rest/v1/state_sites` +
        `?select=state&hostname=eq.${encodeURIComponent(host)}&limit=1`;
      const res = await doFetch(url, {
        headers: { apikey: opts.anonKey, Authorization: `Bearer ${opts.anonKey}` },
      });
      if (res.ok) {
        const rows = (await res.json()) as { state?: string }[];
        const code = (rows[0]?.state ?? "").toLowerCase();
        state = CODE_RE.test(code) ? code : null;
      } else if (!warned) {
        warned = true;
        console.warn(`state_sites lookup failed: HTTP ${res.status}`);
      }
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn(`state_sites lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    cache.set(host, { state, expires: now() + ttl });
    return state;
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
