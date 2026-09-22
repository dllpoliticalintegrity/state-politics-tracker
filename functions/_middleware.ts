// Cloudflare Pages middleware (classic Pages deploy target). Applies the
// shared SEO rewrites to HTML responses on known routes; see shared/seo.ts.
// A SITE_STATE environment variable (or a dedicated hostname — shared/site.ts)
// pins the deployment to one state's site.

import { applySeoRewrite, isAssetPath } from "../shared/seo";
import { normalizeHost, resolveSiteState, siteStateForHost } from "../shared/site";

type MiddlewareContext = {
  request: Request;
  env?: { SITE_STATE?: string };
  next: () => Promise<Response>;
};

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const { request, env, next } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const url = new URL(request.url);
  if (url.hostname.startsWith("www.") && siteStateForHost(url.hostname)) {
    url.hostname = normalizeHost(url.hostname);
    return Response.redirect(url.toString(), 301);
  }
  if (isAssetPath(url.pathname)) return next();

  const response = await next();
  return applySeoRewrite(
    request,
    response,
    resolveSiteState({ override: env?.SITE_STATE, hostname: url.hostname }),
  );
};
