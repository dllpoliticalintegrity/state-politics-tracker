-- Fundraising charts on the race page (since 2026-10-28): money raised over
-- time, cumulative per candidate, and the mix of donation sizes per
-- candidate. Two small matviews over cf_contributions — the table
-- cf_contributions_summary sums, so both charts reconcile with the page's
-- "Raised" figure — refreshed nightly with the other cf_* views.
--
-- cf_contributions_monthly: one row per candidate and calendar month of
--   contribution_date (undated rows, a handful in California, are left out).
--   The page folds months outside its window (a mistyped year 0025 in
--   Michigan, a 2028 in Ohio) into the window's edges so the line still
--   ends at the total.
-- cf_contribution_sizes: one row per candidate and size bin — under $200
--   (the summary's small-dollar line, so refunds and other negative rows
--   land here too), $200–$999, $1,000–$9,999, $10,000 and up. Bin keys
--   are mirrored by SIZE_BINS in src/lib/fundraisingCharts.ts.
--
-- Both are created WITH NO DATA (the first build scans every contribution)
-- and filled by cf_refresh_matview(), which does a plain refresh while a
-- view is unpopulated and a concurrent one after — so the nightly
-- refresh_cf_finance_views() cannot fail on a view nobody has filled yet.
-- Public-record aggregates: anon SELECT, like cf_contributions_summary.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

create materialized view public.cf_contributions_monthly as
select
  x.candidate_id,
  c.state as race_state,
  c.office,
  c.district,
  date_trunc('month', x.contribution_date)::date as month,
  coalesce(sum(x.amount), 0)::numeric as amount,
  count(*)::int as contribution_count
from public.cf_contributions x
join public.cf_candidates c on c.id = x.candidate_id
where x.contribution_date is not null
group by 1, 2, 3, 4, 5
with no data;

create unique index cf_contributions_monthly_pk on public.cf_contributions_monthly (candidate_id, month);
create index cf_contributions_monthly_race_idx on public.cf_contributions_monthly (race_state, office);
grant select on public.cf_contributions_monthly to anon, authenticated, service_role;

create materialized view public.cf_contribution_sizes as
select
  x.candidate_id,
  c.state as race_state,
  c.office,
  c.district,
  case
    when x.amount < 200 then 'under_200'
    when x.amount < 1000 then '200_to_999'
    when x.amount < 10000 then '1k_to_9999'
    else '10k_plus'
  end as size_bin,
  coalesce(sum(x.amount), 0)::numeric as amount,
  count(*)::int as contribution_count
from public.cf_contributions x
join public.cf_candidates c on c.id = x.candidate_id
group by 1, 2, 3, 4, 5
with no data;

create unique index cf_contribution_sizes_pk on public.cf_contribution_sizes (candidate_id, size_bin);
create index cf_contribution_sizes_race_idx on public.cf_contribution_sizes (race_state, office);
grant select on public.cf_contribution_sizes to anon, authenticated, service_role;

-- Refresh one public matview: concurrently once it holds data (readers keep
-- the old rows meanwhile), plainly the first time (CONCURRENTLY refuses an
-- unpopulated view).
create or replace function public.cf_refresh_matview(p_name text)
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  if (select ispopulated from pg_matviews where schemaname = 'public' and matviewname = p_name) then
    execute format('refresh materialized view concurrently public.%I', p_name);
  else
    execute format('refresh materialized view public.%I', p_name);
  end if;
end;
$$;
revoke execute on function public.cf_refresh_matview(text) from public, anon, authenticated;
grant execute on function public.cf_refresh_matview(text) to service_role;

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
  refresh materialized view concurrently public.cf_committee_donors;
  refresh materialized view concurrently public.cf_funding_sources;
  perform public.cf_refresh_matview('cf_contributions_monthly');
  perform public.cf_refresh_matview('cf_contribution_sizes');
end;
$$;
