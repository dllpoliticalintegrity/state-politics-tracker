// Cloudflare Pages Function for /sitemap.xml (classic Pages deploy target).
// Returns a real urlset XML document instead of the SPA fallback HTML, which
// Search Console would reject; see shared/seo.ts. On a single-state site the
// sitemap lists every race page.

import { sitemapResponse } from "../shared/seo";
import { resolveSiteState } from "../shared/site";

export const onRequest = async (context: {
  request: Request;
  env?: { SITE_STATE?: string };
}): Promise<Response> => {
  const url = new URL(context.request.url);
  return sitemapResponse(
    url.origin,
    resolveSiteState({ override: context.env?.SITE_STATE, hostname: url.hostname }),
  );
};
