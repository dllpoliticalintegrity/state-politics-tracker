// SEO logic shared by both deploy targets:
//  - functions/_middleware.ts + functions/sitemap.xml.ts (Cloudflare Pages)
//  - worker/index.ts (Cloudflare Workers with static assets)
//
// Phase 1 covers the landing page only; per-state routes get registry-driven
// metadata in Phase 3 (see docs/plan.md). Canonical URLs derive from the
// request origin, so no domain is hardcoded before one is chosen.

export type RouteMeta = {
  title: string;
  description: string;
  h1: string;
  body: string;
};

export const STATIC_ROUTES: Record<string, RouteMeta> = {
  "/": {
    title: "State Politics Tracker — Money & Polling in 2026 Statewide Races",
    description:
      "Follow the money and polling in 2026 statewide races across the country — governor on down. Campaign-finance data from state disclosure agencies, polling averages, and outside spending.",
    h1: "State Politics Tracker — Follow the Money in Your State",
    body: `
      <p>State Politics Tracker is a public-interest dashboard for 2026 statewide races. We pull primary-source campaign-finance filings from each state's disclosure agency, surface outside spending, and aggregate public polling for every statewide race on the ballot — governor, attorney general, and the rest of the row offices — so you can see how money and momentum are moving, state by state.</p>
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

export function rewriteHtml(html: string, meta: RouteMeta, canonical: string): string {
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

export function isAssetPath(pathname: string): boolean {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return ext.length > 0 && ext !== "html" && ext !== "htm";
}

/** Rewrites an HTML response for known routes; passes everything else through. */
export async function applySeoRewrite(
  request: Request,
  response: Response,
): Promise<Response> {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("text/html")) return response;

  const url = new URL(request.url);
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
}

const SITEMAP_PATHS: Array<{ path: string; priority: string; changefreq: string }> = [
  { path: "/", priority: "1.0", changefreq: "daily" },
];

export function sitemapResponse(origin: string): Response {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map(
    ({ path, priority, changefreq }) =>
      `  <url>\n    <loc>${origin}${path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
  );
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
