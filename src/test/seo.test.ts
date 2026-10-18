import { describe, it, expect } from "vitest";
import {
  STATIC_ROUTES,
  applySeoRewrite,
  humanizeSlug,
  injectSiteState,
  legacyRedirectResponse,
  llmsResponse,
  rewriteHtml,
  robotsResponse,
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

describe("hub metadata", () => {
  it("serves the landing page, and nothing for states that keep their own canonical", () => {
    expect(routeMeta("/", null)).toBe(STATIC_ROUTES["/"]);
    expect(routeMeta("/oh", null)).toBeNull();
    expect(routeMeta("/oh/governor", null)).toBeNull();
    expect(routeMeta("/ca/governor", null)).toBeNull();
    expect(llmsResponse(null)).toBeNull();
  });

  it("passes hub HTML through untouched when the route has no metadata", async () => {
    const req = new Request("https://hub.example/oh/governor");
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
        // Polling pages exist only where the race has a polling source.
        expect(!!routes[`/${r.office}/polling`]).toBe(!!r.pollingSourceUrl);
      }
    }
    expect(singleStateRoutes("ne")).toBeNull();
    expect(singleStateRoutes("zz")).toBeNull();
  });

  it("titles Michigan's pages after the state and the race", () => {
    expect(routeMeta("/", "mi")!.title).toBe(
      "Michigan Politics Tracker — Money & Polling in Michigan's 2026 Statewide Races",
    );
    expect(routeMeta("/", "mi")!.description).toContain(
      "Governor, Attorney General, Secretary of State, State Senate and State House",
    );
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
    const xml = await sitemapResponse("https://ohiopoliticstracker.com", "oh").text();
    expect(xml).toContain("<loc>https://ohiopoliticstracker.com/governor</loc>");
    expect(xml).not.toContain("/oh/governor");
    const hub = await sitemapResponse("https://hub.example", null).text();
    expect(hub).toContain("<loc>https://hub.example/</loc>");
    expect(hub).not.toContain("hub.example/oh");
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

describe("Texas on the hub", () => {
  it("credits each race's own polling source", () => {
    expect(routeMeta("/governor", "tx")!.description).toContain("Texas Ethics Commission and FiftyPlusOne");
    expect(routeMeta("/governor/polling", "tx")!.body).toContain("aggregated from FiftyPlusOne");
    expect(routeMeta("/lt-governor/polling", "tx")).toBeNull();
    expect(routeMeta("/about", "tx")!.body).toContain("polling comes from FiftyPlusOne");
    expect(routeMeta("/governor", "mi")!.description).toContain("and FiftyPlusOne");
    // Georgia reads the tracker again, so its polling is the FiftyPlusOne import.
    expect(routeMeta("/about", "ga")!.body).toContain("polling comes from FiftyPlusOne");
    expect(routeMeta("/governor/polling", "ga")!.body).toContain("aggregated from FiftyPlusOne");
    // Oregon still reads the Local Politics Tracker, polls included.
    expect(routeMeta("/governor/polling", "or")!.body).toContain("aggregated from Local Politics Tracker");
    // A hidden state has no routes at all.
    expect(routeMeta("/about", "hi")).toBeNull();
  });

  it("301s texaspoliticstracker.com's old URLs, and only on the Texas site", () => {
    const res = legacyRedirectResponse(new URL("https://texaspoliticstracker.com/money/river?kind=loan"), "tx")!;
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://texaspoliticstracker.com/governor/money/river?kind=loan");
    expect(legacyRedirectResponse(new URL("https://texaspoliticstracker.com/governor"), "tx")).toBeNull();
    expect(legacyRedirectResponse(new URL("https://hub.example/polling"), null)).toBeNull();
    expect(legacyRedirectResponse(new URL("https://michiganpoliticstracker.com/polling"), "mi")).toBeNull();
  });
});

describe("Michigan and Texas canonical on the hub", () => {
  it("titles the hub's copy for the hub, with links under the state", () => {
    const home = routeMeta("/mi", null)!;
    expect(home.title).toBe("State Politics Tracker — Money & Polling in Michigan's 2026 Statewide Races");
    expect(home.body).toContain('href="/mi/governor"');
    const gov = routeMeta("/mi/governor", null)!;
    expect(gov.title).toBe("Michigan Governor 2026 Race — Polls & Campaign Finance | State Politics Tracker");
    expect(gov.body).toContain('href="/mi/governor/candidates"');
    expect(routeMeta("/tx/governor/", null)!.title).toContain("| State Politics Tracker");
    expect(routeMeta("/mi/state-senate/11", null)!.body).toContain('href="/mi/state-senate/11/candidates"');
    expect(routeMeta("/mi/governor/candidates/jocelyn-benson", null)!.title)
      .toBe("Jocelyn Benson — Michigan Governor 2026 Candidate | State Politics Tracker");
    expect(routeMeta("/mi/no-such-page", null)).toBeNull();
    // The dedicated site keeps its own titles and unprefixed links.
    expect(routeMeta("/governor", "mi")!.title).toContain("| Michigan Politics Tracker");
    expect(routeMeta("/", "mi")!.body).toContain('href="/governor"');
  });

  it("points the dedicated site's canonical at the hub's copy", async () => {
    const res = () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
    const mi = await (await applySeoRewrite(new Request("https://michiganpoliticstracker.com/governor/polling"), res(), "mi")).text();
    expect(mi).toContain('<link rel="canonical" href="https://statepoliticstracker.com/mi/governor/polling">');
    expect(mi).toContain('<meta property="og:url" content="https://statepoliticstracker.com/mi/governor/polling">');
    const txHome = await (await applySeoRewrite(new Request("https://texaspoliticstracker.com/"), res(), "tx")).text();
    expect(txHome).toContain('<link rel="canonical" href="https://statepoliticstracker.com/tx">');
    const hub = await (await applySeoRewrite(new Request("https://statepoliticstracker.com/mi/governor"), res(), null)).text();
    expect(hub).toContain('<link rel="canonical" href="https://statepoliticstracker.com/mi/governor">');
    expect(hub).not.toContain('name="site-state"');
    // Other dedicated sites stay self-canonical.
    const oh = await (await applySeoRewrite(new Request("https://ohiopoliticstracker.com/governor"), res(), "oh")).text();
    expect(oh).toContain('<link rel="canonical" href="https://ohiopoliticstracker.com/governor">');
  });

  it("lists the hub's Michigan and Texas pages in the hub sitemap", () => {
    const paths = sitemapEntries(null).map((e) => e.path);
    expect(paths[0]).toBe("/");
    expect(paths).toContain("/mi");
    expect(paths).toContain("/mi/governor/polling");
    expect(paths).toContain("/tx/governor");
    expect(paths).toContain("/mi/state-senate/11");
    expect(paths.some((p) => p.startsWith("/oh"))).toBe(false);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("sends the dedicated sites' sitemap and robots to the hub", async () => {
    const sm = sitemapResponse("https://michiganpoliticstracker.com", "mi");
    expect(sm.status).toBe(301);
    expect(sm.headers.get("location")).toBe("https://statepoliticstracker.com/sitemap.xml");
    const robots = await robotsResponse("https://texaspoliticstracker.com", "tx").text();
    expect(robots).toContain("Sitemap: https://statepoliticstracker.com/sitemap.xml");
    const oh = await robotsResponse("https://ohiopoliticstracker.com", "oh").text();
    expect(oh).toContain("Sitemap: https://ohiopoliticstracker.com/sitemap.xml");
  });
});
