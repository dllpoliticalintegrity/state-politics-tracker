// Cloudflare Pages Function for /llms.txt (classic Pages deploy target).
// A single-state site gets a generated, state-specific file; the hub falls
// through to the static public/llms.txt. See shared/seo.ts.

import { llmsResponse } from "../shared/seo";
import { resolveSiteState } from "../shared/site";

export const onRequest = async (context: {
  request: Request;
  env?: { SITE_STATE?: string };
  next: () => Promise<Response>;
}): Promise<Response> => {
  const url = new URL(context.request.url);
  const generated = llmsResponse(
    resolveSiteState({ override: context.env?.SITE_STATE, hostname: url.hostname }),
  );
  return generated ?? context.next();
};
