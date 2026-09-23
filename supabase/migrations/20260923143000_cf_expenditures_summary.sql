-- Applied to the shared TX-tracker project on 2026-09-23 via the Supabase
-- MCP (apply_migration "cf_expenditures_summary").
--
-- Per-candidate spending rollup for the dashboards. The frontend used to
-- SELECT candidate_id, amount from cf_expenditures (every row) to sum it
-- client-side; with ~200k rows that is both capped at PostgREST's 1,000-row
-- limit (wrong totals) and heavy. Mirrors cf_contributions_summary, and is
-- refreshed by refresh_cf_finance_views() after each import.
create materialized view if not exists public.cf_expenditures_summary as
select
  c.id as candidate_id,
  c.slug,
  c.state as race_state,
  c.office,
  count(*) as expenditure_count,
  sum(x.amount) as total_spent,
  max(x.expenditure_date) as as_of
from public.cf_candidates c
join public.cf_expenditures x on x.candidate_id = c.id
group by c.id, c.slug, c.state, c.office;

create unique index if not exists cf_expenditures_summary_pk
  on public.cf_expenditures_summary (candidate_id);
create index if not exists cf_expenditures_summary_race_idx
  on public.cf_expenditures_summary (race_state, office);

grant select on public.cf_expenditures_summary to anon, authenticated, service_role;

create or replace function public.refresh_cf_finance_views()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  refresh materialized view concurrently public.cf_contributions_summary;
  refresh materialized view concurrently public.cf_expenditures_summary;
  refresh materialized view concurrently public.cf_ie_by_candidate;
  refresh materialized view concurrently public.cf_top_ie_donors;
end;
$$;

-- Populate now (the nightly importer refreshes it from here on).
refresh materialized view public.cf_expenditures_summary;
