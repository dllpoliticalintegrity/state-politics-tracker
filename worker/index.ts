// Cloudflare Worker entry for the Workers-with-static-assets deploy target
// (`npx wrangler deploy`, or `--env michigan` for michiganpoliticstracker.com).
// Serves the built SPA from the assets binding and applies the same SEO
// rewrites, sitemap, robots.txt and llms.txt as the Pages functions do.
//
// The same build serves the multi-state hub and the dedicated single-state
// sites: which one a request gets is decided per request by the SITE_STATE
// var (set per wrangler environment) or the hostname — see shared/site.ts.

import {
  applySeoRewrite,
  isAssetPath,
  legacyRedirectResponse,
  llmsResponse,
  robotsResponse,
  sitemapResponse,
} from "../shared/seo";
import { makeStateSitesLookup, normalizeHost, resolveSiteStateAsync } from "../shared/site";

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** Two-letter code pinning this Worker to one state's site; unset = hub. */
  SITE_STATE?: string;
  /** Optional overrides for a preview against another project. */
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

const DEFAULT_SUPABASE_URL = "https://lohxdfrxnxuxjdvvyfjc.supabase.co";
const DEFAULT_ANON_KEY = "sb_publishable_r8D7t0Stine_UgCoU_ps8g_UDRKSpoX";

// One lookup (and one cache) per isolate.
let lookup: ReturnType<typeof makeStateSitesLookup> | null = null;
function hostLookup(env: Env) {
  if (!lookup) {
    lookup = makeStateSitesLookup({
      supabaseUrl: env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY ?? DEFAULT_ANON_KEY,
    });
  }
  return lookup;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const siteState = await resolveSiteStateAsync({
      override: env.SITE_STATE,
      hostname: url.hostname,
      lookup: hostLookup(env),
    });

    // www.<site> → <site>, so each dedicated site has one canonical host.
    if (url.hostname.startsWith("www.") && siteState) {
      url.hostname = normalizeHost(url.hostname);
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/sitemap.xml") return sitemapResponse(url.origin, siteState);
    if (url.pathname === "/robots.txt") return robotsResponse(url.origin);
    if (url.pathname === "/llms.txt") {
      const generated = llmsResponse(siteState);
      if (generated) return generated;
    }
    const legacy = legacyRedirectResponse(url, siteState);
    if (legacy) return legacy;

    const response = await env.ASSETS.fetch(request);

    if (request.method !== "GET" && request.method !== "HEAD") return response;
    if (isAssetPath(url.pathname)) return response;
    return applySeoRewrite(request, response, siteState);
  },
};
