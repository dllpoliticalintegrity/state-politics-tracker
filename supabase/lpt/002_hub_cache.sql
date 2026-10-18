-- 002: caches for the aggregates that are too slow to compute per request on
-- LPT's instance (a race's top donors, a state's committee donors, each
-- candidate's finance rollup). Plain tables we own, refilled by
-- hub_refresh_cache() from Henry's matviews — never views on his objects, so
-- a `drop ... cascade` on his side cannot delete them: the refresh fails
-- until his objects are back and the caches keep serving the last run.
--
-- Apply by hand after 001, with execute_sql. Then fill the caches:
--
--   select public.hub_refresh_cache(array['GA']);   -- one state, seconds
--   select public.hub_refresh_cache();              -- every state, minutes
--
-- Scheduling the refresh (after his refresh_candidate_dashboard_views, which
-- pg_cron runs weekdays at 15:00 UTC) is a separate decision: either a
-- pg_cron job in this project or the hub's nightly GitHub Action with the
-- LPT service key. Until one exists, run it by hand after each push.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.hub_cache_meta (
  name text primary key,
  refreshed_at timestamptz not null,
  states text[],
  rows_written bigint,
  duration_ms bigint
);

-- hub_candidate_finance(), per candidate.
create table if not exists public.hub_cache_candidate_finance (
  candidate_id uuid primary key,
  state_id text not null,
  total_raised numeric not null,
  individual_contributions numeric not null,
  self_funding numeric not null,
  entity_contributions numeric not null,
  small_dollar_contributions numeric not null,
  small_dollar_count bigint not null,
  individual_donor_count bigint not null,
  as_of date,
  total_spent numeric not null,
  -- Row counts for the river's pager.
  contribution_count bigint not null default 0,
  expenditure_count bigint not null default 0,
  ie_count bigint not null default 0
);
alter table public.hub_cache_candidate_finance add column if not exists contribution_count bigint not null default 0;
alter table public.hub_cache_candidate_finance add column if not exists expenditure_count bigint not null default 0;
alter table public.hub_cache_candidate_finance add column if not exists ie_count bigint not null default 0;

-- Itemized loans (receipt_type 'loan'), a few thousand rows in all; reading
-- them live means scanning every contribution of a candidate.
create table if not exists public.hub_cache_loans (
  contribution_id uuid primary key,
  candidate_id uuid not null,
  state_id text not null,
  contribution_date date,
  amount numeric,
  contributor_name text,
  contributor_kind text,
  contributor_type text,
  election_year int,
  created_at timestamptz
);
create index if not exists hub_cache_loans_candidate_idx on public.hub_cache_loans (candidate_id);

-- Top 300 donors per candidate and contributor type (INDIVIDUAL / ENTITY),
-- grouped by normalized name; the site's cf_top_donors shape.
create table if not exists public.hub_cache_candidate_donors (
  candidate_id uuid not null,
  state_id text not null,
  contributor_type text not null,
  rn int not null,
  contributor_last_name text,
  contributor_first_name text,
  employer text,
  occupation text,
  city text,
  state text,
  contribution_count bigint not null,
  total_amount numeric not null,
  last_contribution_date date,
  primary key (candidate_id, contributor_type, rn)
);
create index if not exists hub_cache_candidate_donors_total_idx
  on public.hub_cache_candidate_donors (candidate_id, total_amount desc);

-- Every organizational donor of a state with its per-candidate breakdown;
-- the site's cf_committee_donors shape.
create table if not exists public.hub_cache_committee_donors (
  state text not null,
  rn bigint not null,
  norm_key text not null,
  name text,
  city text,
  contributor_state text,
  contribution_count int not null,
  total_amount numeric not null,
  candidate_count int not null,
  first_contribution_date date,
  last_contribution_date date,
  splits jsonb,
  primary key (state, rn)
);

do $$
declare t text;
begin
  foreach t in array array['hub_cache_meta', 'hub_cache_candidate_finance', 'hub_cache_candidate_donors', 'hub_cache_committee_donors', 'hub_cache_loans'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_public_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_public_read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The refresh: every state, or the upper-case codes given.
-- ---------------------------------------------------------------------------

create or replace function public.hub_refresh_cache(p_states text[] default null)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t0 timestamptz := clock_timestamp();
  v_rows bigint;
  states text[] := (select array_agg(upper(s)) from unnest(p_states) s);
begin
  -- Rows in scope: every attributed contribution of a candidate in a race.
  create temp table hub_t_rows on commit drop as
  select a.candidate_id, a.state_id::text as state_id, a.contributor_name, a.amount, a.contribution_date,
         a.contributor_employer, a.contributor_occupation, a.contributor_city, a.contributor_state,
         public.hub_contributor_type(a.contributor_kind, a.contributor_type) as t,
         coalesce(a.contributor_type = 'Self-funding' or a.contributor_kind = 'self', false) as is_self,
         coalesce(a.contributor_kind, '') = 'public' or coalesce(a.contributor_type, '') = 'Public funds' as is_public,
         public.hub_is_named(a.contributor_name) as named,
         public.hub_norm_name(a.contributor_name) as k
  from public.candidate_contributions_attributed a
  where a.candidate_id in (select candidate_id from public.race_participants)
    and (states is null or a.state_id = any (states));
  create index on hub_t_rows (candidate_id, t, k);

  -- 1. Finance rollup per candidate.
  delete from public.hub_cache_candidate_finance where states is null or state_id = any (states);
  insert into public.hub_cache_candidate_finance
  select f.candidate_id, f.state_id, f.total_raised, f.individual_contributions, f.self_funding,
         f.entity_contributions, f.small_dollar_contributions, f.small_dollar_count, f.individual_donor_count,
         f.as_of, coalesce(e.total_expenditures, 0),
         f.contribution_count,
         (select count(*) from public.candidate_expenditures_attributed x where x.candidate_id = f.candidate_id),
         (select count(*) from public.candidate_ie_expenditures x where x.candidate_id = f.candidate_id and x.support_oppose in ('S', 'O'))
  from (
    select candidate_id, state_id,
           count(*) as contribution_count,
           coalesce(sum(amount), 0) as total_raised,
           coalesce(sum(amount) filter (where t = 'INDIVIDUAL'), 0) as individual_contributions,
           coalesce(sum(amount) filter (where is_self), 0) as self_funding,
           coalesce(sum(amount) filter (where t = 'ENTITY'), 0) as entity_contributions,
           coalesce(sum(amount) filter (where t = 'INDIVIDUAL' and not is_self and amount < 200), 0) as small_dollar_contributions,
           count(*) filter (where t = 'INDIVIDUAL' and not is_self and amount < 200) as small_dollar_count,
           count(*) filter (where t = 'INDIVIDUAL' and not is_self) as individual_donor_count,
           max(contribution_date) as as_of
    from hub_t_rows
    group by candidate_id, state_id
  ) f
  left join public.candidate_expenditures_summaries e on e.candidate_id = f.candidate_id;
  get diagnostics v_rows = row_count;
  insert into public.hub_cache_meta (name, refreshed_at, states, rows_written, duration_ms)
  values ('candidate_finance', now(), states, v_rows, extract(epoch from clock_timestamp() - t0) * 1000)
  on conflict (name) do update set refreshed_at = excluded.refreshed_at, states = excluded.states,
    rows_written = excluded.rows_written, duration_ms = excluded.duration_ms;

  -- 1b. Itemized loans.
  delete from public.hub_cache_loans where states is null or state_id = any (states);
  insert into public.hub_cache_loans
  select co.contribution_id, co.candidate_id, co.state_id, co.contribution_date, co.amount,
         co.contributor_name, co.contributor_kind, co.contributor_type, co.election_year, co.created_at
  from public.contributions co
  where co.receipt_type = 'loan'
    and co.candidate_id in (select candidate_id from public.race_participants)
    and (states is null or co.state_id = any (states));

  -- 2. Donors per candidate: named contributors, grouped by normalized name.
  create temp table hub_t_kept on commit drop as
  select * from (
    select candidate_id, state_id, t, k, count(*) as n, sum(amount) as total, max(contribution_date) as last_date,
           row_number() over (partition by candidate_id, t order by sum(amount) desc, k) as rn
    from hub_t_rows
    where named and k is not null
    group by candidate_id, state_id, t, k
  ) g
  where rn <= 300;

  delete from public.hub_cache_candidate_donors where states is null or state_id = any (states);
  insert into public.hub_cache_candidate_donors
  select kept.candidate_id, kept.state_id, kept.t, kept.rn,
         public.hub_last_name(rep.name, kept.t), public.hub_first_name(rep.name, kept.t),
         rep.employer, rep.occupation, rep.city, rep.st,
         kept.n, kept.total, kept.last_date
  from hub_t_kept kept
  join lateral (
    select r.contributor_name::text as name,
           nullif(r.contributor_employer, '')::text as employer, nullif(r.contributor_occupation, '')::text as occupation,
           nullif(r.contributor_city, '')::text as city, nullif(r.contributor_state, '')::text as st
    from hub_t_rows r
    where r.candidate_id = kept.candidate_id and r.t = kept.t and r.k = kept.k
    order by r.contribution_date desc nulls last
    limit 1
  ) rep on true;
  get diagnostics v_rows = row_count;
  insert into public.hub_cache_meta (name, refreshed_at, states, rows_written, duration_ms)
  values ('candidate_donors', now(), states, v_rows, extract(epoch from clock_timestamp() - t0) * 1000)
  on conflict (name) do update set refreshed_at = excluded.refreshed_at, states = excluded.states,
    rows_written = excluded.rows_written, duration_ms = excluded.duration_ms;

  -- 3. Committee donors per state (organizations only, no public funds).
  delete from public.hub_cache_committee_donors where states is null or upper(state) = any (states);
  insert into public.hub_cache_committee_donors
  with org as (
    select lower(state_id) as state, k, contributor_name::text as name,
           nullif(contributor_city, '')::text as city, nullif(contributor_state, '')::text as cstate,
           candidate_id, amount, contribution_date
    from hub_t_rows
    where t = 'ENTITY' and not is_public and named and k is not null
  ), per_candidate as (
    select state, k, candidate_id, count(*)::int as n, coalesce(sum(amount), 0) as total, max(contribution_date) as last_date
    from org group by state, k, candidate_id
  ), splits as (
    select state, k, jsonb_agg(jsonb_build_object(
             'candidate_id', candidate_id, 'contribution_count', n,
             'total_amount', total, 'last_contribution_date', last_date) order by total desc) as j
    from per_candidate group by state, k
  ), rolled as (
    select state, k,
           mode() within group (order by name) as name,
           mode() within group (order by city) as city,
           mode() within group (order by cstate) as cstate,
           count(*)::int as n, coalesce(sum(amount), 0) as total,
           count(distinct candidate_id)::int as candidates,
           min(contribution_date) as first_date, max(contribution_date) as last_date
    from org group by state, k
  )
  select r.state, row_number() over (partition by r.state order by r.total desc, r.k),
         r.k, r.name, r.city, r.cstate, r.n, r.total, r.candidates, r.first_date, r.last_date, sp.j
  from rolled r join splits sp on sp.state = r.state and sp.k = r.k;
  get diagnostics v_rows = row_count;
  insert into public.hub_cache_meta (name, refreshed_at, states, rows_written, duration_ms)
  values ('committee_donors', now(), states, v_rows, extract(epoch from clock_timestamp() - t0) * 1000)
  on conflict (name) do update set refreshed_at = excluded.refreshed_at, states = excluded.states,
    rows_written = excluded.rows_written, duration_ms = excluded.duration_ms;
end
$$;
revoke all on function public.hub_refresh_cache(text[]) from public, anon, authenticated;
grant execute on function public.hub_refresh_cache(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Readers over the caches (replace the live versions from 001)
-- ---------------------------------------------------------------------------

drop function if exists public.hub_candidate_finance(uuid);
create or replace function public.hub_candidate_finance(p_candidate_id uuid)
returns table (
  candidate_id uuid, total_raised numeric, individual_contributions numeric, self_funding numeric,
  entity_contributions numeric, small_dollar_contributions numeric, small_dollar_count bigint,
  individual_donor_count bigint, as_of date, total_spent numeric
)
language sql stable
set search_path = pg_catalog, public
as $$
  select candidate_id, total_raised, individual_contributions, self_funding, entity_contributions,
         small_dollar_contributions, small_dollar_count, individual_donor_count, as_of, total_spent
  from public.hub_cache_candidate_finance
  where candidate_id = p_candidate_id
$$;

drop function if exists public.hub_candidate_top_donors(uuid, text, int);
create or replace function public.hub_candidate_top_donors(p_candidate_id uuid, p_kind text default 'all', p_limit int default 10)
returns table (
  candidate_id uuid, contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, city text, state text,
  contribution_count bigint, total_amount numeric, last_contribution_date date
)
language sql stable
set search_path = pg_catalog, public
as $$
  select candidate_id, contributor_last_name, contributor_first_name, contributor_type,
         employer, occupation, city, state, contribution_count, total_amount, last_contribution_date
  from public.hub_cache_candidate_donors
  where candidate_id = p_candidate_id
    and (p_kind = 'all' or (p_kind = 'individual' and contributor_type = 'INDIVIDUAL') or (p_kind = 'pac' and contributor_type = 'ENTITY'))
  order by total_amount desc, contributor_last_name, contributor_first_name
  limit least(greatest(coalesce(p_limit, 10), 1), 600)
$$;

drop function if exists public.hub_race_top_donors(text, text, int, text, int);
create or replace function public.hub_race_top_donors(
  p_state text, p_office text, p_district int default null, p_kind text default 'all', p_per_candidate int default 300)
returns table (
  candidate_id uuid, contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, city text, state text,
  contribution_count bigint, total_amount numeric, last_contribution_date date
)
language sql stable
set search_path = pg_catalog, public
as $$
  select d.candidate_id, d.contributor_last_name, d.contributor_first_name, d.contributor_type,
         d.employer, d.occupation, d.city, d.state, d.contribution_count, d.total_amount, d.last_contribution_date
  from public.race_participants rp
  join public.races r on r.race_id = rp.race_id
  join public.hub_cache_candidate_donors d on d.candidate_id = rp.candidate_id
  where r.state_id = upper(p_state) and r.office = p_office
    and (p_district is null or r.office_num = p_district)
    and (p_kind = 'all' or (p_kind = 'individual' and d.contributor_type = 'INDIVIDUAL') or (p_kind = 'pac' and d.contributor_type = 'ENTITY'))
    and d.rn <= least(greatest(coalesce(p_per_candidate, 300), 1), 300)
  order by d.total_amount desc
$$;

drop function if exists public.hub_state_committee_donors(text);
create or replace function public.hub_state_committee_donors(p_state text)
returns table (
  rn bigint, state text, norm_key text, name text, city text, contributor_state text,
  contribution_count int, total_amount numeric, candidate_count int,
  first_contribution_date date, last_contribution_date date, splits jsonb
)
language sql stable
set search_path = pg_catalog, public
as $$
  select rn, state, norm_key, name, city, contributor_state, contribution_count, total_amount, candidate_count,
         first_contribution_date, last_contribution_date, splits
  from public.hub_cache_committee_donors
  where state = lower(p_state)
  order by rn
$$;

grant execute on function
  public.hub_candidate_finance(uuid), public.hub_candidate_top_donors(uuid, text, int),
  public.hub_race_top_donors(text, text, int, text, int), public.hub_state_committee_donors(text)
to anon, authenticated, service_role;
