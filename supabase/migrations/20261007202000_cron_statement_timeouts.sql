-- Give the scheduled finance jobs a statement timeout they can finish in.
--
-- The project's default statement_timeout is 2 minutes, and pg_cron runs each
-- statement of a job under it. refresh_cf_finance_views() and
-- publish_texas_to_cf() declare `set statement_timeout` on themselves, but a
-- function-level setting does not extend the timer of the statement that
-- called it, so they were still cancelled at 2 minutes:
--   - cf-finance-refresh-nightly (20261001143000) failed every night from at
--     least 2026-10-02 with "canceling statement due to statement timeout" in
--     the cf_committee_donors refresh. The views stayed current only because
--     finance-sync.yml's own refresh call gets through.
--   - the first Texas publish (20261007150000) failed the same way.
-- A `set statement_timeout` at the start of the job's command applies to each
-- following statement of that command (Postgres times each statement of a
-- multi-statement query separately, and pg_cron sends the command as one
-- query because cron.use_background_workers is off).
--
-- Applied to the shared tracker project on 2026-10-07 via the Supabase MCP.
-- cron.schedule() with an existing job name updates that job in place.

select cron.schedule(
  'cf-finance-refresh-nightly',
  '15 9 * * *',
  $$set statement_timeout = '30min'; select public.refresh_cf_finance_views();$$
);

select cron.schedule(
  'tx-publish-to-cf-nightly',
  '30 14 * * *',
  $$set statement_timeout = '30min'; select public.publish_texas_to_cf(); select public.refresh_cf_finance_views();$$
);
