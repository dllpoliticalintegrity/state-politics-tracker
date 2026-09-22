# State Politics Tracker

Multi-state politics tracker: polling and campaign-finance dashboards
with a per-state switcher, powered by
[state-level-campaign-finance](https://github.com/hderyke/state-level-campaign-finance)
(SLCF) pipelines. This repo is the single home for the site and all of
its states' data — the SLCF importer, curated candidate records, and
nightly sync workflows.

Texas and California are tracked on their own separate sites
([texaspoliticstracker.com](https://texaspoliticstracker.com) /
[tx-politics-tracker](https://github.com/dllpoliticalintegrity/tx-politics-tracker),
and [ca-gov-polling](https://github.com/dllpoliticalintegrity/ca-gov-polling));
their tiles on the landing page link out.

## Status

Phase 1 (bootstrap) complete: the codebase is ported from
[tx-politics-tracker](https://github.com/dllpoliticalintegrity/tx-politics-tracker)
with a state registry (`src/states/registry.ts`), `/:state` routing, a
50-state landing grid, and a header state switcher. Zero states are live
yet — every state shows its pipeline status, and TX/CA link out to their
own sites. See [`docs/plan.md`](docs/plan.md) for the architecture and
rollout, [`docs/bootstrap-checklist.md`](docs/bootstrap-checklist.md)
for what's done and what Phase 2 needs (Supabase project, `cf_*` schema,
SLCF importer, pilot states), and
[`docs/design-drafts/multi-state-preview.html`](docs/design-drafts/multi-state-preview.html)
for the target UX (open in a browser; mock data).

## Stack

- Vite + React + TypeScript + shadcn-ui + Tailwind CSS
- Supabase (Postgres; project created in Phase 2)
- Cloudflare Pages functions (`functions/`) for SEO middleware + sitemap

## Deploying

Two Cloudflare targets are supported; both share `shared/seo.ts`:

- **Workers Git-import flow** (dashboard default): build command
  `npm run build`, deploy command `npx wrangler deploy`. Uses
  `wrangler.jsonc` + `worker/index.ts` (static assets with SPA
  fallback, SEO rewrites, sitemap).
- **Classic Pages flow**: build command `npm run build`, output
  directory `dist`, no deploy command. Uses `functions/`.

Node is pinned to 22 via `.node-version`. No environment variables are
needed until a state is live.

### Legislative races

A state can also track a legislative chamber district by district
(`chambers` in `src/states/registry.ts`; Michigan's State Senate and
State House to start). These are finance-only: `/mi/state-senate` is the
chamber overview and `/mi/state-senate/11` is the ordinary race dashboard
for that district. The roster is not curated — the nightly finance
importer derives it from the state's committee registry (MiTN's active
candidate committees for the office) and writes `cf_candidates` rows with
`district` set. See `docs/plan.md`, "Legislative races".

### Dedicated single-state sites

The same build also ships as per-state sites — currently
**michiganpoliticstracker.com** (Michigan only: no landing grid or state
switcher, race pages at the root such as `/governor` and
`/attorney-general`, Michigan-branded chrome, per-page SEO titles and a
full sitemap). Nothing is forked: the state is pinned per request by the
`SITE_STATE` Worker var or by the hostname (`SINGLE_STATE_HOSTS` in
`shared/site.ts`), the Worker injects a `<meta name="site-state">` tag
so the SPA agrees, and hub-style links such as `/mi/governor` redirect
to the prefix-less path. Data, importers and design are shared with the
hub — see `docs/plan.md`, "Dedicated single-state sites".

Each dedicated site is a `wrangler.jsonc` environment, deployed from the
same `dist/`:

```sh
npm run build
npx wrangler deploy --env michigan   # michigan-politics-tracker Worker
npx wrangler deploy --env ""         # the multi-state hub (top-level config)
```

In the Cloudflare dashboard that is a second Workers project on this
repo with deploy command `npx wrangler deploy --env michigan`. The
`michiganpoliticstracker.com` zone must be on the account before the
first deploy so the custom-domain routes attach; the Worker 301s `www.`
to the apex. To add another state's site, add its hostname to
`SINGLE_STATE_HOSTS` and a matching `env` block.

## Local development

```sh
npm i
npm run dev
```

No env vars are needed until a state is live; copy `.env.example` to
`.env` once the Supabase project exists. To develop the Michigan site
rather than the hub, set `VITE_SITE_STATE=mi` (in `.env` or inline:
`VITE_SITE_STATE=mi npm run dev`).
