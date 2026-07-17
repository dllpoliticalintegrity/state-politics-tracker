// Cloudflare Pages Function for /sitemap.xml (classic Pages deploy target).
// Returns a real urlset XML document instead of the SPA fallback HTML, which
// Search Console would reject; see shared/seo.ts.

import { sitemapResponse } from "../shared/seo";

export const onRequest = async (context: {
  request: Request;
}): Promise<Response> => {
  return sitemapResponse(new URL(context.request.url).origin);
};
