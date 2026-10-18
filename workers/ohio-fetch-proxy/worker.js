// Fetch proxy for the Ohio Secretary of State's campaign-finance bulk files.
//
// STATUS (2026-10-18): does not work once deployed. It pulled every file in
// a `wrangler dev --remote` preview, but ohiosos.gov answers 403 to the
// deployed Worker: the site is on Cloudflare and blocks subrequests from
// other zones' Workers (cf.worker.upstream_zone). Kept for the record; the
// scraper only uses it when OHIO_FETCH_PROXY is set, which it is not.
//
// ohiosos.gov answers 403 to GitHub's hosted runners (an IP-range block;
// browser impersonation makes no difference), but Cloudflare's network gets
// the pages and files with a plain fetch (tested 2026-10-18). The nightly
// finance sync therefore asks this Worker to fetch each Ohio URL for it:
//
//   GET https://<worker>/?url=https%3A%2F%2Fwww6.ohiosos.gov%2Fords%2Ff%3Fp%3D...
//   Authorization: Bearer <PROXY_TOKEN>
//
// Only https://www6.ohiosos.gov/ URLs are fetched, only with GET, and only
// with the shared secret. The upstream body is streamed back unchanged with
// its status and content type; the final upstream URL (after redirects)
// rides in x-proxy-final-url so the scraper can resolve relative links.
//
// Deploy from this directory:  npx wrangler deploy
// Secret:                      npx wrangler secret put PROXY_TOKEN
// Then set the GitHub repository variable OHIO_FETCH_PROXY to the Worker's
// URL and the secret OHIO_FETCH_PROXY_TOKEN to the same token.

const ALLOWED_PREFIX = "https://www6.ohiosos.gov/";

const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73",
};

function authorized(request, env) {
  const expected = env.PROXY_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") return new Response("GET only", { status: 405 });
    if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });

    const target = new URL(request.url).searchParams.get("url") || "";
    if (!target.startsWith(ALLOWED_PREFIX)) return new Response("url not allowed", { status: 400 });

    const upstream = await fetch(target, {
      method: "GET",
      headers: UPSTREAM_HEADERS,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const headers = new Headers();
    for (const name of ["content-type", "content-length", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-proxy-final-url", upstream.url || target);
    headers.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
