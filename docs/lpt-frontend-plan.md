# Plan: the State Politics Tracker frontend on Local Politics Tracker data

Written 2026-10-18; decisions of 2026-10-18 (evening) folded in. The target:

- **One store for every state's data:** the Local Politics Tracker Supabase
  project (`rwiueylzgcgnzypdyszi`, "LPT"), Henry's and Colin's database
  behind statemoney.us, fed by their SLCF scrapers. Every state the hub shows
  reads it, and it is the only database the frontend will read once every
  state has moved.
- **Per-state tables for the states we load ourselves.** Henry's push owns the
  shared tables (`contributions`, `candidates`, … with a `state_id` column);
  we never write to them. A state that we load (California first, since it is
  not in LPT) gets its own `<st>_*` tables in the same project, mirroring his
  columns, so his push can neither wipe nor be blocked by our rows. The
  `hub_*` read functions route by state.
- **Frontend:** this repo's React app, with the hub plus one Cloudflare Worker
  and domain per state (michiganpoliticstracker.com, texaspoliticstracker.com,
  and so on). Every site is the same build.
- **Curation:** the data-diamine admin console, writing `hub_candidate_overrides`
  with the service role (its state-tracker screens are still to be built).
- **States:** the ones live on statemoney.us (AK, AZ, FL, GA, MI, OH, OR, TX,
  WI) plus California — and only those. The 16 other states with dashboards
  (AL, AR, CO, CT, HI, IA, ID, IL, KS, KY, MA, MD, ME, MN, NV, PA) are hidden
  on the hub (`HIDDEN` in `src/states/registry.ts`); their nightly imports
  keep running so un-hiding one is a one-line change.

The site's current database is the Texas Politics Tracker project
(`lohxdfrxnxuxjdvvyfjc`, "tracker"). It stays up and keeps being fed until
every state has moved, so the site works throughout the election.

## 1. What each side has

**LPT** (read 2026-10-18):

- **Tables:** `states` (with `is_ready` and `data_updated_at`), `races` (per
  state, with slugs such as `governor-2026` and `state-senate-11-2026`;
  statewide and legislative), `race_participants` (`on_ballot`,
  `is_incumbent`, `disposition` from Green Papers), `candidates` (slug, photo
  sizes, party[], committee_name[], `state_filer_id`), `committees`,
  `contributions` (3.76M rows), `expenditures` (465k), `race_polls` with
  `race_poll_results`, and `sources`.
- **Matviews (26):**
  - per-candidate summaries, sizes and size buckets;
  - funding sources (Individual / PAC & committees / Party / Other
    organizations / Self-funding / Public funds);
  - top and latest individual and non-individual donors;
  - top employers, origins and histograms;
  - outside-spending activity, contributors and committee totals;
  - `race_statistics` (raised, spent, IE support/oppose per candidate);
  - the attributed contributions and expenditures every summary is built on.
- **RPCs:** `state_profile`, `race_profile`, `candidate_profile` and
  `states_directory`, each returning one JSON document per page, as used by
  statemoney.us.
- **Access:** every table has public read RLS.
- **How it is written:** Henry's push script (private) upserts and deletes;
  tables are never dropped (`pg_stat_user_tables`: 56M updates on
  contributions since September). Candidate rows are rewritten on every push.
  The schema is applied by hand from Henry's SQL files; there is no
  migrations table.
- **Coverage:** all nine statemoney.us states; Iowa is loaded but not ready;
  no California. Last loaded 2026-10-10 to 10-16.

**The frontend** reads in exactly four hook files: `useCandidates.ts`,
`useLatestContributions.ts`, `useMoneyRiver.ts` and `usePolling.ts`. They make
20 PostgREST queries against `cf_*`, `races`, `race_polls` and
`race_polling`, all through one supabase-js client. Nothing in the Worker, SEO
or build step reads the database. The race and office lists per state are
hard-coded in `src/states/registry.ts`.

## 2. Design

**Per-state data source.** Each live state in the registry gets
`source: "lpt" | "tracker"`. A second supabase-js client points at LPT, and
each hook dispatches on the active state's source. This means:

- states move one at a time, each after its numbers are checked;
- a state can be switched back with a one-line change;
- California stays on `tracker` until it exists in LPT.

**The read layer in LPT is built to survive Henry's scripts:**

- **No views of ours on top of his objects.** His SQL can
  `drop materialized view … cascade`, which would delete them silently. The
  frontend reads his tables and matviews directly through PostgREST.
  Candidate, race and participant joins use the existing foreign keys
  (`race_participants → candidates`, `race_participants → races`).
- **Where the aggregation must be server-side, `hub_*` SQL functions**, called
  through `.rpc`. Examples: a state's committee donors across candidates, a
  race's outside committees, the money river. Postgres doesn't record a SQL
  function's dependencies, so a cascade on his side can't delete them; they
  work again as soon as his objects are back.
- **Curated fields go in `hub_candidate_overrides`.** It is keyed by
  `candidate_id` and holds photo, bio, website, social handles, featured and
  title. The app layers it over `candidates`, so his upserts can't overwrite
  our edits.
- **Our LPT SQL lives in this repo**, under `supabase/lpt/`, applied by hand
  in order with the Supabase MCP's `execute_sql` (never `apply_migration`, so
  his project gets no migration history). Every object is prefixed `hub_`.
  `001_hub_read_layer.sql` is applied (2026-10-18).

**Two things learned applying it:**

- PostgREST passes RPC arguments as sub-selects, so inside a function the
  state is never a literal; the planner's generic estimate for
  `state_id = $1` chose a sequential scan of the 3.5M-row contribution
  matview (32 s, past anon's 30 s statement timeout). Every race- or
  state-scoped function walks its candidates with a `LATERAL` join on
  `candidate_id`, which forces the index.
- Even so, the race-wide donor and committee aggregates (hundreds of
  thousands of rows per request) ran 7–30 s on LPT's instance. They now read
  plain `hub_cache_*` tables (`002_hub_cache.sql`) that `hub_refresh_cache()`
  refills from his matviews — per-candidate finance and row counts, the top
  300 donors per candidate and type, every organizational donor per state,
  the itemized loans. A plain table survives a cascade drop; the refresh
  fails until his objects are back and the cache keeps serving. Georgia
  refreshes in 46 s; every state will take some minutes. **Nothing schedules
  it yet** (the choice is a pg_cron job in his project, after his 15:00 UTC
  weekday refresh, or the hub's nightly Action once the LPT service key
  exists); until then it is run by hand after his push.
- The river reads his base `contributions` table through its
  `(candidate_id, contribution_date)` index, taking only the rows that can
  reach the requested page per candidate; its total comes from the cached
  counts. ~1 s. The ticker uses the `(candidate_id, amount)` index: 13 ms.
- PostgREST caps any response at 1,000 rows, RPCs included; rosters and the
  committee-donor list page through it.
- The pages key polling by surname. LPT's poll results carry `candidate_id`,
  so the LPT average is also written under `id:<candidate_id>` keys and the
  pages prefer those (`readCandidatePct`, `pollRowIsCandidate`); without
  that, Derrick Jackson (off the ballot) inherited Rick Jackson's average.

**Polling** for an LPT state comes from LPT's `race_polls` (one row per poll,
no aggregate). The site averages each candidate over the race's five most
recent polls (`src/lib/lpt.ts`), labels it "Local Politics Tracker" and links
the race's statemoney.us page. FiftyPlusOne stays the source for tracker
states.

**Names and status.** LPT files names as "LAST, FIRST M." but also carries
cased first and last names, which the hub shows ("Keisha Bottoms"); the
curated `display_name` override restores a preferred form ("Keisha Lance
Bottoms", "Rick Jackson"). Ballot status derives from `on_ballot` and the
Green Papers `disposition`; candidates off the ballot read "Not on ballot"
unless the disposition says withdrew or lost, or an override says otherwise.

## 3. Query mapping (tracker → LPT)

| Hook / query | Today (tracker) | LPT source |
|---|---|---|
| Candidates of a race / chamber / state (Q1–3, Q17) | `cf_candidates` | `race_participants` ⋈ `candidates` ⋈ `races` (2026), filtered by `races.state_id` (upper case), `office` and `office_num`, plus `hub_candidate_overrides` |
| Contributions summary (Q4) | `cf_contributions_summary` | `candidate_contributions_summaries` (total), `candidate_funding_sources` (individual, entity and self bars), `candidate_contribution_size_buckets` (small donors) |
| Raised / spent per race (Q11–12) | `cf_*_summary` | `race_statistics` (`total_raised`, `total_spent`) |
| Top individual donors (Q6) | `cf_top_donors` | `candidate_contribution_top_individual_donors` |
| Top PAC donors (Q6) | `cf_top_donors` | `candidate_contribution_top_non_individual_donors_by_donor` |
| Race-wide top donors (Q7) | `cf_top_donors`, aggregated client-side | the same two matviews for the race's candidates, aggregated client-side |
| Top employers (Q9) | `cf_contributions` | `candidate_top_employers` |
| Self-funding and loans (Q10) | `cf_contributions_deduped` | `candidate_funding_sources` (Self-funding) plus `candidate_other_receipts` (loans) |
| Outside spending by candidate (Q13) | `cf_ie_by_candidate` | `race_statistics` (`total_ie_support` / `_oppose`) |
| Recent outside spending (Q14) | `cf_independent_expenditures` | `candidate_ie_activity` (`rnk_by_date`) |
| Top outside committees (Q15) | client-side over IE rows | `hub_race_ie_committees(state, office, district)` over `candidate_ie_expenditures` |
| Outside-committee donors (Q8) | `cf_top_ie_donors` | `candidate_ie_contributors` / `ie_committee_contributors` |
| State committee donors (Q16) | `cf_committee_donors` | `hub_state_committee_donors(state)` over the non-individual donors matview |
| Latest gifts ticker (Q18) | `cf_contributions` per candidate | `candidate_contributions_attributed` per candidate (indexed on `candidate_id`) |
| Money river (Q19) | `cf_money_river` | `hub_money_river(...)` over the attributed contributions, expenditures and IE |
| Polling (Q20–21) | `race_polls` / `race_polling` (270toWin, 50+1) | `race_polls` ⋈ `race_poll_results`; averages computed in the app |

**Contract differences the adapter handles:**

- **State codes:** LPT uses `MI`; the app uses `mi`.
- **Offices:** LPT's `state-representative` is the registry's `state-house`.
  District is `races.office_num` (0 = statewide).
- **Names:** contributor and candidate names come as one string ("BOTTOMS,
  KEISHA L.", "JOCELYN BENSON"). The display form comes from LPT's own
  `candidate_display_name()`.
- **Contributor type:** use `contributor_kind` (individual / self / party /
  pac / committee / other_org / public); `individual` and `self` mean a
  person.
- **Status:** derived from `on_ballot` and `disposition`.

## 4. Phases

1. **Read layer and adapter, for one state (Georgia).** Done 2026-10-18 on
   `claude/lpt-frontend`: `supabase/lpt/001_hub_read_layer.sql` applied; the
   LPT client, `src/integrations/lpt/reads.ts` and the per-hook dispatch;
   Georgia on `source: "lpt"` with its legislature (56 + 180 districts);
   `VITE_LPT_STATES` overrides the set at build time. Georgia's governor
   totals match the tracker within 0.3% for Jackson, Bottoms, Jones, Duncan
   and Thurmond; LPT is more complete for Esteves and Raffensperger (the
   tracker tracked the wrong or no committee) and lower for Carr (−$0.9M,
   attribution differs — to check). The tracker's curated names, titles,
   featured flags and lost-primary statuses for Georgia's 23 statewide
   candidates were seeded into `hub_candidate_overrides` (the tracker had no
   photos or bios for Georgia; LPT has photos for some). Every Georgia page
   was walked on the dev server against LPT.
2. **The other in-scope states.** Checked against the tracker 2026-10-18:
   - **OH and OR: on LPT** (same PR). The tracker never had their filings,
     so LPT is the only source; Ohio gets its four row offices and both
     chambers, Oregon is new with its governor's race and both chambers.
   - **AK, FL, WI, MI: hold.** LPT runs 5–10% behind the tracker's
     (Kreiss-Tomkins $4.32M vs $4.49M, Donalds $16.8M vs $17.9M, Tiffany
     $39.5M vs $42.0M): their loads are 4–9 days old and lack this week's
     scraper fixes. Florida's Jay Collins ($1.84M) is missing from LPT.
     Michigan lists Garlin Gilchrist twice (governor and secretary of
     state) with different money. Switch each once Henry's push catches up.
   - **AZ: hold.** LPT's Arizona contributions stop on 2026-07-21 (Hobbs
     $10.6M vs $15.0M through Sept 30) — the paging fix in our SLCF copy
     has not reached their pipeline.
   - **TX: hold.** LPT loads election year 2026 only, from 2026-01-05
     (Abbott $48.6M vs the TEC importer's $96.3M since June 2025), and
     carries an $86.4M "interest_investment" line for Texans for Greg
     Abbott that needs a look.
   Michigan's chambers map to `state-senate` and `state-representative`.
3. **Michigan, Texas and California into LPT — the bridge** (decided
   2026-10-18: "bridge first"). Their importers keep writing the tracker;
   `pipelines/lpt/publish_state.py` copies each state's settled `cf_*` rows
   (plus its FiftyPlusOne polls and average) into LPT's `mi_*`, `tx_*`,
   `ca_*` tables nightly (`lpt-publish.yml`, 16:00 UTC, after the three
   importers), idempotent by the tracker's ids, pruning what the tracker
   dropped, then refreshing the hub caches for the state.
   - `003_hub_state_tables.sql`: `hub_state_source` (which states read
     prefixed tables), `hub_poll_averages`, and the eight `<st>_*` tables
     per state in Henry's column shape. Applied 2026-10-18.
   - `004_hub_routing.sql`: every `hub_*` read function and the refresh
     routed by state through `hub_src()` — his shared tables and matviews
     for his states, our prefixed tables for ours. plpgsql with EXECUTE, so
     each call is planned with the actual state. Applied 2026-10-18.
   - First full run 2026-10-18 (35 min for the three states): every
     candidate's raised and spent totals match the tracker to the dollar;
     MI, TX and CA flipped to `source: "lpt"`. The same workflow's last
     step refreshes the caches for Henry's states (`LPT_HIS_STATES`
     repository variable, default `GA OH OR`) after his weekday refresh, so
     nothing is scheduled in his project.
   - The tracker is retired later by repointing the three importers at the
     prefixed tables (phase 5).
4. **Curated content.** Move `cf_candidates` photos, bios and featured flags
   into `hub_candidate_overrides`, and point the admin console
   (data-diamine's `spt-tracker-admin`) at it.
5. **Retire tracker finance** for the moved states: finance-sync,
   tx-finance-sync and the matview refreshes. Polling moves to LPT's
   `race_polls`.

## 5. Depends on Henry and Colin

- **Freshness:** LPT was last loaded 10-10 to 10-16. It needs a nightly push
  through the election, either by them or by running their push in our
  Actions.
- **This week's SLCF fixes:** Florida's quote bug, Arizona's paging, Alaska's
  pre-ticket filings and others reach LPT only once their pipeline carries
  them.
- **California rows and `hub_*` objects** must survive their push.
- **A service key** for LPT, for the California importer and the overrides
  table.
