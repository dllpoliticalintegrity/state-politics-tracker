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

Pre-bootstrap. See [`docs/plan.md`](docs/plan.md) for the architecture
and phased rollout, and open
[`docs/design-drafts/multi-state-preview.html`](docs/design-drafts/multi-state-preview.html)
in a browser for an interactive mock of the state-switcher UX
(self-contained, mock data).

Next step is Phase 1: bootstrap the codebase from
[tx-politics-tracker](https://github.com/dllpoliticalintegrity/tx-politics-tracker)
(Vite + React + shadcn-ui + Tailwind, Supabase, Cloudflare Pages),
strip the TX-specific code, and add the state registry and `/:state`
routing.
