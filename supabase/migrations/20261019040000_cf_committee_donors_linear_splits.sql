-- cf_committee_donors: build the per-candidate `splits` with one grouped
-- pass and a join, instead of a correlated subquery per donor row.
--
-- The subquery re-scanned every normalized contribution row (~195K) for each
-- of ~40K donor rows: ~8 billion row checks. The planner expected 5,200
-- donor rows, so it kept the nested plan, and on 2026-10-19 the nightly
-- refresh_cf_finance_views() sat on this view for 15+ minutes (the other six
-- views took ~4 together). Same columns, same rows, same ordering of `rn`
-- and of each `splits` array.
--
-- A materialized view can't be redefined in place: dropped and recreated,
-- with its indexes. Grants: public-record aggregates, so anon/authenticated
-- SELECT (it carried Supabase's default full grants before, which this
-- narrows) and the service role as before.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc).

drop materialized view if exists public.cf_committee_donors;

create materialized view public.cf_committee_donors as
with normalized as (
  select k.state,
    nullif(regexp_replace(regexp_replace(upper(btrim(c.contributor_last_name)), '[^A-Z0-9 ]'::text, ''::text, 'g'::text),
                          '\s+'::text, ' '::text, 'g'::text), ''::text) as norm_key,
    c.contributor_last_name as name,
    c.city,
    c.state as contributor_state,
    c.employer,
    c.candidate_id,
    c.amount,
    c.contribution_date
  from public.cf_contributions_deduped c
  join public.cf_candidates k on k.id = c.candidate_id
  where c.contributor_type = 'ENTITY'::text and c.candidate_id is not null
), per_candidate as (
  select state, norm_key, candidate_id,
    count(*)::integer as contribution_count,
    coalesce(sum(amount), 0::numeric) as total_amount,
    max(contribution_date) as last_contribution_date
  from normalized
  where norm_key is not null
  group by state, norm_key, candidate_id
), splits as (
  select state, norm_key,
    jsonb_agg(jsonb_build_object('candidate_id', candidate_id, 'contribution_count', contribution_count,
                                 'total_amount', total_amount, 'last_contribution_date', last_contribution_date)
              order by total_amount desc) as splits
  from per_candidate
  group by state, norm_key
), rolled as (
  select n.state, n.norm_key,
    mode() within group (order by n.name) as name,
    mode() within group (order by n.city) as city,
    mode() within group (order by n.contributor_state) as contributor_state,
    count(*)::integer as contribution_count,
    coalesce(sum(n.amount), 0::numeric) as total_amount,
    count(distinct n.candidate_id)::integer as candidate_count,
    min(n.contribution_date) as first_contribution_date,
    max(n.contribution_date) as last_contribution_date
  from normalized n
  where n.norm_key is not null
  group by n.state, n.norm_key
)
select row_number() over (order by r.state, r.total_amount desc, r.norm_key) as rn,
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
  s.splits
from rolled r
left join splits s on s.state = r.state and s.norm_key = r.norm_key;

create unique index cf_committee_donors_pk on public.cf_committee_donors using btree (rn);
create index cf_committee_donors_state_amount_idx on public.cf_committee_donors using btree (state, total_amount desc);

revoke all on public.cf_committee_donors from anon, authenticated;
grant select on public.cf_committee_donors to anon, authenticated;
grant all on public.cf_committee_donors to service_role;
