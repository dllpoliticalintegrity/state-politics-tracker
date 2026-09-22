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
//   2. the request hostname, looked up in SINGLE_STATE_HOSTS.
// Anything else is the multi-state hub.

/** Production hostnames of the dedicated per-state sites → state code. */
export const SINGLE_STATE_HOSTS: Record<string, string> = {
  "michiganpoliticstracker.com": "mi",
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
