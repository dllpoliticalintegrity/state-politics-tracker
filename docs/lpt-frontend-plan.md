# Plan: the State Politics Tracker frontend on Local Politics Tracker data

Written 2026-10-18. The target, as decided that day:

- **Data and pipeline:** Henry's and Colin's. The SLCF scrapers feed the Local
  Politics Tracker Supabase project (`rwiueylzgcgnzypdyszi`, "LPT"), the
  database behind statemoney.us.
- **Frontend:** this repo's React app, with the hub plus one Cloudflare Worker
  and domain per state (michiganpoliticstracker.com, texaspoliticstracker.com,
  and so on).
- **States:** the ones live on statemoney.us (AK, AZ, FL, GA, MI, OH, OR, TX,
  WI) plus California.

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
  in order. Every object is prefixed `hub_`.

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

1. **Read layer and adapter, for one state (Georgia).** Georgia is on SLCF in
   both databases, so the two sets of numbers can be compared directly.
   - Write `supabase/lpt/001_hub_read_layer.sql`: the overrides table and the
     `hub_*` functions.
   - Add the LPT client and the per-hook dispatch, with `source: "lpt"` on
     Georgia.
   - Verify page by page against the tracker numbers.
   - Ship behind the flag.
2. **The other in-scope states:** AZ, AK, FL, WI, OH (new on the site), OR
   (new), then MI and TX. Each needs its races in the registry (or the
   registry reading `races`) and the same page-by-page check. Michigan's
   chambers map to `state-senate` and `state-representative`.
3. **California into LPT.** The CAL-ACCESS importer (`ca-finance-sync.yml`)
   writes LPT's tables: candidates, committees, contributions, expenditures,
   races and participants. Needs an LPT service key as a GitHub secret, and
   Henry's push must leave `CA` rows alone. Until then California reads from
   tracker.
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
