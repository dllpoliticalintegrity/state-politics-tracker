-- Nightly safety net for the campaign-finance materialized views.
--
-- finance-sync.yml ends by calling refresh_cf_finance_views() over PostgREST.
-- With ~2M cf_contributions rows that refresh takes about three minutes
-- (171 s on 2026-10-01), and the Supabase API gateway gives up on the HTTP
-- request after roughly two with a 504. The statement still runs to
-- completion server-side (auto_explain logged the finished plan), but the
-- importer cannot tell, and the run was marked failed every night.
--
-- The importer now treats a gateway timeout on that call as "refresh still
-- running", and this pg_cron job refreshes the views every morning after the
-- 07:20 UTC sync regardless, so a night where the RPC never reached the
-- database still ends with fresh views. refresh_cf_finance_views() sets its
-- own 10-minute statement_timeout; cron runs are logged in cron.job_run_details.
--
-- cron.schedule() with a job name upserts, so re-running this is safe.
create extension if not exists pg_cron;

grant usage on schema cron to postgres;

select cron.schedule(
  'cf-finance-refresh-nightly',
  '15 9 * * *',                       -- 09:15 UTC, ~1 h after the sync finishes
  $$select public.refresh_cf_finance_views()$$
);
