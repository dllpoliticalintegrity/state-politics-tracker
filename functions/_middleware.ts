// Cloudflare Pages middleware (classic Pages deploy target). Applies the
// shared SEO rewrites to HTML responses on known routes; see shared/seo.ts.

import { applySeoRewrite, isAssetPath } from "../shared/seo";

type MiddlewareContext = {
  request: Request;
  next: () => Promise<Response>;
};

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const { request, next } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const url = new URL(request.url);
  if (isAssetPath(url.pathname)) return next();

  const response = await next();
  return applySeoRewrite(request, response);
};
