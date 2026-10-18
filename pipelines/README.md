# Pipelines

Campaign-finance pipelines for every state the site covers. The plan, and why
it's shaped this way, is in [`docs/slcf-merge-plan.md`](../docs/slcf-merge-plan.md).

| Path | What |
|---|---|
| `states.json` | Which pipeline feeds each state, its cycle and flags. The one place that decides. |
| `slcf/` | [state-level-campaign-finance](https://github.com/hderyke/state-level-campaign-finance), merged in with its history: a scraper and parser per state that write canonical CSVs. Its own README and `docs/` describe it. |
| `load/` | `load_cf.py`: one state's SLCF output → the `cf_*` tables the site reads. |
| `run_state.py` | SLCF sync + check + load for one state: what each `finance-sync.yml` matrix job runs. |
| `plan_matrix.py` | Splits `finance-sync.yml`'s `states` input into its pilot job and SLCF matrix. |
| `tests/` | Offline tests (`python3 -m unittest discover -s pipelines/tests`). |

**Texas keeps its own infrastructure:** `scripts/data-import/tec/` and
`tx-finance-sync.yml`, staging into `tx_*`; a nightly `publish_texas_to_cf()`
copies it into `cf_*`. California likewise (`scripts/data-import/cal-access/`).

**Michigan's finance moved to SLCF on 2026-10-18.** The pilot importer
(`scripts/data-import/pilot/import_pilot_finance.py`) still runs for it every
night, rosters only (`pilot_rosters` in `states.json`): the legislature roster
and ballot-status syncs. Every other pilot state moves to SLCF at its cutover.

**Outside spending** (`"ie": true` in `states.json`): the loader also reads
SLCF's committees table and loads independent expenditures that target a
tracked candidate into `cf_independent_expenditures`, their spenders into
`cf_ie_committees` and the spenders' receipts into `cf_ie_contributions`
(`load/ie.py`). The run log lists the largest unmatched targets. `"fec_ie":
true` keeps SLCF's FEC nonfederal-IE enrichment on (Ohio; `FEC_API_KEY`).

## Setup

```sh
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r pipelines/requirements.txt
python -m playwright install chromium   # only for states marked "playwright" in states.json
```

## Run one state

```sh
# SLCF scrape + parse, transactions from 2025 on (data lands in pipelines/slcf/data/, git-ignored)
cd pipelines/slcf && python src/main.py --no-report sync CO --start-year 2025 \
    --no-aggregate --no-fec-ie --transactions && cd -

# Reconcile against the live rows. Writes nothing; the anon key is enough.
SUPABASE_URL=https://lohxdfrxnxuxjdvvyfjc.supabase.co SUPABASE_KEY=<anon key> \
    python pipelines/load/load_cf.py --state co --dry-run --report recon-co.csv

# All of the above, as the workflow runs it (loads for real unless --dry-run)
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python pipelines/run_state.py co --dry-run
```

SLCF's CLI exits 0 even when a state fails. Judge a run by its output or by
`run_state.py`, which checks that SLCF wrote rows. A `--transactions` run makes
SLCF's own validation report the committee and candidate tables empty; that is
expected, because the loader never reads them.

## The dry-run report

`load_cf.py --dry-run` compares, per candidate and table:
- what SLCF would load: rows, dollars and dates;
- what is live for the same candidates;
- `new`: ids not yet live;
- `stale`: live rows inside the date window whose id SLCF no longer has, usually
  rows a later amendment replaced;
- `amt chg`: ids whose amount differs.

A state is ready to cut over when every dollar of difference is explained by
those columns.

## Cutting a pilot state over to SLCF

1. **SLCF output.** The state's SLCF parser writes three columns on its
   transaction rows (see `slcf/src/pipeline/columns.py`, TRANSACTION_IDS):
   - `state_filer_id`: the committee, matching `cf_candidates.filer_refs`;
   - `txn_id`: the source's transaction id, if it has one;
   - `superseded`: set when a later amendment replaced the row.
2. **Ids.** If the pilot used the source's own ids, set `id_format` in
   `states.json` to the pilot's format, so the load lands on the existing rows.
   If the pilot hashed rows, the first run loads every row under new ids and
   its prune deletes the pilot's rows. Either way, back up the state's
   `source = 'slcf'` rows first (`private.cf_*_backup_YYYYMMDD_<st>`). Where
   the pilot stored many duplicates, so that the load is under 90% of the live
   rows, set a one-off `prune_min_share` for that run and remove it after.
3. **Dry run.** Dispatch Finance sync with `states` = the code and `dry_run` on.
   Download `finance-<state>` from the run's artifacts.
4. **Switch.** Set `"pipeline": "slcf"`, and `"prune": true` once the dry run's
   stale rows check out. Dispatch the state once, then watch two nightlies.
