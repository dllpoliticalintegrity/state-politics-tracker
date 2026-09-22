// Cloudflare Pages Function for /robots.txt (classic Pages deploy target).
// Generated so the Sitemap line points at whichever origin is serving the
// site — the hub or a dedicated state site; see shared/seo.ts.

import { robotsResponse } from "../shared/seo";

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  return robotsResponse(new URL(context.request.url).origin);
};
