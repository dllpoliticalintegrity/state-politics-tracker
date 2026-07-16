# Bootstrap checklist — state-politics-tracker

Port record for bootstrapping this repo from
[tx-politics-tracker](https://github.com/dllpoliticalintegrity/tx-politics-tracker)
(the same pattern as its `docs/tx-repo-bootstrap.md`, which recorded the
ca-gov-polling → TX port). Phase numbers refer to `docs/plan.md`.

## Done in Phase 1

- [x] Copied the app: `src/`, `public/`, `functions/`, Vite/TS/Tailwind/
      ESLint/Vitest configs, `index.html`, lockfile.
- [x] **Not** copied (deliberately): `supabase/` (TX migrations + edge
      functions — this site gets a fresh project and `cf_*` schema in
      Phase 2), `scripts/data-import/` (TEC/Cal-Access importers stay with
      their sites; the SLCF importer is new work), `.github/workflows/`
      (TX sync jobs), `docs/` (TX-specific).
- [x] `src/states/registry.ts` — all 50 states with statuses (0 live,
      TX/CA external, 24 SLCF-ready, rest planned); single source of truth.
- [x] `src/states/StateContext.tsx` — `StateProvider` / `useStateConfig`
      (inside live-state routes) and `useActiveState` (safe in chrome).
- [x] Routing: `/` → `StatePicker` landing grid; `/:state/*` → `StateArea`
      which renders the live dashboard, `ComingSoon`, an external redirect
      (TX/CA), or 404. The TX page set (Index, Candidates, CandidateDetail,
      Polling, TopDonors, IndependentExpenditures, Statewide, About) is
      mounted under live states only — unreachable until Phase 2.
- [x] Header: renamed, state switcher (Live / Separate sites / Coming
      soon), nav + mobile tab bar + footer links are state-prefixed and
      hidden when no state is active.
- [x] Supabase client tolerates missing env (placeholder URL) so the site
      boots before the Phase 2 project exists; `.env.example` added.
- [x] De-TX'd: `index.html` meta (PostHog snippet removed — TX project
      key), donate panel copy (TxGovSpendStat dropped), robots.txt sitemap
      URL, `llms.txt`, Cloudflare `_middleware.ts` + `sitemap.xml.ts`
      (landing-only, origin-derived canonicals, no hardcoded domain).

## Phase 2 — before the first live state

- [ ] Create the Supabase project; write `cf_*` migrations (see plan.md
      "Data architecture"); set `VITE_SUPABASE_URL`/key in `.env` and
      Cloudflare Pages env.
- [ ] Race-scoped routing: `/:state` becomes a race-overview page;
      `/:state/:office` renders the dashboard (Index format) with race
      tabs; candidates/polling/money pages nest under the race. See
      plan.md "Race model" — offices vary per state, unpolled races rank
      by money raised.
- [ ] Generalize the data layer: hooks (`useCandidates`, `usePolling`,
      `useLatestContributions`) take state + office from context and
      query `cf_*` tables filtered accordingly; regenerate
      `src/integrations/supabase/types.ts` from the new schema.
- [ ] De-TX the page copy: `Index.tsx` hero/subtitle, `About.tsx`,
      `PollingChart` source links — all should read from the registry.
      Drop `Statewide.tsx`: the race model (tabs + race overview)
      replaces it.
- [ ] Write `scripts/data-import/slcf/import_slcf_finance.py` (canonical
      CSVs → `cf_*`); port + parameterize the 270toWin polling importer.
- [ ] Nightly sync workflow matrix in `.github/workflows/` for live states.
- [ ] Promote pilot states (suggested: FL, MI, GA) to `live` in the
      registry with raceTitle/generalDate/agency/pollingSourceUrl; curate
      `cf_candidates` for each.
- [ ] Revisit `Statewide.tsx`: keep per-state down-ballot races or drop
      the page from the multi-state nav.

## Phase 3 — launch

- [ ] Choose the domain; set robots.txt `Sitemap:` line.
- [ ] Per-state SEO: registry-driven `STATIC_ROUTES` in
      `functions/_middleware.ts` and per-state sitemap entries.
- [ ] New PostHog project; re-add the snippet in `index.html`.
- [ ] Cloudflare Pages project + custom domain; cross-link from
      texaspoliticstracker.com's header/footer.
- [ ] Decide the CA tile's production URL (currently the ca-gov-polling
      GitHub repo).
