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
  llmsResponse,
  robotsResponse,
  sitemapResponse,
} from "../shared/seo";
import { normalizeHost, resolveSiteState, siteStateForHost } from "../shared/site";

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** Two-letter code pinning this Worker to one state's site; unset = hub. */
  SITE_STATE?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // www.michiganpoliticstracker.com → michiganpoliticstracker.com, so the
    // dedicated sites have one canonical host.
    if (url.hostname.startsWith("www.") && siteStateForHost(url.hostname)) {
      url.hostname = normalizeHost(url.hostname);
      return Response.redirect(url.toString(), 301);
    }

    const siteState = resolveSiteState({ override: env.SITE_STATE, hostname: url.hostname });

    if (url.pathname === "/sitemap.xml") return sitemapResponse(url.origin, siteState);
    if (url.pathname === "/robots.txt") return robotsResponse(url.origin);
    if (url.pathname === "/llms.txt") {
      const generated = llmsResponse(siteState);
      if (generated) return generated;
    }

    const response = await env.ASSETS.fetch(request);

    if (request.method !== "GET" && request.method !== "HEAD") return response;
    if (isAssetPath(url.pathname)) return response;
    return applySeoRewrite(request, response, siteState);
  },
};
