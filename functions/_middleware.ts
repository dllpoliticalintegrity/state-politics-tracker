// Cloudflare Pages middleware that runs before every asset is served.
//
// For HTML responses on known routes it rewrites the <title>, description,
// og/twitter meta, and canonical link, and injects a hidden #ssr-content
// block before #root containing real <h1> and body copy, so search engines'
// no-JS first pass sees actual content per route.
//
// Phase 1 covers the landing page only; per-state routes get registry-driven
// metadata in Phase 3 (see docs/plan.md). Canonical URLs derive from the
// request origin, so no domain is hardcoded before one is chosen.

type MiddlewareContext = {
  request: Request;
  next: () => Promise<Response>;
};

type RouteMeta = {
  title: string;
  description: string;
  h1: string;
  body: string;
};

const STATIC_ROUTES: Record<string, RouteMeta> = {
  "/": {
    title: "State Politics Tracker — Money & Polling in 2026 Statewide Races",
    description:
      "Follow the money and polling in 2026 governor's races across the country. Campaign-finance data from state disclosure agencies, polling averages, and outside spending.",
    h1: "State Politics Tracker — Follow the Money in Your State",
    body: `
      <p>State Politics Tracker is a public-interest dashboard for 2026 statewide races. We pull primary-source campaign-finance filings from each state's disclosure agency, surface outside spending, and aggregate public polling so you can see how money and momentum are moving — state by state.</p>
      <p>Texas and California are tracked on separate sites: <a href="https://texaspoliticstracker.com">texaspoliticstracker.com</a> covers the 2026 Texas Governor's race.</p>
    `,
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSsrBlock(meta: RouteMeta): string {
  return `<div id="ssr-content" style="display:none" aria-hidden="true">
    <h1>${escapeHtml(meta.h1)}</h1>
    ${meta.body.trim()}
  </div>`;
}

function rewriteHtml(html: string, meta: RouteMeta, canonical: string): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);

  let out = html;

  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  if (/<meta\s+name=["']description["'][^>]*>/i.test(out)) {
    out = out.replace(
      /<meta\s+name=["']description["'][^>]*>/i,
      `<meta name="description" content="${description}">`,
    );
  } else {
    out = out.replace(
      /<\/head>/i,
      `  <meta name="description" content="${description}">\n</head>`,
    );
  }

  out = out.replace(
    /<meta\s+property=["']og:title["'][^>]*>/i,
    `<meta property="og:title" content="${title}">`,
  );
  out = out.replace(
    /<meta\s+name=["']twitter:title["'][^>]*>/i,
    `<meta name="twitter:title" content="${title}">`,
  );
  out = out.replace(
    /<meta\s+property=["']og:description["'][^>]*>/i,
    `<meta property="og:description" content="${description}">`,
  );
  out = out.replace(
    /<meta\s+name=["']twitter:description["'][^>]*>/i,
    `<meta name="twitter:description" content="${description}">`,
  );

  // Add og:url + canonical (idempotent: only if not already present).
  if (!/<link\s+rel=["']canonical["']/i.test(out)) {
    out = out.replace(
      /<\/head>/i,
      `  <meta property="og:url" content="${canonical}">\n  <link rel="canonical" href="${canonical}">\n</head>`,
    );
  }

  out = out.replace(
    /<div\s+id=["']root["']\s*><\/div>/i,
    `${buildSsrBlock(meta)}\n    <div id="root"></div>`,
  );

  return out;
}

function isAssetPath(pathname: string): boolean {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return ext.length > 0 && ext !== "html" && ext !== "htm";
}

export const onRequest = async (context: MiddlewareContext): Promise<Response> => {
  const { request, next } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const url = new URL(request.url);

  if (isAssetPath(url.pathname)) return next();

  const response = await next();
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("text/html")) return response;

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const meta = STATIC_ROUTES[pathname];
  if (!meta) return response;

  const canonical = `${url.origin}${pathname}`;
  const html = await response.text();
  const rewritten = rewriteHtml(html, meta, canonical);

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
