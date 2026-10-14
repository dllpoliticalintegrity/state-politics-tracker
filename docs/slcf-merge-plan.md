# Plan: one repo for every state pipeline

Merge [hderyke/state-level-campaign-finance](https://github.com/hderyke/state-level-campaign-finance)
(SLCF) into this repo, so that state-politics-tracker holds the site and every
state data pipeline. Each state's finance data comes from one code path, written
once.

Written 2026-10-14 against tracker `main` @ `1f33fff` and SLCF `main` @ `135cdec`.

---

## 1. Where we end up

- **One repo** (`dllpoliticalintegrity/state-politics-tracker`) holds:
  - the site;
  - SLCF's scrapers and parsers, with their full git history;
  - the Texas TEC importer;
  - the polling syncs;
  - one loader that writes into `cf_*`.
- **One pipeline per state.** `pipelines/states.json` says which pipeline feeds
  each state. The nightly workflow, the loader and the site's state registry all
  read that one file.
- **The pilot importer is retired.** That is the 2,877-line
  `scripts/data-import/pilot/import_pilot_finance.py`, which re-implements 20 of
  SLCF's states. Its fixes and its Michigan roster sync move into SLCF or into
  the new loader first.
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
│   ├── load/                   NEW: SLCF cleaned CSVs → cf_*
│   │   ├── load_cf.py
│   │   ├── mapping.py          canonical columns → cf_* columns
│   │   ├── supabase.py         sb_get_all / sb_upsert / Sink, lifted from the pilot
│   │   └── tests/
│   ├── rosters/
│   │   └── michigan.py         MI legislature roster + ballot status, lifted from the pilot
│   └── tec/                    moved from scripts/data-import/tec
└── .github/workflows/
    ├── finance-sync.yml        rewritten as a per-state matrix; same name, same `states` input
    ├── tx-finance-sync.yml     paths updated only
    ├── polling-sync.yml        unchanged
    ├── slcf-backfill.yml       NEW, manual: full-history or --force run for one state
    └── pipelines-ci.yml        NEW: offline tests on PRs that touch pipelines/**
```

`scripts/data-import/pilot/` stays where it is until Phase 5 deletes it. There's
no point moving a file that is about to be deleted.

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
6. **Repo visibility and Actions minutes.** A public repo gets standard runners
   free. A private one pays in minutes. Today's pipeline is one nightly job
   capped at 120 minutes, at most about 3,600 minutes a month. A per-state
   matrix adds roughly 1–2 minutes of setup per state per night: about 25
   states × 30 nights ≈ 750–1,500 extra minutes a month, before counting any
   new states.

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

1. **Move TEC.** `git mv scripts/data-import/tec pipelines/tec`, then update the
   three paths in `tx-finance-sync.yml`: `cache-dependency-path`, the
   `pip install -r` line, and the `cd`.
2. **One environment.** Create `pipelines/requirements.txt` from:
   - SLCF's pins;
   - `selenium` and `pdfplumber`, which SLCF imports but doesn't declare (used
     by the IA, KS and WY parsers, and the KS-v2, SC and WY scrapers);
   - `supabase` for TEC.

   Pick one Python version for everything. 3.12 is suggested, but first run
   SLCF's tests, the TEC importer and the pilot on it. TEC runs on 3.11 today,
   and SLCF's `config.py` already copes with 3.13's stricter TLS checks.
3. **Ignores.** Nothing to add. SLCF's own `.gitignore` comes with it and
   already ignores `data/`, `logs/`, `metadata/`, `.playwright-profiles/` and
   `.env` inside `pipelines/slcf/`.
4. **Site build isolation.** SLCF contains no JS or TS files, so Vite, tsc,
   Vitest and `eslint .` never see it, and the build doesn't change. In
   Cloudflare Workers Builds, set **build watch paths** on both Worker projects
   (the hub and `--env michigan`) to skip `pipelines/**` and `docs/**`, so a
   scraper fix doesn't redeploy three sites.
5. **`pipelines/README.md`.** How to run the following locally:
   - an SLCF state:
     `cd pipelines/slcf && python3 src/main.py sync OH --start-year 2025 --no-aggregate`;
   - the loader;
   - TEC.

   Update SLCF's README Quick Start the same way: new paths, and no
   `git clone hderyke/…`.

**Verify before merging:**
- `npm run build` output is unchanged.
- `python3 pipelines/slcf/tests/run_all.py` passes with the deps installed. (In
  a bare environment it fails only on the missing `duckdb`.)
- One SLCF state (e.g. DE) syncs from its new path.
- A manual `tx-finance-sync.yml` run passes with the moved paths.

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
2. **Add a `txn_id` column: one stable, namespaced id per row.**
   - Use the source's own transaction id when the state publishes one.
   - Otherwise, use a deterministic hash of the row's identifying fields, plus
     an occurrence index within identical rows. This is the pilot's
     `Sink.txn_id` rule.
   - **Never hash `raw_file`, `row_num` or a report id.** Amended re-filings
     must hash to the same id; Kansas taught us this.
   - For the batch-1 states in §8, **emit exactly the pilot's format** (e.g.
     `mi:<contribution_id>-<cont_detail_id>`, `il:r<ID>`, `md:con:<TransactionID>`).
     Upserts then land on the existing rows: same uuids, no delete.
   - `filing_id` keeps its current mixed meaning. Document it in
     `columns.py`, and never use it as a key.
3. **Amendments.** Pin down per state that superseded rows are dropped by the
   parser. The pilot's rules are the reference:
   - PA keeps the max `CampaignFinanceID` per (filer, year, cycle);
   - CO skips amended rows and dedupes `RecordID`s across overlapping year
     files;
   - KS hashes without the report id.
4. **Validation.** Extend `validate.py` with hard failures that stop the run
   before anything is loaded:
   - `state_filer_id` is blank on transaction rows;
   - `txn_id` repeats within a run;
   - the row count drops more than X% against the last run's
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
   - One-off step first: write every `COMMITTEES` entry missing from
     `filer_refs` into `filer_refs`, using a dated backup of `cf_candidates`.
   - Then confirm with a query that every tracked candidate in a migrating
     state has a ref.
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

### 7.3 `pipelines/run_state.py XX`

Branches on the manifest entry:

- **`slcf`:**
  1. Run `pipelines/rosters/michigan.py` first when the state is `mi`, so new
     legislature rows get money the same night.
  2. Run `python3 pipelines/slcf/src/main.py --daemon sync <ST> --start-year <since year> --no-aggregate`.
  3. Run `load_cf.py --state XX`.
- **`pilot`:** run
  `python3 scripts/data-import/pilot/import_pilot_finance.py --states XX --no-refresh`.
  The `--no-refresh` flag is new; the pilot refreshes matviews itself today.
- **`tec` / `none`:** nothing. Texas has its own workflow.
- **`soft_fail` set:** a failure prints `::warning::` and exits 0, as the pilot
  does today.

Check per state whether the parser needs SLCF's entity files (committees and
candidates). Where it does and the sweep is slow, refresh entities weekly from
a cache instead of every night. Examples of slow sweeps: CO's SeqID probe, IN's
CommitteeDetail pages, MI's roughly 10,700 committees.

### 7.4 `finance-sync.yml`, rewritten

The filename, the 07:20 UTC schedule, the `states` input, the concurrency
group and the "skip if the secret is missing" guard all stay the same.

```yaml
name: Finance sync
on:
  schedule:
    - cron: "20 7 * * *"
  workflow_dispatch:
    inputs:
      states:
        description: "Space-separated state codes (blank = all)"
        required: false
        default: ""
concurrency:
  group: finance-sync
  cancel-in-progress: false
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      states: ${{ steps.pick.outputs.states }}
    steps:
      - uses: actions/checkout@v4
      # Prints states=["ga","mi",…]: the input's codes, or every nightly-enabled
      # manifest entry when blank. Unknown codes fail here, not mid-run.
      # The input goes through env, not ${{ }} inside the script, so it can't inject shell.
      - id: pick
        env:
          STATES: ${{ inputs.states }}
        run: python3 pipelines/plan_matrix.py $STATES >> "$GITHUB_OUTPUT"

  sync:
    needs: plan
    runs-on: ubuntu-latest
    timeout-minutes: 120
    strategy:
      fail-fast: false          # one state's outage must not cancel the rest
      max-parallel: 6
      matrix:
        state: ${{ fromJSON(needs.plan.outputs.states) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: pipelines/requirements.txt
      - run: pip install -r pipelines/requirements.txt
      - name: Run ${{ matrix.state }}
        env:
          SUPABASE_URL: https://lohxdfrxnxuxjdvvyfjc.supabase.co
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          FEC_API_KEY: ${{ secrets.FEC_API_KEY }}   # SLCF's fec_ie.py; falls back to DEMO_KEY
        run: |
          if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
            echo "::warning::SUPABASE_SERVICE_ROLE_KEY secret not set — skipping."; exit 0
          fi
          # Installs Playwright's Chromium itself when the manifest says the state needs it.
          python3 pipelines/run_state.py ${{ matrix.state }}
      - uses: actions/upload-artifact@v4       # SLCF's per-run log.jsonl + report.html + validation JSON
        if: always()
        with:
          name: logs-${{ matrix.state }}
          path: pipelines/slcf/logs/
          if-no-files-found: ignore
          retention-days: 14

  refresh:
    needs: sync
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      # Same call and the same 502/504 tolerance as the pilot's main(): the refresh
      # runs ~3 min server-side after the gateway gives up at ~2 min. The pg_cron
      # job cf-finance-refresh-nightly (09:15 UTC) stays as the backstop.
      - run: |
          CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
            "https://lohxdfrxnxuxjdvvyfjc.supabase.co/rest/v1/rpc/refresh_cf_finance_views" \
            -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
            -H "Content-Type: application/json" -d '{}')
          case "$CODE" in 2*|502|504) echo "refresh: HTTP $CODE";; *) exit 1;; esac
        env:
          KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

Notes:

- **The console keeps working unchanged.** Its Sync tab still sends
  `{ states: "oh" }` and lists runs by filename. A run's status covers all its
  states, as it does now.
- **No raw-file cache in the first version.** Each night re-downloads the
  cycle's files, which is what the pilot already does. Add a per-state cache
  (an R2 bucket on the existing Cloudflare account, or `actions/cache`) only
  for states whose nightly download passes about 30 minutes.
- **`slcf-backfill.yml`** is a manual run (`state`, `start_year`, `force`) for
  full-history or `--force` re-pulls. It never runs on a schedule. To make it
  dispatchable from the console, add it to data-diamine's `WORKFLOW_REPO` map
  in `github-actions-proxy` (and to `SyncTab.tsx` if it should appear there).
  data-diamine's CLAUDE.md requires that for any new workflow.
- **`pipelines-ci.yml`** runs on PRs that touch `pipelines/**`, offline only:
  - `python3 pipelines/slcf/tests/run_all.py`;
  - `python3 -m unittest discover -s pipelines/load/tests`;
  - a loader `--dry-run` against fixture CSVs.

  It never hits state sites or Supabase. This repo has no CI today, so this is
  new; it keeps a parser edit from silently breaking the loader.

### 7.5 First state live: Ohio

Ohio is the proof run:
- it is already live on the site, with curated candidates;
- it has **no finance rows**, so nothing can double-count;
- its SLCF parser is marked complete (the README notes it is "validated
  end-to-end for the Candidate Committee group").

Steps:
1. Do the Phase 2 work for `ohio.py`.
2. Fill Ohio's `filer_refs`.
3. Dry-run, and spot-check totals against Ohio's own search site.
4. Flip `oh` to `nightly: true`.
5. Watch three nightlies.

**Exit:** Ohio's money pages are populated nightly by SLCF + the loader, and
the other 20 states are still on the pilot, via `run_state.py`.

*Rough size: 3–5 days.*

## 8. Phase 4 — Move the 20 pilot states over, one at a time

### 8.1 Batches

| Batch | States | Why grouped | Cutover |
|---|---|---|---|
| **1 — same ids** | GA, MI, WI, CO, MD, AL, AR, ID, IL | The pilot keys on the source's own transaction id, so the loader can emit the identical `source_txn_id` (confirm per state that SLCF's parser keeps those source fields, e.g. MI's `cont_detail_id`). | **No delete.** Upserts land on the existing rows; uuids are kept. |
| **2 — hashed ids, same source** | AZ, KY, PA, MN, CT | The pilot hashes its rows; SLCF's hash inputs will differ. | **Replace:** back up, delete the state's legacy rows, load (§8.3). |
| **3 — different source or fetch** | FL, AK, IA, HI, MA | The two codebases pull from different places (§2 fact 6); HI's pilot id is a CKAN row number, not a transaction id. | Reconcile first. If the pilot's source is better, **port its fetch into the SLCF scraper**, so it becomes SLCF code. Then replace. |
| **4 — blocked** | KS | Both are broken: the pilot by the CAPTCHA since 2026-10-01, SLCF's `kansas_v2` still in development. | Port the pilot's CFR-viewer scrape into `kansas_v2`; migrate when the CAPTCHA allows. It stays `pilot` + `soft_fail` until then. |

Michigan (batch 1) brings `pipelines/rosters/michigan.py` with it. Move
`sync_michigan_legislature`, `sync_michigan_ballot_status` and the `MiTN` and
listing helpers out of the pilot unchanged. Run them before Michigan's load.

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
2. **Batch 2–4 only:** run a dated SQL snippet off-peak (after the nightly, not
   near the 09:15 refresh):
   ```sql
   create table cf_contributions_backup_YYYYMMDD_XX as
     select * from cf_contributions
     where source = 'slcf' and candidate_id in (select id from cf_candidates where state = 'xx');
   -- same for cf_expenditures and cf_loans, then:
   delete from cf_contributions
     where source = 'slcf' and candidate_id in (select id from cf_candidates where state = 'xx');
   ```
   Always filter on `source = 'slcf'`, so Texas's `'tec'` rows can never be
   touched. Then dispatch Finance sync for that state from the console. The
   site's summary pages read matviews, which change only at the end-of-run
   refresh, so they keep showing the old numbers until the new ones land.
3. Merge, then watch two nightlies. Re-run the reconciliation against the new
   rows.

**Rollback:** flip the manifest back to `pilot`. For batches 2–4, also delete
the state's `source = 'slcf'` rows and dispatch the state. The pilot re-pulls
the whole cycle each night (Wisconsin needs `WI_SINCE=2025-01-01`), so a re-run
restores everything. The backup tables are a second safety net.

*Rough size: about 1 day per state including reconciliation. About 4–5 weeks
elapsed for all 20, run in batches.*

## 9. Phase 5 — Retire the pilot, update the docs

Two weeks after the last cutover, with no rollbacks:

1. Delete `scripts/data-import/pilot/` and the `pilot` branch of
   `run_state.py`. Kansas is the exception: if it is still `pilot`, keep only
   its importer, moved to `pipelines/kansas_cfr/` until `kansas_v2` replaces it.
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
4. **Rows that disappear upstream.** Once runs are stable, the loader can
   delete rows in the state's date window that no longer appear in the source,
   for example amended away. Guard it: only after a complete, validated run,
   and only if the row count is at least 95% of the last run.
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
| GA, MI, WI, CO, MD, AL, AR, ID, IL | pilot | SLCF, same ids | Phase 4, batch 1 |
| AZ, KY, PA, MN, CT | pilot | SLCF, replace rows | Phase 4, batch 2 |
| FL, AK, IA, HI, MA | pilot | SLCF after source reconciliation | Phase 4, batch 3 |
| KS | pilot (soft-fail, CAPTCHA) | SLCF `kansas_v2` | Phase 4, batch 4 |
| TX | TEC | TEC (moved to `pipelines/tec/`) | Phase 1 |
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
5. Is `state-politics-tracker` public or private? This decides the Actions
   cost and how urgent the licence question is.
6. After Phase 5, should California's site read SLCF's California data from
   here?
