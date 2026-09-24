-- Committees & organizations that have given to tracked candidates, one row
-- per (state, normalised name), with the per-candidate breakdown inline.
--
-- Backs the state-level /committees page ("every committee that has donated,
-- searchable by name"). Grouping across candidates on the fly would scan the
-- whole contributions table (1.6M rows) per page view, so this is a
-- materialised view refreshed with the other cf_* finance views by
-- refresh_cf_finance_views() at the end of each finance-sync run.
--
-- Scope: cf_contributions_deduped rows typed ENTITY — PACs, party committees,
-- unions, businesses, public-financing grants; anything a state's importer
-- files as a non-individual contributor. Names are normalised the same way as
-- cf_top_donors_live (upper-case, alphanumerics only) so "Realtors PAC of
-- Michigan" and "REALTORS PAC OF MICHIGAN" collapse into one row; the
-- displayed name is the most common spelling.

drop materialized view if exists public.cf_committee_donors;

create materialized view public.cf_committee_donors as
with normalized as (
  select
    k.state,
    nullif(regexp_replace(regexp_replace(upper(btrim(c.contributor_last_name)), '[^A-Z0-9 ]', '', 'g'), '\s+', ' ', 'g'), '') as norm_key,
    c.contributor_last_name as name,
    c.city,
    c.state as contributor_state,
    c.employer,
    c.candidate_id,
    c.amount,
    c.contribution_date
  from public.cf_contributions_deduped c
  join public.cf_candidates k on k.id = c.candidate_id
  where c.contributor_type = 'ENTITY'
    and c.candidate_id is not null
),
per_candidate as (
  select
    state, norm_key, candidate_id,
    count(*)::int as contribution_count,
    coalesce(sum(amount), 0)::numeric as total_amount,
    max(contribution_date) as last_contribution_date
  from normalized
  where norm_key is not null
  group by state, norm_key, candidate_id
),
rolled as (
  select
    n.state,
    n.norm_key,
    mode() within group (order by n.name) as name,
    mode() within group (order by n.city) as city,
    mode() within group (order by n.contributor_state) as contributor_state,
    count(*)::int as contribution_count,
    coalesce(sum(n.amount), 0)::numeric as total_amount,
    count(distinct n.candidate_id)::int as candidate_count,
    min(n.contribution_date) as first_contribution_date,
    max(n.contribution_date) as last_contribution_date
  from normalized n
  where n.norm_key is not null
  group by n.state, n.norm_key
)
select
  row_number() over (order by r.state, r.total_amount desc, r.norm_key) as rn,
  r.state,
  r.norm_key,
  r.name,
  r.city,
  r.contributor_state,
  r.contribution_count,
  r.total_amount,
  r.candidate_count,
  r.first_contribution_date,
  r.last_contribution_date,
  (
    select jsonb_agg(
      jsonb_build_object(
        'candidate_id', p.candidate_id,
        'contribution_count', p.contribution_count,
        'total_amount', p.total_amount,
        'last_contribution_date', p.last_contribution_date
      ) order by p.total_amount desc
    )
    from per_candidate p
    where p.state = r.state and p.norm_key = r.norm_key
  ) as splits
from rolled r;

-- Unique index required for `refresh ... concurrently`.
create unique index cf_committee_donors_pk on public.cf_committee_donors (rn);
create index cf_committee_donors_state_amount_idx on public.cf_committee_donors (state, total_amount desc);

grant select on public.cf_committee_donors to anon, authenticated, service_role;

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
end;
$$;
