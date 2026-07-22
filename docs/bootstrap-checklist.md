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

## Phase 2 — live data (in progress)

- [x] Database: cf_* schema applied to the **shared TX-tracker Supabase
      project** (decision: reuse it instead of paying for a new one —
      additive only, tx_* untouched). Migration in
      `supabase/migrations/20260717000000_cf_schema.sql`; client defaults
      to the shared project's publishable key.
- [x] Pilot candidates seeded (FL/MI/GA governor, July 2026 fields);
      races registered in the shared polling tables.
- [x] Polling: `supabase/functions/import-towin-polling-multi` scrapes
      270toWin for every live race (roster from cf_candidates); synced
      every 6h by `.github/workflows/polling-sync.yml`.
- [x] Frontend on live data: hooks query cf_*/races scoped by
      state+office from context; /:state/:office routing with
      RaceProvider; FL/MI/GA live in the registry; page copy reads from
      the registry (About rewritten multi-state; Statewide.tsx dropped).
- [x] Down-ballot statewide races live (Jul 17, 2026): GA Lt. Gov / AG /
      SoS, MI AG / SoS, FL AG / CFO / Agriculture Commissioner — real
      candidates derived from each state's registry (GA Peachfile
      GetCandidateDetails, FL extractCanList, MI committee search),
      nominees/lost-primary statuses verified against press coverage,
      finance imported (~45k more rows). Gilchrist moved from the MI
      governor race to SoS (his actual 2026 run). Race tabs render on
      race pages; unpolled races rank by money and hide polling chrome.
- [ ] Race overview page at `/:state` (currently redirects to the first
      race).
- [x] Finance imported (Jul 17, 2026): 384k contributions, 16k
      expenditures loaded from FL DOE per-candidate queries, GA
      Peachfile bulk CSVs, and MI MiTN bulk ZIPs, scoped to the
      committees in cf_candidates.filer_refs.
      `scripts/data-import/pilot/import_pilot_finance.py` re-runs it
      (idempotent upserts); `.github/workflows/finance-sync.yml` runs
      nightly once the SUPABASE_SERVICE_ROLE_KEY repo secret is added.
- [ ] Known finance gaps: FL affiliated political committees (e.g.
      "Friends of Byron Donalds" — FL's big money flows outside the
      $3k-capped candidate accounts) are not yet mapped into
      filer_refs; GA Raffensperger and MI Perry Johnson have no
      committee registrations found as of Jul 2026; outside-spending
      (IE) tables remain empty pending per-state IE source research.
- [ ] Regenerate `src/integrations/supabase/types.ts` from the shared
      schema (hooks currently use `as any`, so this is cleanup).

## Phase 3 — launch

- [ ] Choose the domain; set robots.txt `Sitemap:` line.
- [ ] Per-state SEO: registry-driven `STATIC_ROUTES` in
      `functions/_middleware.ts` and per-state sitemap entries.
- [ ] New PostHog project; re-add the snippet in `index.html`.
- [ ] Cloudflare Pages project + custom domain; cross-link from
      texaspoliticstracker.com's header/footer.
- [ ] Decide the CA tile's production URL (currently the ca-gov-polling
      GitHub repo).
