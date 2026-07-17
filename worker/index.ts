// Cloudflare Worker entry for the Workers-with-static-assets deploy target
// (`npx wrangler deploy`). Serves the built SPA from the assets binding and
// applies the same SEO rewrites and sitemap as the Pages functions do.

import { applySeoRewrite, isAssetPath, sitemapResponse } from "../shared/seo";

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sitemap.xml") return sitemapResponse(url.origin);

    const response = await env.ASSETS.fetch(request);

    if (request.method !== "GET" && request.method !== "HEAD") return response;
    if (isAssetPath(url.pathname)) return response;
    return applySeoRewrite(request, response);
  },
};
