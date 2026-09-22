// SEO logic shared by both deploy targets:
//  - functions/_middleware.ts + functions/sitemap.xml.ts (Cloudflare Pages)
//  - worker/index.ts (Cloudflare Workers with static assets)
// and by the SPA (src/App.tsx keeps document.title in step via routeMeta).
//
// Two route tables:
//  - the multi-state hub covers the landing page only (per-state hub routes
//    are Phase 3 — see docs/plan.md);
//  - a dedicated single-state site (shared/site.ts) gets registry-driven
//    metadata for its home, every race page, and the About page.
// Canonical URLs derive from the request origin, so no domain is hardcoded.

import { getState, type RaceConfig, type StateConfig } from "../src/states/registry";
import { SITE_STATE_META, siteNameFor } from "./site";

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

/** "jocelyn-benson" → "Jocelyn Benson" (for candidate-detail titles). */
export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function listOffices(races: RaceConfig[]): string {
  const titles = races.map((r) => r.title);
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

function raceLabel(state: StateConfig, race: RaceConfig): string {
  return `${state.name} ${race.title} ${race.generalDate.slice(0, 4)}`;
}

function liveState(code: string | null | undefined): StateConfig | null {
  const s = code ? getState(code) : undefined;
  return s && s.status === "live" && s.races?.length ? s : null;
}

const singleStateCache = new Map<string, Record<string, RouteMeta>>();

/**
 * Route table for a state's dedicated site, keyed by pathname. Built from the
 * registry so adding a race to LIVE_CONFIG is all it takes.
 */
export function singleStateRoutes(code: string): Record<string, RouteMeta> | null {
  const cached = singleStateCache.get(code);
  if (cached) return cached;
  const state = liveState(code);
  if (!state) return null;

  const site = siteNameFor(state.name);
  const races = state.races!;
  const agency = state.agency?.name ?? `${state.name}'s disclosure agency`;
  const routes: Record<string, RouteMeta> = {};

  routes["/"] = {
    title: `${site} — Money & Polling in ${state.name}'s 2026 Statewide Races`,
    description: `Follow the money and polling in ${state.name}'s 2026 ${listOffices(races)} races. Campaign-finance filings from the ${agency}, polling averages, and outside spending.`,
    h1: `${site} — Follow the Money in ${state.name}`,
    body: `
      <p>${escapeHtml(site)} is a public-interest dashboard for ${escapeHtml(state.name)}'s 2026 statewide races, from the Political Integrity Project. We pull primary-source campaign-finance filings from the ${escapeHtml(agency)}, surface outside spending, and aggregate public polling so you can see how money and momentum are moving in each race.</p>
      <ul>
        ${races
          .map(
            (r) =>
              `<li><a href="/${r.office}">${escapeHtml(raceLabel(state, r))}: polls, candidates and money</a></li>`,
          )
          .join("\n        ")}
      </ul>
    `,
  };

  for (const race of races) {
    const base = `/${race.office}`;
    const label = raceLabel(state, race);
    const polled = !!race.pollingSourceUrl;

    routes[base] = {
      title: `${label} Race — Polls & Campaign Finance | ${site}`,
      description: polled
        ? `Who's running for ${state.name} ${race.title} in ${race.generalDate.slice(0, 4)}, who leads the polling average, and who is funding each campaign — from the ${agency} and 270toWin.`
        : `Who's running for ${state.name} ${race.title} in ${race.generalDate.slice(0, 4)} and who is funding each campaign — itemized contributions and spending from the ${agency}.`,
      h1: `${label}: ${polled ? "Polls, Candidates & Money" : "Candidates & Money"}`,
      body: `
        <p>Track the ${escapeHtml(label)} race: the candidate field, ${polled ? "a polling average built from public general-election polls, " : ""}money raised and spent by each campaign, top donors, and outside spending — updated nightly from the ${escapeHtml(agency)}.</p>
        <ul>
          <li><a href="${base}/candidates">Candidates</a></li>
          ${polled ? `<li><a href="${base}/polling">Polling</a></li>` : ""}
          <li><a href="${base}/money/donors">Top donors</a></li>
          <li><a href="${base}/money/outside-spending">Outside spending</a></li>
        </ul>
      `,
    };
    routes[`${base}/candidates`] = {
      title: `${label} Candidates | ${site}`,
      description: `Every tracked candidate for ${state.name} ${race.title} in ${race.generalDate.slice(0, 4)}, with money raised, cash on hand${polled ? ", polling" : ""} and campaign details.`,
      h1: `${label} Candidates`,
      body: `<p>The field for ${escapeHtml(label)}, ranked by ${polled ? "polling average and " : ""}money raised, with a profile of each candidate's fundraising and spending.</p>`,
    };
    if (polled) {
      routes[`${base}/polling`] = {
        title: `${label} Polls & Polling Average | ${site}`,
        description: `Latest ${state.name} ${race.title} polls and a general-election polling average, with every poll listed by pollster and field dates.`,
        h1: `${label} Polls`,
        body: `<p>Public polling for ${escapeHtml(label)}, aggregated from 270toWin: individual polls plus a trailing general-election average.</p>`,
      };
    }
    routes[`${base}/money/donors`] = {
      title: `${label} Top Donors & Campaign Finance | ${site}`,
      description: `Who is funding the ${state.name} ${race.title} candidates: top individual and organizational donors, industries and totals from ${agency} filings.`,
      h1: `${label}: Top Donors`,
      body: `<p>Itemized contributions to every ${escapeHtml(label)} campaign committee, grouped by donor, as filed with the ${escapeHtml(agency)}.</p>`,
    };
    routes[`${base}/money/outside-spending`] = {
      title: `${label} Outside Spending & Independent Expenditures | ${site}`,
      description: `Independent expenditures for and against ${state.name} ${race.title} candidates, and who funds the committees behind them.`,
      h1: `${label}: Outside Spending`,
      body: `<p>Independent expenditures supporting or opposing ${escapeHtml(label)} candidates, and the donors behind the committees making them.</p>`,
    };
  }

  routes["/about"] = {
    title: `About & Methodology | ${site}`,
    description: `How ${site} sources ${state.name} campaign-finance filings from the ${agency}, aggregates polling, and computes the numbers on each race page.`,
    h1: `About ${site}`,
    body: `<p>${escapeHtml(site)} is a project of the Political Integrity Project. Campaign finance comes from the ${escapeHtml(agency)}'s public filings; polling comes from 270toWin. Data is presented as filed.</p>`,
  };

  singleStateCache.set(code, routes);
  return routes;
}

const CANDIDATE_DETAIL_RE = /^\/([a-z0-9-]+)\/candidates\/([a-z0-9-]+)$/;

/**
 * Metadata for a pathname on this site — the hub table when `siteState` is
 * null, the state's registry-driven table otherwise (candidate profiles get
 * a per-slug title). Null for paths with no dedicated metadata.
 */
export function routeMeta(pathname: string, siteState: string | null): RouteMeta | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (!siteState) return STATIC_ROUTES[path] ?? null;

  const routes = singleStateRoutes(siteState);
  if (!routes) return STATIC_ROUTES[path] ?? null;
  const exact = routes[path];
  if (exact) return exact;

  const m = CANDIDATE_DETAIL_RE.exec(path);
  if (m) {
    const state = liveState(siteState)!;
    const race = state.races!.find((r) => r.office === m[1]);
    if (race) {
      const name = humanizeSlug(m[2]);
      const label = raceLabel(state, race);
      const site = siteNameFor(state.name);
      return {
        title: `${name} — ${label} Candidate | ${site}`,
        description: `${name}'s campaign for ${state.name} ${race.title}: money raised, top donors, spending${race.pollingSourceUrl ? ", polling" : ""} and outside spending, from ${state.agency?.name ?? "state"} filings.`,
        h1: `${name} — ${label}`,
        body: `<p>Campaign-finance profile of ${escapeHtml(name)}, candidate for ${escapeHtml(label)}: contributions, top donors, expenditures and independent expenditures for and against.</p>`,
      };
    }
  }
  return null;
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

/**
 * Pin the SPA to a state: the bundle reads this tag before falling back to
 * the hostname (src/states/site.ts), so a *.workers.dev preview of the
 * Michigan Worker renders as Michigan too. Idempotent.
 */
export function injectSiteState(html: string, siteState: string): string {
  if (new RegExp(`<meta\\s+name=["']${SITE_STATE_META}["']`, "i").test(html)) return html;
  return html.replace(
    /<\/head>/i,
    `  <meta name="${SITE_STATE_META}" content="${escapeHtml(siteState)}">\n</head>`,
  );
}

export function isAssetPath(pathname: string): boolean {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return ext.length > 0 && ext !== "html" && ext !== "htm";
}

/**
 * Rewrites an HTML response: per-route metadata where the site has some,
 * plus the site-state pin on every HTML page of a single-state site. Passes
 * non-HTML (and hub pages without metadata) through untouched.
 */
export async function applySeoRewrite(
  request: Request,
  response: Response,
  siteState: string | null = null,
): Promise<Response> {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("text/html")) return response;

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const meta = routeMeta(pathname, siteState);
  if (!meta && !siteState) return response;

  let html = await response.text();
  if (meta) html = rewriteHtml(html, meta, `${url.origin}${pathname}`);
  if (siteState) html = injectSiteState(html, siteState);

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type SitemapEntry = { path: string; priority: string; changefreq: string };

const HUB_SITEMAP: SitemapEntry[] = [{ path: "/", priority: "1.0", changefreq: "daily" }];

/** Every indexable path on this site — the hub's landing page, or a state's full route table. */
export function sitemapEntries(siteState: string | null): SitemapEntry[] {
  const routes = siteState ? singleStateRoutes(siteState) : null;
  if (!routes) return HUB_SITEMAP;
  return Object.keys(routes).map((path) => {
    const depth = path.split("/").filter(Boolean).length;
    if (path === "/") return { path, priority: "1.0", changefreq: "daily" };
    if (path === "/about") return { path, priority: "0.4", changefreq: "monthly" };
    return { path, priority: depth === 1 ? "0.9" : "0.7", changefreq: "daily" };
  });
}

export function sitemapResponse(origin: string, siteState: string | null = null): Response {
  const today = new Date().toISOString().slice(0, 10);
  const urls = sitemapEntries(siteState).map(
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

/** robots.txt with the Sitemap line pointed at the requesting origin. */
export function robotsResponse(origin: string): Response {
  const body = [
    "User-agent: Googlebot",
    "Allow: /",
    "",
    "User-agent: Bingbot",
    "Allow: /",
    "",
    "User-agent: Twitterbot",
    "Allow: /",
    "",
    "User-agent: facebookexternalhit",
    "Allow: /",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

/**
 * llms.txt for a single-state site; null on the hub, whose static
 * public/llms.txt is served as-is.
 */
export function llmsResponse(siteState: string | null): Response | null {
  const state = liveState(siteState);
  if (!state) return null;
  const site = siteNameFor(state.name);
  const agency = state.agency?.name ?? `${state.name}'s disclosure agency`;
  const lines = [
    `# ${site}`,
    "",
    `> Public-interest dashboard tracking money and polling in ${state.name}'s 2026 statewide races — ${listOffices(state.races!)}. Campaign-finance filings sourced from the ${agency}, plus aggregated public polling from 270toWin. A Political Integrity Project site.`,
    "",
    "## Pages",
    "",
  ];
  for (const r of state.races!) {
    const label = raceLabel(state, r);
    lines.push(`- [${label}](/${r.office}): race dashboard — candidates, ${r.pollingSourceUrl ? "polling average, " : ""}money raised and spent.`);
    lines.push(`- [${label} candidates](/${r.office}/candidates): the field, with a profile per candidate at /${r.office}/candidates/{slug}.`);
    if (r.pollingSourceUrl) lines.push(`- [${label} polls](/${r.office}/polling): every public poll and the general-election average.`);
    lines.push(`- [${label} top donors](/${r.office}/money/donors): itemized contributions grouped by donor.`);
    lines.push(`- [${label} outside spending](/${r.office}/money/outside-spending): independent expenditures for and against each candidate.`);
  }
  lines.push("- [About & methodology](/about): sources, sync cadence, and how the numbers are computed.", "");
  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
