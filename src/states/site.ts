// Which site this bundle is running as: the multi-state hub, or one state's
// dedicated site (michiganpoliticstracker.com). Resolved once at load from
// the build-time VITE_SITE_STATE, the <meta name="site-state"> tag the
// Worker injects, or the hostname — see shared/site.ts for the rules.

import {
  HUB_URL,
  SITE_STATE_META,
  resolveSiteState,
  siteNameFor,
  statePathFor,
} from "../../shared/site";
import { getState, type StateConfig } from "./registry";

function metaOverride(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`meta[name="${SITE_STATE_META}"]`)?.getAttribute("content") ?? null;
}

function resolve(): StateConfig | null {
  const code = resolveSiteState({
    override: (import.meta.env.VITE_SITE_STATE as string | undefined) || metaOverride(),
    hostname: typeof window !== "undefined" ? window.location.hostname : null,
  });
  if (!code) return null;
  const cfg = getState(code);
  if (!cfg || cfg.status !== "live" || !cfg.races?.length) {
    // A dedicated site only makes sense for a live state; fall back to the
    // hub rather than render an empty shell.
    console.warn(`site-state "${code}" is not a live state — running as the hub`);
    return null;
  }
  return cfg;
}

/** The pinned state on a dedicated site; null on the hub. */
export const SITE_STATE: StateConfig | null = resolve();

export const isSingleStateSite = SITE_STATE !== null;

/** "Michigan Politics Tracker" on the dedicated site, "State Politics Tracker" on the hub. */
export const SITE_NAME = siteNameFor(SITE_STATE?.name);

/** Where "All states" should point from this site, if anywhere. */
export const ALL_STATES_URL: string | null = SITE_STATE ? HUB_URL : "/";

/** URL prefix for a state's pages on this site ("" for the pinned state). */
export function statePath(code: string): string {
  return statePathFor(SITE_STATE?.code ?? null, code);
}
