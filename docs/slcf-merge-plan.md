# Plan: one repo for every state pipeline

Merge [hderyke/state-level-campaign-finance](https://github.com/hderyke/state-level-campaign-finance)
(SLCF) into this repo, so that state-politics-tracker holds the site and every
state data pipeline. Each state's finance data comes from one code path, written
once.

**Scope (decided 2026-10-14): Texas and Michigan keep the infrastructure they
have today. Every other state runs on SLCF.**
- **Texas** stays on the TEC importer: `scripts/data-import/tec/`,
  `tx-finance-sync.yml`, the `tx_*` staging tables and the nightly
  `publish_texas_to_cf()` copy. None of it moves or changes.
- **Michigan** stays on its importer in
  `scripts/data-import/pilot/import_pilot_finance.py` (`import_michigan`), plus
  the State Senate/House roster sync and the certified ballot-status sync that
  run before it, all through `finance-sync.yml` as today.
- **Every other state** moves to SLCF, one at a time: the pilot's other 19
  states, Ohio, and every new state.

Written 2026-10-14 against tracker `main` @ `1f33fff` and SLCF `main` @ `135cdec`.

---

## Status (2026-10-18)

**Scope (decided 2026-10-18):** before the election, SLCF feeds only the
states live on statemoney.us (AK, AZ, FL, GA, MI, OH, OR, TX, WI) plus
California's own importer; MI and TX keep their importers. CO, AR, ID and KY
were already cut over and stay. IL, PA, MN, CT, HI, MD, AL and IA reconciled
(rows below) but stay on the pilot until their SLCF scrapers are signed off;
their manifest entries keep the reconciled settings, so each cutover is one
line.

Phases 1–3 are merged (PR #23). Phase 4 is under way within that scope.

**Why it matters.** The pilot upserts with `ignore-duplicates` and never
deletes, so a row the source amended, re-filed or removed stays live next to
its replacement. States with hashed ids are worse: an edit to any hashed field
gives the row a new id, and the old copy stays. Each state's reconciliation
found this; the cutover's `prune` fixes it.

| State | On SLCF | What the cutover corrects |
|---|---|---|
| CO | 2026-10-15 | Victor Marx's spending $4.41M → $3.98M (superseded rows); Kirkmeyer's loans 15 → 3 |
| GA, AR, ID | 2026-10-15 | GA contributions $190.3M → $157.0M (47 loans, $32.5M, move to `cf_loans`) |
| WI | 2026-10-18 | WI adds 49,114 missing rows ($26.2M) and drops Rodriguez's duplicates |
| AL, MD | held on the pilot (reconciled) | AL one stale row; MD none |
| IL | held on the pilot (reconciled) | 2,247 ISBE `Archived` copies: Pritzker $117.3M → $91.8M raised, Heidner's re-filed report (1,426 rows) |
| AZ | 2026-10-18 | 27,063 copies from the pilot's overlapping pages (Robson −$2.26M contributions, −$2.2M loans); the scraper now fetches one-page date windows |
| KY | 2026-10-18 | one amended expenditure (Coleman, $5,415) |
| PA | held on the pilot (reconciled) | none in dollars; names, zips and `&amp;` cleaned; Other Receipts stay skipped |
| MN | held on the pilot (reconciled) | 505 renamed or re-filed copies ($290k), mostly Klobuchar's |
| CT | held on the pilot (reconciled) | none; zips lose eCRIS's trailing dash |
| AK | 2026-10-18 | Kreiss-Tomkins appears ($4.49M raised; the pilot's Office filter dropped his filings); Wilson, Bronson and Walker gain their pre-ticket filings |
| HI | held on the pilot (reconciled) | the pilot re-inserted every CKAN reload: Green $7.83M → $3.64M raised, $5.21M → $2.52M spent; Cordery likewise |
| FL | 2026-10-18 | this week's governor reports (Donalds $802k, Jolly $1.01M) the pilot misses since the Division started returning 502; 2,062 double-counted rows |
| IA | held on the pilot (reconciled) | the pilot's Data Hub export froze in July: nothing after 05-27 (Sand +$9.4M raised); SLCF's `--search` mode has it |
| MA | pilot until after the election (decided 2026-10-18) | contributions and loans reconcile (Healey's $2.9M savings transfer is booked as a gift today); spending differs by model: OCPF's search shows itemized line items where SLCF's bulk export has the bank payment, and transfers to savings count as spending. The parser work (swap a payment for its itemization, drop savings transfers) is prototyped in the reconciliation notes |
| KS | pilot, soft-fail | CAPTCHA |
| OH, ME | — | Cloudflare blocks datacenter IPs, GitHub's runners included; need a runner outside a datacenter |
| NV | — | SLCF has no parser |
| MI, TX | permanent | — |

Each state's reconciliation matched SLCF rows to live rows by id where the
pilot used source ids (CO, GA, AR, ID, MD, AL, WI, IL), and by content (date,
cents, normalised name, as a multiset) where it hashed. Every unmatched dollar
was traced to an amendment, a deletion at the source, a pilot duplicate or a
pilot filter; field changes on matched rows are source corrections the pilot
never picked up, plus format fixes (zips, decoded entities).

Loader options added for these states (`states.json` `_doc`): `inkind_types`,
`entity_words`, `category_field: null`, `loan_records`, and a one-off
`prune_min_share` for a first run that deletes many pilot duplicates (AZ, IL,
HI). Remove the latter once that run is done.

Earlier findings that still hold:
- **SLCF's CLI exits 0 even when a state fails.** `run_state.py` judges success
  by the rows SLCF wrote, and loads without prune when the scrape logged errors.
- **Colorado's dry run from Actions** (run 38664932934) reproduced the local
  reconciliation exactly, so the workflow path matches a local run.

## 1. Where we end up

- **One repo** (`dllpoliticalintegrity/state-politics-tracker`) holds:
  - the site;
  - SLCF's scrapers and parsers, with their full git history;
  - the Texas TEC importer and the Michigan importer, both unchanged;
  - the polling syncs;
  - one loader that writes SLCF's output into `cf_*`.
- **One pipeline per state.** `pipelines/states.json` says which pipeline feeds
  each state. The nightly workflow, the loader and the site's state registry all
  read that one file.
- **The pilot importer shrinks to Michigan.** The 2,877-line
  `scripts/data-import/pilot/import_pilot_finance.py` re-implements 20 of
  SLCF's states. Its other 19 states move to SLCF, taking their hard-won fixes
  into SLCF's scrapers. What remains is Michigan's importer and its roster and
  ballot syncs, exactly as they run today.
- **Nothing the public sees changes during the move.** The site code, the
  `cf_*` schema, the polling syncs, the Texas publish job, and the admin
  console's Sync tab all keep working throughout. Each state switches over on
  its own, only after its numbers reconcile.
- **New states get cheap.** About 18 states that SLCF already scrapes become
  "add a manifest entry and curate candidates". Ohio (live on the site with no
  finance data today) goes first.

## 2. Where things stand

| | SLCF (hderyke) | Tracker pilot importer | Tracker TEC importer |
|---|---|---|---|
| Path | its own repo | `scripts/data-import/pilot/import_pilot_finance.py` | `scripts/data-import/tec/` |
| States | 37 complete; partial or in development: KS, ME, MO, MT, NY, TX, VT; NV scraper only | 20: AL AK AZ AR CO CT FL GA HI IA ID IL KS KY MA MD MI MN PA WI | TX |
| Scope | every filer, full history (PA ~25M contribution rows, CA ~34M rows) | only committees in `cf_candidates.filer_refs`, 2025 onward | TEC bulk CSV → `tx_*` → nightly publish into `cf_*` |
| Output | per-state canonical CSVs + DuckDB, master DuckDB | upserts into `cf_*` on `(source, source_txn_id)` | upserts into `tx_*` |
| Deps | requests, curl_cffi, bs4, playwright, duckdb, boto3, … (+ selenium and pdfplumber, imported but not declared) | Python standard library only | `supabase>=2.4` |
| Schedule | the author's private daemon (`ops/`, `cloud/r2/`, not in git) | `finance-sync.yml`, 07:20 UTC | `tx-finance-sync.yml`, 12:00 UTC |
| History | 150 commits, 4.2 MB packed; authors Henry (hderyke, three identities) and Colin | | |

Facts that shape the plan:

1. **SLCF's transaction tables don't say which committee filed them.**
   `contributions.csv`, `expenditures.csv` and `loans_debts.csv` carry
   `committee_name` but no committee id. `state_filer_id` exists only on the
   committee and candidate tables. The tracker ties money to candidates through
   committee ids in `cf_candidates.filer_refs`.
2. **SLCF has no stable per-transaction key.** `filing_id` means a different
   thing in each state:
   - the transaction id in GA, MI and PA;
   - the report id in IL (`FiledDocID`), VA and OH;
   - the check number in NJ;
   - nothing at all in FL.

   `raw_file` + `row_num` changes on every re-download. The tracker needs a
   stable `source_txn_id` for idempotent upserts.
3. **Every existing non-Texas row in `cf_*` already has `source = 'slcf'`.** That
   is the column default; the pilot never sets it. Texas rows are
   `source = 'tec'`. So an SLCF loader whose ids differ from the pilot's would
   double-count the money.
4. **The pilot builds its ids two ways.**
   - It uses the source's own id for GA, MI, WI, CO, MD, AL, AR, ID, IL and HI
     (e.g. `ga:<Transaction Id>`, `mi:<contribution_id>-<cont_detail_id>`).
   - It hashes the row's fields for FL, AZ, KY, PA, MN, MA, IA, AK, CT and KS.
5. **The pilot upserts with `resolution=ignore-duplicates`.** A row that a later
   amendment corrects is never updated in `cf_*`.
6. **Seven states use different sources in the two codebases:**

   | State | Pilot | SLCF |
   |---|---|---|
   | IA | Data Hub bulk ZIP | IECDB PDFs |
   | HI | CKAN | Socrata |
   | MA | OCPF API | Azure Blob |
   | FL | per-candidate cgi query | Playwright full scrape |
   | AK | plain HTTP with retries | Playwright, because of a datacenter-IP firewall |
   | AZ, MN | different access patterns | different access patterns |

7. **Every SLCF module finds its root relative to its own file**
   (`Path(__file__).resolve().parents[n]`), and adds its root and `src/pipeline`
   to `sys.path`. The tree can move into a subdirectory as one unit with no
   path edits.
8. **The admin console (data-diamine) starts these workflows by filename.**
   `github-actions-proxy` routes `finance-sync.yml`, `polling-sync.yml` and
   `tx-finance-sync.yml` to this repo. The per-state Sync tab
   (`src/pages/spt/SyncTab.tsx`) sends `finance-sync.yml` an input of
   `{ states: "<code>" }`.

## 3. Target layout

```
state-politics-tracker/
├── src/ worker/ functions/ shared/ public/   site — unchanged
├── supabase/                                 migrations + polling edge functions — unchanged
├── pipelines/
│   ├── README.md               how to run any pipeline locally
│   ├── requirements.txt        one pinned Python environment for everything below
│   ├── states.json             manifest: per state → pipeline, cycle, flags (§7.1)
│   ├── run_state.py            entry point the workflow calls for one state
│   ├── plan_matrix.py          resolves the `states` input into a job matrix
│   ├── slcf/                   SLCF, moved in whole with its history (git subtree)
│   │   ├── config.py
│   │   ├── src/                main.py, orc.py, pipeline/{scrapers,parsers,…}, aliases/, registries/
│   │   ├── tests/
│   │   └── docs/               pipeline.md, contributing.md, states/*.md
│   └── load/                   NEW: SLCF cleaned CSVs → cf_*
│       ├── load_cf.py
│       ├── mapping.py          canonical columns → cf_* columns
│       ├── supabase.py         sb_get_all / sb_upsert / Sink, lifted from the pilot
│       └── tests/
├── scripts/data-import/
│   ├── tec/                    Texas — unchanged
│   └── pilot/                  Michigan's importer (+ roster and ballot syncs); the other
│                               19 states' code is deleted as each moves to SLCF
└── .github/workflows/
    ├── finance-sync.yml        rewritten as a per-state matrix; same name, same `states` input
    ├── tx-finance-sync.yml     unchanged
    ├── polling-sync.yml        unchanged
    ├── slcf-backfill.yml       NEW, manual: full-history or --force run for one state
    └── pipelines-ci.yml        NEW: offline tests on PRs that touch pipelines/**
```

`scripts/data-import/` stays where it is: Texas and Michigan keep their
infrastructure, so nothing there moves.

---

## 4. Phase 0 — Decisions and permissions (blocks everything)

1. **Permission and licence.** SLCF has no LICENSE file. Henry and Colin
   (SLCF's two authors) both need to agree in writing to the code moving into
   an org repo, and a licence needs choosing. Without that, copying the code in
   is a copyright problem whether the tracker repo is public or private.
2. **Transfer, then merge.** Recommended order:
   1. Henry transfers the repo to `dllpoliticalintegrity`. GitHub keeps
      redirects, so old clone URLs and links keep working.
   2. We subtree-merge it here (Phase 1).
   3. We archive the transferred repo, with a README that points to
      `pipelines/slcf/`.

   Fallback: subtree-merge straight from `hderyke/…`, and Henry archives his
   own copy.
3. **Access and review.** Henry and Colin get write access to this repo. Add a
   `CODEOWNERS` line, `pipelines/slcf/ @hderyke`, so their scrapers keep their
   reviewer. This also covers `src/aliases/contributor_type_classifier.pkl.gz`:
   loading a pickle runs code, so a change to that file deserves a named
   reviewer.
4. **SLCF's private tooling.** These stay outside the merge unless Henry wants
   them in:
   - `ops/daemon.py`, its scheduler;
   - `cloud/r2/r2.py`, its R2 push/pull, which `--fallback` depends on;
   - `web/`;
   - the separate `hderyke/state-cf-serving` repo, its serving layer and API.

   This plan replaces the scheduler with GitHub Actions and leaves the serving
   layer alone. Ask Henry two things: does anything external (his R2 bucket's
   readers, the serving API) depend on his nightly run? And can his daemon and
   our Actions avoid hitting the same state sites at the same time?
5. **Freeze date.** SLCF is active (last commit 2026-10-10). Until a set date,
   `git subtree pull` brings his upstream commits in. After it, SLCF changes
   land only here.
6. **Repo visibility: checked 2026-10-14, the repo is public.** Standard
   Actions runners are free, so the per-state matrix costs nothing. It also
   means SLCF's code is republished the moment Phase 1 merges, which makes the
   licence in item 1 urgent.
7. **Timing around the 2026-11-03 general election.** Phases 1–3 don't touch
   any state that already has finance data (Ohio has none), so they can go
   ahead now. **Hold the Phase 4 cutovers of live states until after the
   election** and its post-general filings. Those weeks bring the most traffic
   and the most filings, which is the worst time to swap a state's data
   source.

**Exit:** a written agreement, a licence, the transfer decision, and a freeze
date.

## 5. Phase 1 — Bring the code in (no behaviour change)

Work from a **full (non-shallow) clone** of the tracker, on a branch:

```sh
git checkout -b pipelines/slcf-merge origin/main
git remote add slcf https://github.com/<owner>/state-level-campaign-finance.git
git fetch slcf main                     # full history: 150 commits, ~4.2 MB
git subtree add --prefix=pipelines/slcf slcf main     # no --squash: keep authorship and blame
```

In the same PR:

1. **One environment for SLCF.** Create `pipelines/requirements.txt` from:
   - SLCF's pins;
   - `selenium` and `pdfplumber`, which SLCF imports but doesn't declare (used
     by the IA, KS and WY parsers, and the KS-v2, SC and WY scrapers).

   Texas keeps its own `scripts/data-import/tec/requirements.txt` and Python
   3.11 in `tx-finance-sync.yml`. The pilot (Michigan) needs only the standard
   library, so it runs in the SLCF environment unchanged.
2. **Ignores.** Nothing to add. SLCF's own `.gitignore` comes with it and
   already ignores `data/`, `logs/`, `metadata/`, `.playwright-profiles/` and
   `.env` inside `pipelines/slcf/`.
3. **Site build isolation.** SLCF contains no JS or TS files, so Vite, tsc,
   Vitest and `eslint .` never see it, and the build doesn't change. In
   Cloudflare Workers Builds, set **build watch paths** on both Worker projects
   (the hub and `--env michigan`) to skip `pipelines/**` and `docs/**`, so a
   scraper fix doesn't redeploy three sites.
4. **`pipelines/README.md`.** How to run the following locally:
   - an SLCF state:
     `cd pipelines/slcf && python3 src/main.py sync OH --start-year 2025 --no-aggregate`;
   - the loader;
   - Michigan and Texas (pointers to their existing scripts).

   Update SLCF's README Quick Start the same way: new paths, and no
   `git clone hderyke/…`.

**Verify before merging:**
- `npm run build` output is unchanged.
- `python3 pipelines/slcf/tests/run_all.py` passes with the deps installed. (In
  a bare environment it fails only on the missing `duckdb`.)
- One SLCF state (e.g. DE) syncs from its new path.
- `tx-finance-sync.yml` and `scripts/data-import/` show no diff.

**Exit:** merged. Production unchanged.

*Rough size: 1 day.*

## 6. Phase 2 — Make SLCF's output loadable

Now that the code lives here, the gaps are fixed in place. **Do this one state
at a time, only as each state migrates** (Ohio first, then the batches in §8),
not across all 42 parsers up front.

1. **Add `state_filer_id` to the transaction tables.** Add it to
   `CONTRIBUTIONS`, `EXPENDITURES` and `LOANS_DEBTS` in
   `pipelines/slcf/src/pipeline/columns.py`. Leave it out of the `*_AGG` lists,
   as the committee and candidate tables already do, so the master DuckDB is
   unchanged. Each parser fills it with the filing committee's id. For states
   that publish no filer ids, use the same deterministic name key SLCF already
   computes (`name_hash`), and store that same key in those candidates'
   `filer_refs`. This applies to:
   - KY, matched by recipient name;
   - AK, matched by last name plus office;
   - KS;
   - FL, where the pilot keys on the candidate.
2. **Add a `txn_id` column** (built): the source's own transaction id,
   verbatim, or blank where the state publishes none. **The loader** turns it
   into `source_txn_id`:
   - **Source ids:** `id_format` in `states.json` (default `{st}:{id}`)
     formats them, so a batch-1 state reproduces the pilot's exact ids (e.g.
     `il:r<ID>`, `md:con:<TransactionID>`). Upserts then land on the existing
     rows, keeping their uuids, with no delete.
   - **No source id:** `mapping.TxnIds` builds `{st}:h:` + an md5 of the row's
     identifying fields, plus `-n` for identical twins in the run. It never
     hashes `raw_file`, `row_num` or a report id, because amended re-filings
     must keep their id.
   - `filing_id` keeps its mixed meaning and is never used as a key.
3. **Add a `superseded` column** (built): "1" when the source marks a row as
   replaced by a later amendment. The loader always skips such rows.
   - This is not SLCF's `amended`, whose meaning varies by state. Colorado's
     `amended` is TRACER's `Amendment` flag ("this row IS an amendment"), which
     must be kept.
   - TRACER records an amendment as three rows: the original (`Amended` = Y),
     a negative reversal (`Amended` = Y) and the replacement (`Amended` = N).
     Dropping the `Amended` = Y rows leaves the current version, which is the
     pilot's rule.

   Other states' rules to carry over:
   - PA keeps the max `CampaignFinanceID` per (filer, year, cycle);
   - KS hashes without the report id.
4. **Validation.** SLCF's `validate.py` checks the tables as a whole. On a
   `--transactions` run it reports the committee and candidate tables empty,
   and its CLI exits 0 regardless. So `run_state.py` requires the cleaned
   contributions to exist and hold rows, and `load_cf.py` refuses a file
   without the loader columns. Still to add: hard failures for a blank
   `state_filer_id` and for a row-count drop against
   `metadata/<state>_latest.json`.
5. **Tests.** Add `txn_id` stability tests: parse the same raw file twice, or
   in shuffled row order, and the ids must be identical. Add fixtures for any
   parser rule the reconciliation finds.

*Rough size: about half a day per state, done alongside its migration.*

## 7. Phase 3 — One manifest, one loader, one workflow, first state live

### 7.1 `pipelines/states.json`

The single source of truth for which pipeline feeds each state:

```json
{
  "oh": { "pipeline": "slcf", "slcf_state": "Ohio", "cycle": "2026", "since": "2025-01-01",
          "nightly": true, "playwright": false },
  "mi": { "pipeline": "pilot", "cycle": "2026", "note": "permanent: Michigan keeps its importer" },
  "ga": { "pipeline": "pilot", "cycle": "2026" },
  "ky": { "pipeline": "pilot", "cycle": "2027" },
  "ks": { "pipeline": "pilot", "cycle": "2026",
          "soft_fail": "kssos.org cfr_viewer behind a CAPTCHA since 2026-10-01" },
  "tx": { "pipeline": "tec" },
  "me": { "pipeline": "none", "note": "Cloudflare WAF blocks datacenter IPs" }
}
```

- `run_state.py` and `plan_matrix.py` read it.
- It replaces the pilot's `SOFT_FAIL_STATES` and `all_states`.
- `src/states/registry.ts` imports it in place of the hand-kept `SLCF_READY`
  set, which is already stale: it lists 24 states while SLCF covers about 40.
  `tsconfig.app.json` needs `"resolveJsonModule": true` added; it isn't set
  today. Vite already imports JSON.
- Moving a state from `pilot` to `slcf` is a one-line PR, and so is rolling it
  back.

### 7.2 Loader (`pipelines/load/load_cf.py --state XX [--dry-run --report out.csv]`)

1. **Committee → candidate map.** Build it from `cf_candidates.filer_refs`
   (paged with `sb_get_all`; the table passed 1,000 rows with the Michigan
   legislature). This **retires the pilot's hard-coded `COMMITTEES` dict**,
   which today has to be kept by hand in step with `filer_refs`.
   - No backfill is needed. Checked 2026-10-14: all 144 `COMMITTEES` entries
     are already in the matching candidate's `filer_refs`.
   - The 41 non-legislative candidates with empty `filer_refs` aren't imported
     by the pilot today either. They are mostly `lost_primary` / `withdrawn`,
     plus all of NV and ME. Ohio has one, `don-kissick`; give him a committee
     id before Ohio goes live if he has a committee.
2. **Stream the cleaned CSVs.** Read
   `pipelines/slcf/data/<State>/cleaned/{contributions,expenditures,loans_debts}.csv`.
   Keep rows whose `state_filer_id` is in the map and whose date is at or after
   the manifest's `since`.
3. **Map the columns** (`mapping.py`, unit-tested):

   | cf_* column | from SLCF |
   |---|---|
   | `candidate_id` | the map, via `state_filer_id` |
   | `committee_id` | `<st>:<state_filer_id>` (pilot format; FL keeps `fl:<slug>`) |
   | `source_txn_id` | `txn_id` |
   | `source` | `'slcf'` — same as every existing non-TX row |
   | `cycle` | the manifest's `cycle` |
   | contributions: `contributor_type` | `contributor_type` → `INDIVIDUAL` / `ENTITY` |
   | contributions: `contributor_last_name` / `first_name` | split `contributor_name`; organisations go whole into `last_name` |
   | contributions: `employer`, `occupation`, `amount` | as is |
   | contributions: `contribution_date` | `date` |
   | contributions: `city` / `state` / `zip` | `contributor_city` / `_state` / `_zip` |
   | contributions: `source_form_type` | `transaction_type`, normalised via `src/aliases/transaction_categories.csv` (keep `INKIND`) |
   | expenditures: `payee_*` | `payee_*` |
   | expenditures: `category` | `category` |
   | expenditures: `description` | `purpose` |
   | expenditures: `expenditure_date` | `date` |
   | loans: `lender_last_name` / `first_name` / `type` | `counterparty_*` |
   | loans: `amount` | `original_amount` |
   | loans: `loan_date` | `date` |

   Keep the pilot's rule that loan-type contribution rows go to `cf_loans`.
   Keep its relabels as well: GA's unitemized lump sums and CT's Citizens'
   Election Program grants. They move into the SLCF parsers, so every consumer
   gets them.
4. **Upsert.** Use the pilot's `sb_upsert`, including the PGRST102 key-padding
   fix and 2,000-row batches. **Decision needed:** keep
   `resolution=ignore-duplicates` (today's behaviour, amendments never reach the
   site) or switch to `merge-duplicates`, so a corrected amount updates the
   existing row and keeps its uuid. Recommended: merge.
5. **`--dry-run`** writes nothing. It produces the reconciliation report in
   §8.2.
6. **No matview refresh in the loader.** The workflow refreshes once, at the
   end of the run.

### 7.3 `pipelines/run_state.py XX [--dry-run]` (built)

What each SLCF matrix job runs:
1. Install Playwright's Chromium if the manifest says the state needs it.
2. Run `pipelines/slcf/src/main.py --daemon --no-report sync <ST> --start-year
   <since year> --no-aggregate --no-fec-ie --transactions`.
   - `--no-fec-ie`: SLCF pulls FEC independent expenditures by default, with
     `DEMO_KEY` when no `FEC_API_KEY` is set, and the loader has no use for
     them until Phase 6.
   - `--transactions`: the loader never reads the committee and candidate
     sweeps, and several are slow (CO's SeqID probe, IN's CommitteeDetail
     pages).
3. Require that SLCF wrote contributions.
4. Run `load_cf.py`.

A `soft_fail` state reports a failure as a warning.

The pilot states are not split across the matrix. They run in one `pilot` job,
exactly as tonight: `import_pilot_finance.py --states <codes> --no-refresh`.
The new `--no-refresh` flag is opt-in; run by hand, the pilot still refreshes.
Michigan is permanently `pilot`, so its roster and ballot syncs keep running
first, inside the pilot. Texas never enters this workflow.

### 7.4 `finance-sync.yml` (built)

See `.github/workflows/finance-sync.yml`. It keeps the filename, the 07:20 UTC
schedule, the `states` input and the concurrency group. Its jobs:

| Job | What it does |
|---|---|
| `plan` | `plan_matrix.py` splits the selection. Unknown codes, Texas and `none` states fail here. |
| `pilot` | One job, if any pilot states are selected. |
| `slcf` | A matrix, `fail-fast: false`, 6 at a time. Uploads SLCF's logs, its validation JSON and any reconciliation CSV as `finance-<state>`. |
| `refresh` | `refresh_cf_finance_views()` once, tolerating the gateway's 502/504. |

**`dry_run` input.** Every named state runs through SLCF + `load_cf.py
--dry-run`, pilot state or not, and nothing is written. This is how a state is
reconciled in Actions before its cutover. Michigan refuses a dry run.

Notes:

- **The console keeps working unchanged.** Its Sync tab still sends
  `{ states: "<code>" }` and lists runs by filename.
- **No raw-file cache in the first version.** Each run re-downloads the
  cycle's files, as the pilot does. Add a per-state cache only for states
  whose download passes about 30 minutes.
- **`slcf-backfill.yml`** (not built): a manual full-history or `--force`
  re-pull. If it should be dispatchable from the console, add it to
  data-diamine's `WORKFLOW_REPO` map.
- **`pipelines-ci.yml`** (built) runs on PRs that touch the pipelines, offline:
  - SLCF's tests;
  - `python3 -m unittest discover -s pipelines/tests`;
  - a compile of every scraper and parser;
  - tonight's planned matrix.

### 7.5 First state live: Ohio

Ohio is the proof run:
- it is already live on the site, with curated candidates;
- it has **no finance rows**, so nothing can double-count;
- its SLCF parser is marked complete (the README notes it is "validated
  end-to-end for the Candidate Committee group").

Steps:
1. ~~Do the Phase 2 work for `ohio.py`.~~ Done: `state_filer_id` = MASTER_KEY.
   Ohio publishes no transaction id, so its rows get hashed ids.
2. ~~Fill Ohio's `filer_refs`.~~ Five of its six candidates already have them;
   `don-kissick` has none.
3. Dispatch Finance sync with `states: oh`, `dry_run: true`. Spot-check
   `finance-oh`'s totals against Ohio's own search site, and check whether
   amended reports repeat rows. The Ohio parser's docstring says amendments
   weren't verified.
4. Flip `oh` to `nightly: true`.
5. Watch three nightlies.

**Exit:** Ohio's money pages are populated nightly by SLCF + the loader, and
the other 20 states are still on the pilot.

*Rough size: 3–5 days.*

## 8. Phase 4 — Move the other 19 pilot states over, one at a time

### 8.1 Batches

| Batch | States | Why grouped | Cutover |
|---|---|---|---|
| **1 — same ids** | GA, WI, CO, MD, AL, AR, ID, IL | The pilot keys on the source's own transaction id, so the loader can emit the identical `source_txn_id` (confirm per state that SLCF's parser keeps those source fields). | **No delete.** Upserts land on the existing rows; uuids are kept. |
| **2 — hashed ids, same source** | AZ, KY, PA, MN, CT | The pilot hashes its rows; SLCF's hash inputs will differ. | **Replace:** back up, load; the same run's prune deletes the legacy rows (§8.3). |
| **3 — different source or fetch** | FL, AK, IA, HI, MA | The two codebases pull from different places (§2 fact 6); HI's pilot id is a CKAN row number, not a transaction id. | Reconcile first. If the pilot's source is better, **port its fetch into the SLCF scraper**, so it becomes SLCF code. Then replace. |
| **4 — blocked** | KS | Both are broken: the pilot by the CAPTCHA since 2026-10-01, SLCF's `kansas_v2` still in development. | Port the pilot's CFR-viewer scrape into `kansas_v2`; migrate when the CAPTCHA allows. It stays `pilot` + `soft_fail` until then. |

Michigan is not in any batch. It keeps the pilot's importer, roster sync and
ballot-status sync.

Port the pilot's hard-won fixes into the matching SLCF scrapers as each state
moves:
- Alabama's GlobalSign intermediate, fetched from AIA at runtime;
- Wisconsin's 99,999-row truncation (SLCF already splits windows adaptively —
  confirm the two agree);
- Illinois's line-by-line streaming of the ~1 GB dumps, with `IL_SINCE`;
- Alaska's retry-everything session handling;
- Pennsylvania's amended-filing dedupe;
- Iowa's dead Socrata endpoint.

### 8.2 Reconciliation (each state, before cutover)

1. Run `load_cf.py --state XX --dry-run --report recon/XX.csv`. For each
   committee and table, compare against the live `cf_*` rows for the same
   committees:
   - row count;
   - total dollars;
   - min/max date;
   - top 10 donors.
2. **Accept** when totals agree within 0.5% per committee, or every difference
   is explained in writing in `pipelines/slcf/docs/states/<state>.md`. Every
   committee in `filer_refs` with rows today must also have rows in SLCF.
3. Keep the report with the cutover PR.

### 8.3 Cutover (each state)

1. Open a PR that flips `"pipeline": "pilot"` → `"slcf"` for the state, and
   attach the reconciliation report.
2. **Merge, back up, dispatch.** Right after the merge, before the state's
   first SLCF run (the next nightly would run it too), copy its rows to the
   `private` schema:
   ```sql
   create table private.cf_contributions_backup_YYYYMMDD_xx as
     select * from public.cf_contributions
     where source = 'slcf' and candidate_id in (select id from public.cf_candidates where state = 'xx');
   -- same for cf_expenditures and cf_loans
   ```
   Then dispatch Finance sync for the state. For hashed-id states the run
   loads every row under new ids and its prune deletes the pilot's rows, so
   there is no empty window (set a one-off `prune_min_share` where the pilot
   stored so many duplicates that the load is under 90% of the live rows).
   Prune filters on `source = 'slcf'` and the state's candidates, so Texas's
   `'tec'` rows can never be touched. The site's summary pages read matviews,
   which change only at the end-of-run refresh.
3. Compare the state's totals with the backup, then watch two nightlies.

**Rollback:** flip the manifest back to `pilot`, delete the state's
`source = 'slcf'` rows and dispatch the state (or restore the backup). The pilot re-pulls
the whole cycle each night (Wisconsin needs `WI_SINCE=2025-01-01`), so a re-run
restores everything. The backup tables are a second safety net.

*Rough size: about 1 day per state including reconciliation. About 4–5 weeks
elapsed for all 20, run in batches.*

## 9. Phase 5 — Retire the pilot, update the docs

Two weeks after the last cutover, with no rollbacks:

1. Cut `scripts/data-import/pilot/import_pilot_finance.py` down to Michigan:
   - delete the other 19 `import_<state>` functions, their `COMMITTEES`
     entries and their helpers;
   - keep `import_michigan`, `sync_michigan_legislature`,
     `sync_michigan_ballot_status`, the `MiTN` and listing helpers, and the
     shared `http` / `sb_*` / `Sink` code they use.

   Michigan's behaviour must not change: diff a dry run before and after.
   Kansas is the exception: if it is still `pilot`, keep its importer too until
   `kansas_v2` replaces it.
2. Update:
   - this repo's `README.md` ("powered by SLCF" → "SLCF lives in
     `pipelines/slcf/`");
   - `docs/plan.md`. Its sections "What we're reusing vs. what SLCF gives us"
     and the `scripts/data-import/slcf/import_slcf_finance.py` design ("we
     don't fork their scrapers") are superseded; point them here.
   - the registry comment that names hderyke's repo.
3. Archive the old SLCF repo, with a pointer README.
4. In data-diamine:
   - edit the `WORKFLOW_REPO` comments and the Sync tab copy if anything about
     the workflows changed;
   - update the State Politics Tracker paragraph of `CLAUDE.md` to say the
     pipelines live in this repo.

## 10. Phase 6 — Expand (after the merge is done)

1. **States SLCF already covers that the site doesn't show yet:**
   - DE, IN, LA, NH, NJ, NM, OR, SC, TN, VA, WA, WV, WY: complete in SLCF;
   - NY, VT: the parser is partial;
   - MS: complete, but has no 2024–26 data until e-filing is mandatory in 2027;
   - MO: semi-automated, with an Imperva firewall, so not a nightly candidate.

   The pipeline side is only a manifest entry. The real cost is editorial:
   curated `cf_candidates` with `filer_refs`, and a `LIVE_CONFIG` entry.
2. **Nevada.** It is live on the site with no finance data. SLCF has
   `scrapers/nevada.py` but no parser; write one.
3. **Independent expenditures outside Texas.** SLCF's expenditure and
   committee rows carry `affiliated_candidate_name` and `support_oppose`, and
   `fec_ie.py` reads FEC independent expenditures. Map these into
   `cf_ie_committees` / `cf_independent_expenditures` /
   `cf_ie_contributions`. The pilot loads none of these today, so this is new
   coverage. SLCF's link is by name, not id, so it needs a review step. Add an
   `FEC_API_KEY` repo secret; `DEMO_KEY` is heavily rate-limited.
4. **Rows that disappear upstream** (built early, because Colorado needs it):
   - `load_cf.py --prune`, or `"prune": true` in the manifest, deletes live
     rows inside the date window whose id SLCF no longer has, for example rows
     amended away.
   - It runs only after a complete load, and refuses if the load holds fewer
     than 90% of the live rows in the window.
   - Its deletes filter on `source = 'slcf'` and the candidate.
   - It is off by default; turn it on per state at cutover, after the dry run
     shows its `stale` rows are real.
5. **"Last synced" per state.** This is an open question in `docs/plan.md`.
   Write each state's last successful load into a small `cf_sync_status` table,
   and show the stamp on the money pages.
6. **Texas.** It stays on TEC; SLCF's Texas parser is partial. Revisit only if
   SLCF's Texas parser ever beats TEC on coverage.
7. **California.** It is still external (ca-gov-polling). SLCF covers it, so
   that site could later read from here.
8. **No pipeline anywhere yet:** MT (SLCF in development), NE, NC, ND, OK, RI,
   SD, UT. New scrapers go into `pipelines/slcf/` in SLCF's format.

## 11. State-by-state summary

| State(s) | Today | Target | When |
|---|---|---|---|
| OH | live, no finance | SLCF | Phase 3 (first) |
| MI | pilot (+ roster and ballot syncs) | **unchanged** | — |
| GA, WI, CO, MD, AL, AR, ID, IL | pilot | SLCF, same ids | Phase 4, batch 1 |
| AZ, KY, PA, MN, CT | pilot | SLCF, replace rows | Phase 4, batch 2 |
| FL, AK, IA, HI, MA | pilot | SLCF after source reconciliation | Phase 4, batch 3 |
| KS | pilot (soft-fail, CAPTCHA) | SLCF `kansas_v2` | Phase 4, batch 4 |
| TX | TEC | **unchanged** | — |
| ME | live, polling only | none (WAF) | — |
| NV | live, no finance | SLCF, new parser | Phase 6 |
| DE IN LA MS NH NJ NM NY OR SC TN VT VA WA WV WY | not on site | SLCF + curation | Phase 6 |
| MO | not on site | SLCF, manual runs | Phase 6 |
| CA | external site | — | — |
| MT NE NC ND OK RI SD UT | nothing | new scrapers | later |

## 12. Things that must keep working throughout

- **Workflow names and inputs.** `finance-sync.yml` and its `states` input, and
  `tx-finance-sync.yml`. data-diamine starts them by filename through
  `github-actions-proxy`.
- **Texas and Michigan, untouched.** `tx-finance-sync.yml`, the TEC importer,
  Michigan's importer and its roster and ballot syncs run as they do today.
  Every Michigan dispatch of `finance-sync.yml` still runs the pilot.
- **Texas rows.** The Texas publish (`publish_texas_to_cf()`, pg_cron 14:30 UTC)
  and its `source = 'tec'` rows. Every delete in this plan filters on
  `source = 'slcf'`.
- **Matview refreshes.** One refresh after each finance run, plus the 09:15 UTC
  `cf-finance-refresh-nightly` backstop.
- **Polling.** `polling-sync.yml` and its two edge functions are untouched.
- **The schema.** The `cf_*` schema needs no migration for Phases 1–5. The
  backups are ad-hoc dated tables (`<table>_backup_YYYYMMDD`), the org's
  existing convention.
- **The site build and deploy.**

## 13. Risks

| Risk | Mitigation |
|---|---|
| Money double-counted at a state's cutover | Batch 1 keeps the same ids. Batches 2–4 back up and delete legacy rows before loading. Every state is reconciled first, and switches over alone. |
| A truncated download wipes or shrinks a state | The loader only adds or updates rows, never deletes, until Phase 6's guarded sweep. Validation fails the run on large row-count drops. |
| State sites block GitHub's datacenter IPs (AK, MN entity calls, MO, ME) | Keep the access path that works from Actions today (e.g. AK's plain HTTP with retries) when porting into SLCF. Run entity sweeps weekly, not nightly. For a state that can only run from elsewhere, use a self-hosted runner, or leave it on manual runs. |
| SLCF's full-state scrapes are heavier than the pilot's targeted queries (FL, AZ, MA, MD) | `--start-year`, per-state timeouts, `max-parallel`. Where the targeted query is better, port it into SLCF as a mode, not a second code path. |
| Henry's daemon and our Actions both scraping the same sites nightly | Agree on a schedule in Phase 0, or retire his daemon for the states we run. |
| Upstream SLCF changes during the migration | A freeze date. `git subtree pull` until then. |
| Undeclared dependencies (selenium, pdfplumber) break a state at runtime | One pinned requirements file in Phase 1; CI imports every parser module. |
| Pickled classifier replaced with something malicious | CODEOWNERS review on `pipelines/slcf/src/aliases/`. |
| Actions minutes on a private repo | Check the repo's visibility in Phase 0; trim with `max-parallel` and per-state schedules if needed. |

## 14. Open questions

1. Do Henry and Colin agree, under which licence, and do we transfer the repo
   or copy from it?
2. Do SLCF's private ops (daemon, R2 sync, `state-cf-serving`) move here, stay
   with Henry, or get retired? Does anything outside this org read Henry's R2
   data?
3. Should the loader let amendments update existing rows (`merge-duplicates`,
   recommended), or keep today's `ignore-duplicates`?
4. Which single Python version should all the pipelines run on?
5. ~~Is `state-politics-tracker` public or private?~~ Public (checked
   2026-10-14): Actions minutes are free, and the licence question is urgent.
6. After Phase 5, should California's site read SLCF's California data from
   here?
