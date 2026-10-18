# Runbook

> Kept outside the serving repo. Commands are run from `serving/`; paths
> to documents are relative to `serving/cloud/supabase/`.

How to do each recurring job, and what to do when something looks wrong.
Commands run from the repo root (`serving/`) and are shown for macOS; see
"On Windows" at the end. Anything that writes says **writes**.

## Contents

Jobs:

- [The weekly run](#the-weekly-automatic-run)
- [Push a state](#push-one-state-by-hand)
- [After a code change](#after-changing-linking-race-or-classification-code)
- [Change the database](#change-the-database)
- [Refresh the views](#refresh-the-views)
- [Enrichment](#run-the-enrichment-tools)
- [A new state](#bring-a-new-state-onto-the-site)
- [The local database](#use-the-local-database)

Symptoms:

- [When something looks wrong](#when-something-looks-wrong)

---

## The weekly automatic run

Each live state is collected and pushed once a week, at 2am, by `ops/daemon.py --live`
(in the directory above this repo; the schedule is `ops/crontab`).

| Night | States |
|---|---|
| Monday | GA MI |
| Tuesday | FL OH |
| Wednesday | AZ AK |
| Thursday | TX |
| Saturday | WI |

What a run does, one state at a time:

1. Collects the state: download, parse, validate. A state that fails is
   put back to its last good copy.
2. Pushes the state's files to bulk storage (R2).
3. Pushes the state to the database, with every setting at its default
   (see [push one state by hand](#push-one-state-by-hand)). A state that
   failed and could not be put back is **held back**: not pushed anywhere.
4. Refreshes the views, if the database push succeeded.

Then the next state starts. A state that takes hours does not hold back the
ones before it in the group. After the last state, two emails go out: what
was collected and what failed, then what was pushed.

The same run by hand, from the directory above this repo:

```
python3 ops/daemon.py OH --live                   # what cron runs: R2, live database, emails
python3 ops/daemon.py OH                          # dry run: collects, writes nothing
python3 ops/daemon.py OH --live --start-year 2025 # the scrapers' year window
python3 ops/daemon.py OH --local                  # the local database; no R2, no emails
python3 ops/daemon.py OH --skip-push              # collect only
```

Without `--live` or `--local` nothing is written anywhere: each state is
collected and its push is a dry run that prints the totals check. Every cron
line carries `--live`.

At 9am every day, `ops/nothing_ran_check.py` asks the opposite question: has
any live state gone more than eight days without new data reaching the site?
It emails only then. This is what catches a run that never started, which
produces no email of its own.

The run does **not** run the enrichment tools. Those are by hand.

Where to look when a run misbehaves (all under the directory above this
repo): `logs/cron_group1.log` to `logs/cron_group5.log` for what the job
printed, `logs/daemon/` for one folder per run, `logs/cron_heartbeat.log`
for whether the scheduler fired at all (one line an hour; a gap means the
machine was asleep or off), `logs/nothing_ran_check.log` for the 9am check.

Where other runs are logged: `logs/prod/` for `main.py sync` by hand and for
pushes by hand to the live database or R2 (one folder per run);
`logs/dev/` for dry runs, pushes to the local database and single tools.
Every database push event records `target` as `live` or `local`.

---

## Push one state by hand

```
python3 cloud/supabase/supabase.py OH            # dry run
python3 cloud/supabase/supabase.py OH --live     # writes
python3 cloud/supabase/tools/refresh_dashboard_views.py    # writes
```

1. **Dry run.** Builds the rows and writes previews of candidates,
   committees, contributions and expenditures to
   `cloud/supabase/_scratch/OH/preview/`. If database credentials are set it
   also prints the totals check. Nothing is written to the database.
2. **Read the output.** The lines that matter:

   | Line | Meaning |
   |---|---|
   | `database: live project` | Which database this run talks to. `LOCAL` with `--local` |
   | `filter ... -> ...` | Rows in the cleaned files, and how many are in scope (tracked offices, the cycle's dates) |
   | `match ... matched` | How many of those were linked to a candidate |
   | `races: N candidate row(s) with no office_map entry` | Offices the site does not track, skipped |
   | `races: N anomalous candidate group(s) held out` | Groups of registrations too tangled to place; see `tools/diagnose/why_no_candidate.py` |
   | `totals check ok` | No candidate is about to lose $10,000 or more and 20% or more of their money |
   | `totals check N drop(s)` | Followed by the list. A live push stops here |

3. **Push with `--live`.** Writes the state row, candidates, committees,
   races and race entries, then contributions and expenditures.
4. **Refresh the views.** Pages read totals from the views, so the site shows
   the old numbers until this runs.

The preview files hold donor names, employers and addresses. Do not paste
them anywhere or commit them.

### The guards, and how to override them

| Guard | Default | What it protects against | Override |
|---|---|---|---|
| Totals check | `block` | A linking mistake or a half-downloaded file wiping a candidate's money | `--totals-check log` to push anyway after reading the list; `--totals-drop-min-usd`, `--totals-drop-min-frac` to move the limits |
| Stale transactions | `log` (count, never delete) | Deleting rows because an input file was empty or broken | `--prune apply` with `--live`. Still refuses a file where more than 60% of rows look stale (`--prune-max-frac`) |
| Stale race entries | `log` | The same, for people listed in a race | `--prune-participants apply` with `--live`. Never removes an entry a ballot source has confirmed |

A scheduled push can never delete anything: deleting needs `apply` on a
command line.

Known limit of the totals check: it compares the push's date window with
everything the database holds, so a push with a narrower `--date-from` or
`--date-to` than the last one reports drops that are not real.

Other flags (`--election-year`, `--date-from`, `--date-to`, `--workers`,
`--batch-size`, `--keep-scratch`, `--target`) are described by
`python3 cloud/supabase/supabase.py --help`. The date floor defaults to
January 1 of the year before the election, because states publish a
candidate's filings back to their first race for any office.

To fill the "Sources" list for a state (rarely changes):

```
python3 cloud/supabase/push_sources.py OH --live    # writes
```

---

## After changing linking, race or classification code

Tests first; then, when the change could move money or relabel a
donor, a before-and-after on real data.

```
python3 cloud/supabase/tests/run_all.py

python3 cloud/supabase/tools/checks/race_snapshot.py AK WI            # before: saves a baseline
python3 cloud/supabase/tools/checks/classification_snapshot.py AK WI
... change the code ...
python3 cloud/supabase/tools/checks/race_snapshot.py AK WI --keep     # after
python3 cloud/supabase/tools/checks/classification_snapshot.py AK WI --keep
```

- `race_snapshot.py` covers who is in which race, every candidate row, and
  the dollars linked to each candidate. Use it for changes under
  `transform/` and `mappings/`.
- `classification_snapshot.py` covers the receipt type and donor label on
  every contribution and the spending type on every expenditure. Use it for
  changes under `transform/classification/`.

A reorganisation must come back `identical` for every state. A real change
prints named people entering or leaving named races and named totals
moving: that list is what to review before pushing. Take the baseline
before touching the code, and do not edit code while a snapshot is running.
Alaska takes seconds; Texas, Michigan and Ohio take several minutes each.

For an edit meant to change only comments:

```
python3 cloud/supabase/tools/checks/code_unchanged.py
```

It compares every changed `.py` and `.sql` file with the last commit, with
comments removed, and must say `comments only`.

When the change is supposed to move money (say, removing someone from a
race), the live push will stop on the totals check. Read its list against
the snapshot's, then push with `--totals-check log`.

---

## Change the database

`schema/` is the database; `schema/README.md` has the rules. The steps:

```
... edit the file under cloud/supabase/schema/ ...
python3 cloud/supabase/tools/apply_sql_file.py schema/rpc_state_profile.sql    # writes
python3 cloud/supabase/tools/local_db.py build
python3 cloud/supabase/tools/local_db.py diff
```

`apply_sql_file.py` takes a path relative to `cloud/supabase/`. Apply a
whole file only when it is a function or view definition that is safe to
run again. **Never apply `schema.sql` whole to live: it drops every table.**
For a table change, apply a small file holding only that change.

`diff` must end `local and live have the same structure.` A comment inside
a function body is part of what the database stores, so changing one counts
as a change and needs applying.

---

## Refresh the views

```
python3 cloud/supabase/tools/refresh_dashboard_views.py                          # writes
python3 cloud/supabase/tools/refresh_dashboard_views.py --from race_active_candidates
```

Refreshes the 26 views one at a time, in order. If one fails, the tool
prints the `--from` value to carry on from. The weekly run does this itself;
after a push by hand, run it yourself.

---

## Run the enrichment tools

All by hand, all dry runs without `--live`. Each fails on its own without
affecting the others or the push. What each one reads and writes is in
`enrichment/README.md`.

Order matters: the push first, then OpenStates, then ballot status (it needs
the roster OpenStates loads), then Green Papers, then photos and polls.

```
python3 cloud/supabase/enrichment/openstates/openstates_push.py --states mi oh tx fl wi az ga --live     # writes

python3 cloud/supabase/enrichment/ballot/ballot_status_push.py --states fl --live                         # writes
python3 cloud/supabase/enrichment/ballot/ballot_status_push.py --states tx ak mi --live
python3 cloud/supabase/enrichment/ballot/ballot_status_push.py --states oh wi ga \
    --snapshot cloud/supabase/mappings/rosters/state_legislators_and_candidates.csv --live
python3 cloud/supabase/enrichment/ballot/ballot_status_push.py --states az \
    --snapshot cloud/supabase/mappings/rosters/az_ballot_2026.csv --live

python3 cloud/supabase/enrichment/orc.py --live     # Green Papers, then photos, then polls; writes
```

Ballot status is the step with real risk: it can mark people as off the
ballot, and a dry run cannot show how many (that count needs the database).
Go one state at a time, Florida first (its source states each candidate's
status outright, so least is inferred), and look at the result before the
next. To undo a run on the same day, in the Supabase SQL editor:

```sql
update race_participants set on_ballot = null, disposition = null
where disposition = 'Absent from the certified list'
  and observed_on = current_date;
```

Green Papers reads a spreadsheet downloaded by hand
(`enrichment/greenpapers/G-politicians.xls`). The two files passed to
`--snapshot` are copies made on one date, not feeds; replace them to pick up
changes.

---

## Bring a new state onto the site

1. **Cleaned data** exists under `data/{State}/cleaned/` (the collection
   pipeline's job).
2. **Look at it.**
   `python3 cloud/supabase/tools/onboarding/survey_state_data.py Texas`
   writes a summary under `docs/state_data_survey/`: the state's codes, how
   full each column is.
3. **Offices.** Add the state's office names to `mappings/office_map.csv`.
   Check what the `office` column really says; states spell the same office
   more than one way.
4. **Featured candidates.** Add the reviewed rows to
   `mappings/committee_candidate_map.csv`. A state with rows here is a
   tracked state: `supabase.py all` and the 9am check both read this list.
5. **Settings.** Add a row to `mappings/states.csv`. Leave `classified`
   blank for now.
6. **Donor types.** Run
   `python3 cloud/supabase/tools/onboarding/classification_review.py Illinois IL`,
   review its output as `transform/classification/README.md` describes, add
   the state's codes, then set `classified` to 1.
7. **Dry run**, and check who the mapper placed:
   `python3 cloud/supabase/tools/diagnose/why_no_candidate.py --state il --all`.
8. **Push to the local database** and look at the pages (below).
9. **Push live, refresh the views, fill sources.**
10. **Make it visible.** A state is listed on the home page only when it has
    candidates and `states.is_ready` is true. In the Supabase SQL editor:
    `update states set is_ready = true where state_id = 'IL';`
11. **Legislature and ballot.** Add the state to
    `mappings/openstates_office_map.csv`, `mappings/openstates_term_map.csv`
    and `mappings/ballot_status_chamber_map.csv`, then run the enrichment
    tools.
12. **Schedule it** in `ops/crontab`.

---

## Use the local database

A copy of the database on your own machine, for trying a push or a schema
change without touching the site. Needs Docker and the Supabase command-line
tool.

```
supabase start --workdir cloud/supabase                     # from serving/
python3 cloud/supabase/tools/local_db.py build              # empty database from schema/ (wipes local)
python3 cloud/supabase/supabase.py AK --live --local
python3 cloud/supabase/tools/local_db.py refresh
python3 web/dashboard/serve_local.py                        # then open http://localhost:8000/ak/?db=local
```

To collect a state and push it to the local database in one command, from
the directory above this repo: `python3 ops/daemon.py OH --local`.

- `--local` is on the push, the enrichment loaders and the tools that reach
  a database. `CF_DB_TARGET=local` in front of a command does the same.
- `--live` still decides whether anything is written. The push's first line
  says which database it is using.
- The pages read local only when served from localhost with `?db=local`
  (`?db=live` switches back). The choice is remembered per browser, and an
  orange "LOCAL DATABASE" tag shows while it is on.
- A new local database has no state marked ready, so the home page lists
  nothing until `is_ready` is set (step 10 above, against local).
- `supabase stop --workdir cloud/supabase` stops it. `local_db.py build` fails with "connection
  refused" when it is not running.

---

## When something looks wrong

**A candidate shows $0.**
`python3 cloud/supabase/tools/diagnose/audit_zero_money.py --state wi` puts
each $0 candidate in one bucket: the views are out of date (refresh them),
the money exists but is not linked, or there is no money in the database.
A candidate with only an old or dormant registration is a real $0.

**A candidate shows someone else's money.** Usually a link made on a last
name. Check the candidate's rows in `mappings/committee_candidate_map.csv`,
then run `race_snapshot.py` for the state before and after a correction to
see exactly what moves. Fix the rule, not the one name.

**A candidate is missing from a race.**
`python3 cloud/supabase/tools/diagnose/why_no_candidate.py --state mi --name "Tyrone Carter"`
replays the race mapper's rules and says which one left them out.

**A state is missing from the home page.** It has no candidates, or
`states.is_ready` is false.

**The push stopped on the totals check.** Read the list. If the drops are
what your change intended, push again with `--totals-check log`. If not, do
not push: the usual causes are a short or empty input file, or a linking
change with a wider reach than expected. Nothing was written.

**A page says the data is unavailable.** The page could not read the
database. Check that the views are populated (run the refresh) and that the
function the page calls exists (`local_db.py diff`).

**The site shows old totals after a push.** The views were not refreshed.

**A 524 from a tool.** The service in front of the database drops a request
after 120 seconds, but the statement keeps running. Do not run it again
straight away. For a long query, paste it into the Supabase SQL editor.

**The nightly email says a state was restored, or held back.** Restored:
collection failed and the last good copy was pushed, so the site is
unchanged for that state. Held back: there was no good copy to restore, and
nothing was pushed. Either way the cause is in the collection step; the 9am
check will email if it goes on for more than eight days.

**No email at all on a night a run was due.** The job did not start. Check
`logs/cron_heartbeat.log` for a gap (machine asleep) and the night's
`logs/cron_group*.log`.

**Ballot status marked too many people off the ballot.** Most often a name
that did not match: the tool added the listed person as new, and the
existing row then looked absent. Check the `ambiguous` count in the run's
output, and undo with the statement under
[enrichment](#run-the-enrichment-tools).

**A whole chamber never gets anyone marked off.** The source covered under
95% of the chamber's districts, or OpenStates was not loaded first.

**`no candidateListTablePartisan table` from the Ballotpedia tool.**
Ballotpedia refuses scripted requests. Use `--snapshot` or `--html-dir`.

**Every fetch fails with `CERTIFICATE_VERIFY_FAILED`.** A network that
inspects TLS, with a recent Python. `pip install truststore` lets
`openstates.py` use the system's certificates; the ballot fetchers do not
have that fallback.

---

## On Windows

The commands are the same with `python` in place of `python3` and `\` or
`/` in paths. Setting a variable for one command is different:

```powershell
$env:CF_DB_TARGET = "local"; python cloud/supabase/tools/refresh_dashboard_views.py
Remove-Item Env:CF_DB_TARGET     # it stays set for the session until removed
```

The weekly run and its logs exist only on the machine that hosts the
schedule.
