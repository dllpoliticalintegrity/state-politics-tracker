-- Applied to the shared TX-tracker project on 2026-09-23 via the Supabase
-- MCP (apply_migration "cf_top_donors_materialized").
--
-- cf_top_donors was a plain view that re-aggregated every contribution
-- (1.4M rows, regexp-normalised donor names) on each request: 13 s for the
-- governor race, which every Top Donors page and candidate profile paid.
-- Materialise it. The live view stays as the source; the matview keeps
-- the same name and columns (plus a surrogate `rn` for a unique index so
-- it can be refreshed concurrently) so the frontend needs no change.
alter view public.cf_top_donors rename to cf_top_donors_live;

create materialized view public.cf_top_donors as
select
  row_number() over (order by candidate_id, total_amount desc, contributor_last_name, contributor_first_name) as rn,
  *
from public.cf_top_donors_live;

create unique index cf_top_donors_pk on public.cf_top_donors (rn);
create index cf_top_donors_candidate_amount_idx
  on public.cf_top_donors (candidate_id, total_amount desc);
create index cf_top_donors_candidate_type_idx
  on public.cf_top_donors (candidate_id, contributor_type);

grant select on public.cf_top_donors to anon, authenticated, service_role;

-- Candidate profiles list a candidate's latest contributions: give that a
-- direct index instead of walking the global date index with a filter.
create index if not exists idx_cf_contributions_candidate_date
  on public.cf_contributions (candidate_id, contribution_date desc);

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
  refresh materialized view concurrently public.cf_top_donors;
  refresh materialized view concurrently public.cf_ie_by_candidate;
  refresh materialized view concurrently public.cf_top_ie_donors;
end;
$$;
