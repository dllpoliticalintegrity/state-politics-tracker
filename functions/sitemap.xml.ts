// Cloudflare Pages Function for /sitemap.xml.
//
// Without this, Cloudflare Pages serves the SPA's index.html for any unknown
// path, so /sitemap.xml would return HTML that Search Console rejects. This
// returns a real urlset XML document with the correct MIME type.
//
// Phase 1 lists the landing page only; per-state entries come from the state
// registry once states go live (Phase 3, see docs/plan.md).

const STATIC_PATHS: Array<{
  path: string;
  priority: string;
  changefreq: string;
}> = [{ path: "/", priority: "1.0", changefreq: "daily" }];

export const onRequest = async (context: {
  request: Request;
}): Promise<Response> => {
  const origin = new URL(context.request.url).origin;
  const today = new Date().toISOString().slice(0, 10);

  const urls = STATIC_PATHS.map(
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
};
