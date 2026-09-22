import { describe, it, expect } from "vitest";
import {
  STATIC_ROUTES,
  applySeoRewrite,
  humanizeSlug,
  injectSiteState,
  llmsResponse,
  rewriteHtml,
  routeMeta,
  singleStateRoutes,
  sitemapEntries,
  sitemapResponse,
} from "../../shared/seo";
import { getState, liveStates } from "@/states/registry";

const INDEX_HTML = `<!doctype html><html><head><title>State Politics Tracker — Money & Polling in 2026 Statewide Races</title>
<meta name="description" content="hub description">
<meta property="og:title" content="hub">
</head><body><div id="root"></div></body></html>`;

describe("hub metadata (unchanged behaviour)", () => {
  it("serves the landing page only", () => {
    expect(routeMeta("/", null)).toBe(STATIC_ROUTES["/"]);
    expect(routeMeta("/mi", null)).toBeNull();
    expect(routeMeta("/mi/governor", null)).toBeNull();
    expect(sitemapEntries(null).map((e) => e.path)).toEqual(["/"]);
    expect(llmsResponse(null)).toBeNull();
  });

  it("passes hub HTML through untouched when the route has no metadata", async () => {
    const req = new Request("https://hub.example/mi/governor");
    const res = new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
    expect(await applySeoRewrite(req, res, null)).toBe(res);
  });
});

describe("single-state metadata", () => {
  const mi = getState("mi")!;

  it("builds a route table for every live state from the registry", () => {
    for (const s of liveStates()) {
      const routes = singleStateRoutes(s.code)!;
      expect(routes["/"].title).toContain(`${s.name} Politics Tracker`);
      expect(routes["/about"]).toBeTruthy();
      for (const r of s.races!) {
        expect(routes[`/${r.office}`].title).toContain(`${s.name} ${r.title}`);
        expect(routes[`/${r.office}/candidates`]).toBeTruthy();
        expect(routes[`/${r.office}/money/donors`]).toBeTruthy();
        expect(routes[`/${r.office}/money/outside-spending`]).toBeTruthy();
        // Polling pages exist only where the race has a 270toWin source.
        expect(!!routes[`/${r.office}/polling`]).toBe(!!r.pollingSourceUrl);
      }
    }
    expect(singleStateRoutes("tx")).toBeNull();
    expect(singleStateRoutes("zz")).toBeNull();
  });

  it("titles Michigan's pages after the state and the race", () => {
    expect(routeMeta("/", "mi")!.title).toBe(
      "Michigan Politics Tracker — Money & Polling in Michigan's 2026 Statewide Races",
    );
    expect(routeMeta("/", "mi")!.description).toContain("Governor, Attorney General and Secretary of State");
    expect(routeMeta("/governor", "mi")!.title).toBe(
      "Michigan Governor 2026 Race — Polls & Campaign Finance | Michigan Politics Tracker",
    );
    expect(routeMeta("/governor/", "mi")).toBe(routeMeta("/governor", "mi"));
    expect(routeMeta("/attorney-general/money/donors", "mi")!.h1).toBe(
      "Michigan Attorney General 2026: Top Donors",
    );
    // The hub landing page has no counterpart on a dedicated site.
    expect(routeMeta("/mi", "mi")).toBeNull();
    expect(routeMeta("/mi/governor", "mi")).toBeNull();
  });

  it("gives candidate profiles a per-slug title", () => {
    const meta = routeMeta("/governor/candidates/jocelyn-benson", "mi")!;
    expect(meta.title).toBe(
      "Jocelyn Benson — Michigan Governor 2026 Candidate | Michigan Politics Tracker",
    );
    expect(meta.description).toContain(mi.agency!.name);
    expect(routeMeta("/nope/candidates/someone", "mi")).toBeNull();
    expect(humanizeSlug("garlin-gilchrist")).toBe("Garlin Gilchrist");
  });

  it("escapes HTML in generated bodies", () => {
    const meta = routeMeta("/governor/candidates/x-<script>", "mi");
    // Slug charset is [a-z0-9-], so a hostile slug never matches at all.
    expect(meta).toBeNull();
    for (const m of Object.values(singleStateRoutes("mi")!)) {
      expect(m.body).not.toMatch(/<script/i);
    }
  });

  it("lists every Michigan page in the sitemap, home first", () => {
    const paths = sitemapEntries("mi").map((e) => e.path);
    expect(paths[0]).toBe("/");
    expect(paths).toContain("/governor");
    expect(paths).toContain("/governor/polling");
    expect(paths).not.toContain("/attorney-general/polling");
    expect(paths).toContain("/secretary-of-state/money/outside-spending");
    expect(paths).toContain("/about");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("emits absolute sitemap URLs for the requesting origin", async () => {
    const xml = await sitemapResponse("https://michiganpoliticstracker.com", "mi").text();
    expect(xml).toContain("<loc>https://michiganpoliticstracker.com/governor</loc>");
    expect(xml).not.toContain("/mi/governor");
    const hub = await sitemapResponse("https://hub.example", null).text();
    expect(hub.match(/<loc>/g)).toHaveLength(1);
  });

  it("generates a Michigan llms.txt", async () => {
    const txt = await llmsResponse("mi")!.text();
    expect(txt.startsWith("# Michigan Politics Tracker")).toBe(true);
    expect(txt).toContain("(/governor/candidates)");
    expect(txt).toContain(mi.agency!.name);
  });
});

describe("HTML rewriting", () => {
  it("rewrites title, description and canonical for a known route", () => {
    const out = rewriteHtml(INDEX_HTML, routeMeta("/governor", "mi")!, "https://michiganpoliticstracker.com/governor");
    expect(out).toContain("<title>Michigan Governor 2026 Race — Polls &amp; Campaign Finance | Michigan Politics Tracker</title>");
    expect(out).toContain('<link rel="canonical" href="https://michiganpoliticstracker.com/governor">');
    expect(out).toContain('<div id="ssr-content"');
  });

  it("pins the SPA's state with a meta tag, once", () => {
    const once = injectSiteState(INDEX_HTML, "mi");
    expect(once).toContain('<meta name="site-state" content="mi">');
    expect(injectSiteState(once, "mi")).toBe(once);
  });

  it("pins every HTML page on a single-state site, metadata or not", async () => {
    const res = () => new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    const known = await applySeoRewrite(new Request("https://michiganpoliticstracker.com/governor"), res(), "mi");
    const knownHtml = await known.text();
    expect(knownHtml).toContain('content="mi"');
    expect(knownHtml).toContain("Michigan Governor 2026");

    const unknown = await applySeoRewrite(new Request("https://michiganpoliticstracker.com/no-such-page"), res(), "mi");
    const unknownHtml = await unknown.text();
    expect(unknownHtml).toContain('content="mi"');
    expect(unknownHtml).toContain("<title>State Politics Tracker"); // untouched title

    const asset = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(await applySeoRewrite(new Request("https://michiganpoliticstracker.com/x.json"), asset, "mi")).toBe(asset);
  });
});
