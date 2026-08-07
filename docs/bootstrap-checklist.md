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
- [x] AZ / KY / ME live (Jul 2026 wave 2): AZ Governor + AG + SoS
      (SeeTheMoney API import; Kolodin has no candidate committee), KY
      Governor **2027** (odd-year state — 2026 statewide is federal-only;
      KREF name-keyed import), ME Governor (Pingree vs Charles vs
      Bennett; polling live, finance pending — Maine's disclosure system
      WAF blocks datacenter IPs, needs a residential-egress run).
      Polling importer covers AZ + ME governor pages.
- [x] PA / MA / MN / CO / IA / MD / HI live (Aug 2026 wave 3, governor
      races): ~537k finance rows loaded and verified against each
      state's official totals; the nightly importer now covers all ten
      importable states. Polling live for PA / MA / MN / IA (270toWin
      has no CO/HI/MD general-election pages yet). Source notes: PA DOS
      annual ZIPs (amended filings deduped by max CampaignFinanceID; names
      are plain "First Last" — entity-keyword classification), CO TRACER
      bulk CSVs (stable RecordIDs, year files overlap), MN CFB itemized
      >$200 CSVs, MA OCPF textOutput TSVs per CPF ID, HI CKAN datastore
      (Reg No + 2022-2026 period), IA Data Hub bulk ZIPs (Socrata API is
      dead; Sand/Sherman committees cycle-filtered — they predate the
      race; Lahn's $2.5M self-loans land in cf_loans), MD MDCRIS open
      JSON API (CSV export per committee; refund rows negated). No
      committees found: PA Krawchuk/Dastra, CO Lopez, MD Ellis/White,
      HI Bourgoin/Fujiyama.
- [x] OH / WI / NV live (Aug 2026 wave 4, governor races): rosters
      curated (OH 6, WI 11 — pre-Aug-11-primary field, NV 10:
      Lombardo vs Aaron Ford plus ballot-qualified independents;
      NV filer_refs empty pending Aurora access). WI finance live:
      ~83k rows backfilled from Sunshine per-committee exports, and
      the nightly importer now covers WI via the date-windowed
      data-download API (last 45 days per run; WI_SINCE overrides
      for backfills). Polling live for all three (270toWin pages).
- [ ] Wave 4 finance gaps: OH — ohiosos.gov serves its 403/maintenance
      page to this egress (TLS-fingerprint block ahead of the ORDS
      File Transfer Page; SLCF's curl_cffi trick can't help because
      the agent proxy re-originates TLS) — candidates carry oh:<id>
      filer_refs ready for a residential-egress run, like Maine.
      NV — Aurora and the SoS data-download page sit behind Incapsula,
      which denies datacenter IPs outright; NV runs candidates +
      polling only.
- [x] AL / AK / AR / CT / ID / IL / KS live (Aug 2026 wave 5, governor
      races — the last seven SLCF-ready states): rosters curated
      (AL 9: Tuberville vs Doug Jones 2020-Senate rematch, primaries
      done; AK 19: the full top-four-primary field ahead of Aug 18,
      nine majors with APOC filer refs; AR 4: Sanders re-elect;
      CT 6: Lamont-Elliott Dem primary Aug 11 + Fazio; ID 7; IL 8:
      Pritzker-Bailey 2022 rematch; KS 12: Masterson vs Holscher,
      primary called Aug 4). All seven have working finance importers
      in the nightly sync — none of the wave-4-style WAF blocks.
      Source notes: AL FCPA bulk extracts (entellitrak like MI;
      leaf-only TLS chain fixed by trusting the GlobalSign
      intermediate at runtime; Cash extract already contains in-kind
      rows), AK APOC per-candidate CSV exports (name-keyed, WebForms
      session + Export-button dialog link — the bare exportAll URL
      returns empty; Office=Governor filter; retries mandatory),
      AR + ID the same Civix bulk-CSV API as GA (fetched gzipped —
      AR's ~100 MB files get cut off uncompressed; Return
      Contributions negated; non-itemized lumps labeled), CT SEEC
      eCRIS static cycle CSVs (no txn ids — hashed; CEP public
      grants labeled as such — Fazio $807k, Elliott $3.75M, with
      ~$18M general grants coming), IL ISBE 1 GB dumps streamed with
      Range-resume and cycle-filtered to 2025+ (committees date to
      2017), KS SoS CFR viewer HTML scrape (no bulk data, no ids —
      WebForms chain per candidate/report/schedule, hashes exclude
      report id so amended re-filings dedupe; Schedule C parse
      verified to the penny against the filed totals). Polling
      importer v6 adds AL/AK/CT pages plus a wrong-page-cache guard
      (270toWin's CDN once served Kansas content at /connecticut);
      AR/ID have no 270toWin page, IL/KS are primary-only so far.
- [ ] Wave 5 follow-ups: AK primary Aug 18 (mark lost_primary after,
      top four advance to RCV general), CT Dem primary Aug 11; add
      IL/KS polling entries when 270toWin posts general polls; KS
      pre-general R&E report lands late Oct (next scrape target
      202610); IL third-party candidates Romero/Pierce have no ISBE
      committees (below $5k threshold).
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
