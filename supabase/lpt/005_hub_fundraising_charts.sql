-- 005: the race page's fundraising charts (since 2026-10-28) for states read
-- from the Local Politics Tracker — money per candidate and month, and per
-- candidate and donation-size bin — the LPT twins of the tracker project's
-- cf_contributions_monthly / cf_contribution_sizes matviews (migration
-- 20261028120000_cf_fundraising_charts.sql there). Routed by state like 004
-- (one EXECUTE branch: hub_src names his tables with a `true` predicate for
-- a shared state, ours with the attribution filter for a state we load),
-- walking the race's candidates with a LATERAL join so his
-- (candidate_id) index does the work. Apply after 004 with execute_sql.
-- Re-runnable (create or replace; no drops, which the MCP treats as
-- destructive). Bin keys match SIZE_BINS in src/lib/fundraisingCharts.ts.

create or replace function public.hub_race_contribution_months(p_state text, p_office text, p_district int default null)
returns table (candidate_id uuid, month date, amount numeric)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    with cands as (
      select rp.candidate_id
      from public.%I rp
      join public.%I r on r.race_id = rp.race_id
      where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
    )
    select cands.candidate_id, x.month, x.amount
    from cands
    cross join lateral (
      select date_trunc('month', a.contribution_date)::date as month, sum(a.amount)::numeric as amount
      from public.%I a
      where a.candidate_id = cands.candidate_id and %s and a.contribution_date is not null
      group by 1
    ) x
  $q$, s.participants, s.races, s.contrib_attr, s.contrib_attr_pred) using p_state, p_office, p_district;
end
$$;

create or replace function public.hub_race_contribution_sizes(p_state text, p_office text, p_district int default null)
returns table (candidate_id uuid, size_bin text, amount numeric, contribution_count bigint)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    with cands as (
      select rp.candidate_id
      from public.%I rp
      join public.%I r on r.race_id = rp.race_id
      where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
    )
    select cands.candidate_id, x.size_bin, x.amount, x.contribution_count
    from cands
    cross join lateral (
      select case
               when a.amount < 200 then 'under_200'
               when a.amount < 1000 then '200_to_999'
               when a.amount < 10000 then '1k_to_9999'
               else '10k_plus'
             end as size_bin,
             sum(a.amount)::numeric as amount, count(*)::bigint as contribution_count
      from public.%I a
      where a.candidate_id = cands.candidate_id and %s
      group by 1
    ) x
  $q$, s.participants, s.races, s.contrib_attr, s.contrib_attr_pred) using p_state, p_office, p_district;
end
$$;

grant execute on function
  public.hub_race_contribution_months(text, text, int),
  public.hub_race_contribution_sizes(text, text, int)
to anon, authenticated, service_role;
