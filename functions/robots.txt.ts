// Cloudflare Pages Function for /robots.txt (classic Pages deploy target).
// Generated so the Sitemap line points at whichever origin is serving the
// site — the hub or a dedicated state site; see shared/seo.ts.

import { robotsResponse } from "../shared/seo";
import { resolveSiteState } from "../shared/site";

export const onRequest = async (context: {
  request: Request;
  env?: { SITE_STATE?: string };
}): Promise<Response> => {
  const url = new URL(context.request.url);
  return robotsResponse(
    url.origin,
    resolveSiteState({ override: context.env?.SITE_STATE, hostname: url.hostname }),
  );
};
