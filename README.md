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

## Local development

```sh
npm i
npm run dev
```

No env vars are needed until a state is live; copy `.env.example` to
`.env` once the Supabase project exists.
