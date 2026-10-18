// SEO logic shared by both deploy targets:
//  - functions/_middleware.ts + functions/sitemap.xml.ts (Cloudflare Pages)
//  - worker/index.ts (Cloudflare Workers with static assets)
// and by the SPA (src/App.tsx keeps document.title in step via routeMeta).
//
// Two route tables:
//  - the multi-state hub covers the landing page, plus the full state table
//    under /<code> for states whose dedicated site points its canonical at
//    the hub (HUB_CANONICAL_STATES in shared/site.ts);
//  - a dedicated single-state site (shared/site.ts) gets registry-driven
//    metadata for its home, every statewide race page, each legislative
//    chamber's overview and district pages, and the About page.
// Canonical URLs derive from the request origin, except on a hub-canonical
// dedicated site, whose pages name the hub's copy (shared/site.ts).

import {
  chamberDistricts,
  chamberScope,
  districtRace,
  getChamber,
  getState,
  isValidDistrict,
  legacyRedirect,
  pollingSourceLabel,
  statePollingLabel,
  type ChamberConfig,
  type RaceConfig,
  type StateConfig,
} from "../src/states/registry";
import { HUB_CANONICAL_STATES, HUB_URL, SITE_STATE_META, hubCanonicalUrl, siteNameFor } from "./site";

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
      <p>Texas, Michigan and California also have their own sites — <a href="https://texaspoliticstracker.com">texaspoliticstracker.com</a>, <a href="https://michiganpoliticstracker.com">michiganpoliticstracker.com</a> and <a href="https://cagovtracker.com">cagovtracker.com</a>.</p>
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
    // Legislative slugs end in a district tag ("-sd11", "-hd110"); drop it.
    .filter((w, i, arr) => !(i === arr.length - 1 && /^[sh]d\d+$/.test(w)))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function listOffices(state: StateConfig): string {
  const titles = [
    ...(state.races ?? []).map((r) => r.title),
    ...(state.chambers ?? []).map((c) => c.title),
  ];
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

function raceLabel(state: StateConfig, race: RaceConfig): string {
  return `${state.name} ${race.title} ${race.generalDate.slice(0, 4)}`;
}

function agencyName(state: StateConfig): string {
  return state.agency?.name ?? `${state.name}'s disclosure agency`;
}

function liveState(code: string | null | undefined): StateConfig | null {
  const s = code ? getState(code) : undefined;
  return s && s.status === "live" && s.races?.length ? s : null;
}

/**
 * A permanent redirect for a dedicated site's pre-hub URLs
 * (StateConfig.legacyPaths, e.g. texaspoliticstracker.com/polling →
 * /governor/polling), or null. Hub requests (no pinned state) never match.
 */
export function legacyRedirectResponse(url: URL, siteState: string | null): Response | null {
  const target = legacyRedirect(liveState(siteState), url.pathname);
  if (!target) return null;
  return Response.redirect(new URL(`${target}${url.search}`, url.origin).toString(), 301);
}

/**
 * Who a state route table is for: the brand in its titles, and the path
 * prefix its links carry ("" on a dedicated site, "/mi" on the hub).
 */
type TableCtx = { site: string; prefix: string };

const HUB_SITE = siteNameFor(null);

function dedicatedCtx(state: StateConfig): TableCtx {
  return { site: siteNameFor(state.name), prefix: "" };
}

function hubCtx(code: string): TableCtx {
  return { site: HUB_SITE, prefix: `/${code}` };
}

/** Metadata for one race's pages (statewide or district), keyed by path under `base`. */
function raceRoutes(state: StateConfig, race: RaceConfig, base: string, ctx: TableCtx = dedicatedCtx(state)): Record<string, RouteMeta> {
  const site = ctx.site;
  const link = `${ctx.prefix}${base}`;
  const agency = agencyName(state);
  const label = raceLabel(state, race);
  const year = race.generalDate.slice(0, 4);
  const polled = !!race.pollingSourceUrl;
  const routes: Record<string, RouteMeta> = {};

  routes[base] = {
    title: `${label} Race — ${polled ? "Polls & " : ""}Campaign Finance | ${site}`,
    description: polled
      ? `Who's running for ${state.name} ${race.title} in ${year}, who leads the polling average, and who is funding each campaign — from the ${agency} and ${pollingSourceLabel(race)}.`
      : `Who's running for ${state.name} ${race.title} in ${year} and who is funding each campaign — itemized contributions and spending from the ${agency}.`,
    h1: `${label}: ${polled ? "Polls, Candidates & Money" : "Candidates & Money"}`,
    body: `
      <p>Track the ${escapeHtml(label)} race: the candidate field, ${polled ? "a polling average built from public general-election polls, " : ""}money raised and spent by each campaign, top donors, and outside spending — updated nightly from the ${escapeHtml(agency)}.</p>
      <ul>
        <li><a href="${link}/candidates">Candidates</a></li>
        ${polled ? `<li><a href="${link}/polling">Polling</a></li>` : ""}
        <li><a href="${link}/money/donors">Top donors</a></li>
        <li><a href="${link}/money/outside-spending">Outside spending</a></li>
        <li><a href="${link}/money/river">Money river</a></li>
      </ul>
    `,
  };
  routes[`${base}/candidates`] = {
    title: `${label} Candidates | ${site}`,
    description: `Every tracked candidate for ${state.name} ${race.title} in ${year}, with money raised, cash on hand${polled ? ", polling" : ""} and campaign details.`,
    h1: `${label} Candidates`,
    body: `<p>The field for ${escapeHtml(label)}, ranked by ${polled ? "polling average and " : ""}money raised, with a profile of each candidate's fundraising and spending.</p>`,
  };
  if (polled) {
    routes[`${base}/polling`] = {
      title: `${label} Polls & Polling Average | ${site}`,
      description: `Latest ${state.name} ${race.title} polls and a general-election polling average, with every poll listed by pollster and field dates.`,
      h1: `${label} Polls`,
      body: `<p>Public polling for ${escapeHtml(label)}, aggregated from ${escapeHtml(pollingSourceLabel(race))}: individual polls plus a trailing general-election average.</p>`,
    };
  }
  routes[`${base}/money/donors`] = {
    title: `${label} Top Donors & Campaign Finance | ${site}`,
    description: `Who is funding the ${state.name} ${race.title} candidates: top individual and organizational donors, industries and totals from ${agency} filings.`,
    h1: `${label}: Top Donors`,
    body: `<p>Itemized contributions to every ${escapeHtml(label)} campaign committee, grouped by donor, as filed with the ${escapeHtml(agency)}.</p>`,
  };
  routes[`${base}/money/river`] = {
    title: `${label} Money River — Every Contribution & Expense | ${site}`,
    description: `Every itemized contribution, expenditure, loan and outside expenditure in the ${state.name} ${race.title} race, newest first, from ${agency} filings.`,
    h1: `${label}: Money River`,
    body: `<p>A running feed of every itemized transaction for the ${escapeHtml(label)} candidates — contributions, campaign spending, loans and outside spending — as filed with the ${escapeHtml(agency)}.</p>`,
  };
  routes[`${base}/money/outside-spending`] = {
    title: `${label} Outside Spending & Independent Expenditures | ${site}`,
    description: `Independent expenditures for and against ${state.name} ${race.title} candidates, and who funds the committees behind them.`,
    h1: `${label}: Outside Spending`,
    body: `<p>Independent expenditures supporting or opposing ${escapeHtml(label)} candidates, and the donors behind the committees making them.</p>`,
  };
  return routes;
}

function candidateMeta(state: StateConfig, race: RaceConfig, slug: string, site = siteNameFor(state.name)): RouteMeta {
  const name = humanizeSlug(slug);
  const label = raceLabel(state, race);
  return {
    title: `${name} — ${label} Candidate | ${site}`,
    description: `${name}'s campaign for ${state.name} ${race.title}: money raised, top donors, spending${race.pollingSourceUrl ? ", polling" : ""} and outside spending, from ${state.agency?.name ?? "state"} filings.`,
    h1: `${name} — ${label}`,
    body: `<p>Campaign-finance profile of ${escapeHtml(name)}, candidate for ${escapeHtml(label)}: contributions, top donors, expenditures and independent expenditures for and against.</p>`,
  };
}

function chamberMeta(state: StateConfig, chamber: ChamberConfig, base: string, ctx: TableCtx = dedicatedCtx(state)): RouteMeta {
  const site = ctx.site;
  const agency = agencyName(state);
  const year = chamber.generalDate.slice(0, 4);
  return {
    title: `${state.name} ${chamber.title} ${year} — Campaign Finance by District | ${site}`,
    description: `Who is running for the ${state.name} ${chamber.title} in ${year} and who is funding them, district by district: candidate committees, money raised and top donors from ${agency} filings.`,
    h1: `${state.name} ${chamber.title} ${year}: Money in Every District`,
    body: `
      <p>Campaign finance for ${escapeHtml(state.name)}'s ${escapeHtml(chamberScope(chamber).replace(/^all /, "").replace(/^the /, ""))}, synced nightly from the ${escapeHtml(agency)}. Each district page lists its candidates, what they have raised and spent, their top donors and any outside spending.</p>
      <ul>
        ${chamberDistricts(chamber)
          .map((d) => `<li><a href="${ctx.prefix}${base}/${d}">${escapeHtml(chamber.title)} District ${d}</a></li>`)
          .join("\n        ")}
      </ul>
    `,
  };
}

const singleStateCache = new Map<string, Record<string, RouteMeta>>();

/**
 * Static route table for a state's dedicated site, keyed by pathname: home,
 * every statewide race page, each chamber overview, and About. District
 * pages are resolved on demand by routeMeta (148 Michigan districts × five
 * pages is too many to pre-build). Built from the registry so adding a race
 * to LIVE_CONFIG is all it takes. With `hub`, the same table titled for the
 * hub and with links under /<code>; keys stay unprefixed either way.
 */
export function singleStateRoutes(code: string, hub = false): Record<string, RouteMeta> | null {
  const key = `${code}${hub ? "@hub" : ""}`;
  const cached = singleStateCache.get(key);
  if (cached) return cached;
  const state = liveState(code);
  if (!state) return null;

  const ctx = hub ? hubCtx(code) : dedicatedCtx(state);
  const site = ctx.site;
  const agency = agencyName(state);
  const routes: Record<string, RouteMeta> = {};

  routes["/"] = {
    title: `${site} — Money & Polling in ${state.name}'s 2026 Statewide Races`,
    description: `Follow the money and polling in ${state.name}'s 2026 ${listOffices(state)} races. Campaign-finance filings from the ${agency}, polling averages, and outside spending.`,
    h1: `${site} — Follow the Money in ${state.name}`,
    body: `
      <p>${escapeHtml(site)} is a public-interest dashboard for ${escapeHtml(state.name)}'s 2026 statewide races, from the Political Integrity Project. We pull primary-source campaign-finance filings from the ${escapeHtml(agency)}, surface outside spending, and aggregate public polling so you can see how money and momentum are moving in each race.</p>
      <ul>
        ${(state.races ?? [])
          .map((r) => `<li><a href="${ctx.prefix}/${r.office}">${escapeHtml(raceLabel(state, r))}: polls, candidates and money</a></li>`)
          .join("\n        ")}
        ${(state.chambers ?? [])
          .map((c) => `<li><a href="${ctx.prefix}/${c.office}">${escapeHtml(`${state.name} ${c.title} ${c.generalDate.slice(0, 4)}`)}: campaign finance by district</a></li>`)
          .join("\n        ")}
      </ul>
    `,
  };

  for (const race of state.races ?? []) Object.assign(routes, raceRoutes(state, race, `/${race.office}`, ctx));
  for (const chamber of state.chambers ?? []) routes[`/${chamber.office}`] = chamberMeta(state, chamber, `/${chamber.office}`, ctx);

  routes["/committees"] = {
    title: `Committees & PACs Giving in ${state.name} | ${site}`,
    description: `Every political committee, PAC, union, party and business that has given to a ${state.name} candidate in 2026, searchable by name, with each one's contributions broken down by campaign — from ${agency} filings.`,
    h1: `Committees & PACs giving in ${state.name}`,
    body: `<p>Organizational donors to tracked ${escapeHtml(state.name)} candidates — political action committees, party committees, unions and businesses — ranked by total given, with a per-candidate breakdown for each. Search by committee name or city.</p>`,
  };

  routes["/about"] = {
    title: `About & Methodology | ${site}`,
    description: `How ${site} sources ${state.name} campaign-finance filings from the ${agency}, aggregates polling, and computes the numbers on each race page.`,
    h1: `About ${site}`,
    body: `<p>${escapeHtml(site)} is a project of the Political Integrity Project. Campaign finance comes from the ${escapeHtml(agency)}'s public filings${statePollingLabel(state) ? `; polling comes from ${escapeHtml(statePollingLabel(state)!)}` : ""}. Data is presented as filed.</p>`,
  };

  singleStateCache.set(key, routes);
  return routes;
}

const CANDIDATE_DETAIL_RE = /^\/([a-z0-9-]+)\/candidates\/([a-z0-9-]+)$/;
const DISTRICT_RE = /^\/([a-z0-9-]+)\/(\d+)(\/.*)?$/;
const HUB_STATE_RE = /^\/([a-z]{2})(\/.*)?$/;

/**
 * Metadata for a pathname on this site — the hub table when `siteState` is
 * null, the state's registry-driven table otherwise (district pages and
 * candidate profiles are resolved from their path). Null for paths with no
 * dedicated metadata.
 */
export function routeMeta(pathname: string, siteState: string | null): RouteMeta | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (!siteState) {
    if (STATIC_ROUTES[path]) return STATIC_ROUTES[path];
    // The hub's copy of a hub-canonical state: /mi/governor → Michigan's table.
    const hm = HUB_STATE_RE.exec(path);
    if (hm && HUB_CANONICAL_STATES.has(hm[1])) return stateRouteMeta(hm[2] ?? "/", hm[1], true);
    return null;
  }
  return stateRouteMeta(path, siteState, false) ?? STATIC_ROUTES[path] ?? null;
}

/** Metadata for an unprefixed path in one state's table (see routeMeta). */
function stateRouteMeta(path: string, code: string, hub: boolean): RouteMeta | null {
  const routes = singleStateRoutes(code, hub);
  const state = liveState(code);
  if (!routes || !state) return null;
  const ctx = hub ? hubCtx(code) : dedicatedCtx(state);
  const exact = routes[path];
  if (exact) return exact;

  // District race pages: /state-senate/11[/candidates[/slug]|/money/...]
  const dm = DISTRICT_RE.exec(path);
  if (dm) {
    const chamber = getChamber(state, dm[1]);
    if (chamber && isValidDistrict(chamber, dm[2])) {
      const race = districtRace(state, chamber, dm[2]);
      const base = `/${chamber.office}/${dm[2]}`;
      const table = raceRoutes(state, race, base, ctx);
      if (table[path]) return table[path];
      const cm = /^\/candidates\/([a-z0-9-]+)$/.exec(dm[3] ?? "");
      if (cm) return candidateMeta(state, race, cm[1], ctx.site);
    }
    return null;
  }

  const m = CANDIDATE_DETAIL_RE.exec(path);
  if (m) {
    const race = state.races!.find((r) => r.office === m[1]);
    if (race) return candidateMeta(state, race, m[2], ctx.site);
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
  const canonical = hubCanonicalUrl(siteState, pathname) ?? `${url.origin}${pathname}`;
  if (meta) html = rewriteHtml(html, meta, canonical);
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

/**
 * Every indexable path on this site — the hub's landing page, or a state's
 * static route table plus each district's home page (district sub-pages are
 * reachable from there and stay out of the sitemap to keep it readable).
 */
export function sitemapEntries(siteState: string | null): SitemapEntry[] {
  if (!siteState) {
    // The hub lists its copy of each hub-canonical state under /<code>.
    const entries = [...HUB_SITEMAP];
    for (const code of HUB_CANONICAL_STATES) {
      if (!liveState(code)) continue;
      for (const e of sitemapEntries(code)) {
        entries.push({ ...e, path: `/${code}${e.path === "/" ? "" : e.path}` });
      }
    }
    return entries;
  }
  const routes = singleStateRoutes(siteState);
  const state = liveState(siteState);
  if (!routes || !state) return HUB_SITEMAP;
  const entries = Object.keys(routes).map((path) => {
    const depth = path.split("/").filter(Boolean).length;
    if (path === "/") return { path, priority: "1.0", changefreq: "daily" };
    if (path === "/about") return { path, priority: "0.4", changefreq: "monthly" };
    if (path === "/committees") return { path, priority: "0.8", changefreq: "daily" };
    return { path, priority: depth === 1 ? "0.9" : "0.7", changefreq: "daily" };
  });
  for (const chamber of state.chambers ?? []) {
    for (const d of chamberDistricts(chamber)) {
      entries.push({ path: `/${chamber.office}/${d}`, priority: "0.6", changefreq: "daily" });
    }
  }
  return entries;
}

export function sitemapResponse(origin: string, siteState: string | null = null): Response {
  // A hub-canonical site's pages are indexed on the hub: send crawlers there.
  if (hubCanonicalUrl(siteState, "/")) return Response.redirect(`${HUB_URL}/sitemap.xml`, 301);
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

/**
 * robots.txt with the Sitemap line pointed at the requesting origin, or at
 * the hub's sitemap on a hub-canonical dedicated site.
 */
export function robotsResponse(origin: string, siteState: string | null = null): Response {
  const sitemap = hubCanonicalUrl(siteState, "/") ? `${HUB_URL}/sitemap.xml` : `${origin}/sitemap.xml`;
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
    `Sitemap: ${sitemap}`,
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
  const agency = agencyName(state);
  const lines = [
    `# ${site}`,
    "",
    `> Public-interest dashboard tracking money and polling in ${state.name}'s 2026 statewide races — ${listOffices(state)}. Campaign-finance filings sourced from the ${agency}${statePollingLabel(state) ? `, plus aggregated public polling from ${statePollingLabel(state)}` : ""}. A Political Integrity Project site.`,
    "",
    "## Pages",
    "",
  ];
  for (const r of state.races ?? []) {
    const label = raceLabel(state, r);
    lines.push(`- [${label}](/${r.office}): race dashboard — candidates, ${r.pollingSourceUrl ? "polling average, " : ""}money raised and spent.`);
    lines.push(`- [${label} candidates](/${r.office}/candidates): the field, with a profile per candidate at /${r.office}/candidates/{slug}.`);
    if (r.pollingSourceUrl) lines.push(`- [${label} polls](/${r.office}/polling): every public poll and the general-election average.`);
    lines.push(`- [${label} top donors](/${r.office}/money/donors): itemized contributions grouped by donor.`);
    lines.push(`- [${label} outside spending](/${r.office}/money/outside-spending): independent expenditures for and against each candidate.`);
    lines.push(`- [${label} money river](/${r.office}/money/river): every itemized contribution, expenditure, loan and outside expenditure, newest first.`);
  }
  for (const c of state.chambers ?? []) {
    lines.push(`- [${state.name} ${c.title} ${c.generalDate.slice(0, 4)}](/${c.office}): campaign finance for ${chamberScope(c).replace(` ${c.title}`, "")}; each district's race dashboard is at /${c.office}/{district} (candidates, top donors, outside spending — no polling).`);
  }
  lines.push(`- [${state.name} committees & PACs](/committees): every organizational donor to a tracked candidate, searchable by name, with a per-candidate breakdown.`);
  lines.push("- [About & methodology](/about): sources, sync cadence, and how the numbers are computed.", "");
  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
