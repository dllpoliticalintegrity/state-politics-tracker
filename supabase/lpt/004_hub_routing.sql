-- 004: the hub_* read functions, routed by state. A state in
-- hub_state_source reads its own <prefix>_* tables (003); every other state
-- reads Henry's shared tables and matviews. The bodies here replace those
-- of 001 and 002 (same names and signatures, except the three candidate-
-- level functions that now take the state too) — apply after 003 with
-- execute_sql. Re-runnable.
--
-- plpgsql with EXECUTE on purpose: the table names are decided at run time,
-- and EXECUTE ... USING plans each call with the actual state, so the
-- generic-plan sequential scans that 001 worked around cannot come back.

do $$ begin
  create type public.hub_source_t as (
    prefix text,
    candidates text, races text, participants text,
    contrib_attr text, contrib_attr_pred text,
    contrib_raw text,
    exp_attr text, exp_attr_pred text,
    ie text, ie_pred text,
    polls text, poll_results text
  );
exception when duplicate_object then null; end $$;

-- Where a state's rows live. His matviews are already attributed/filtered,
-- so their predicates are `true`; ours filter the raw rows.
create or replace function public.hub_src(p_state text)
returns public.hub_source_t
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare p text; s public.hub_source_t;
begin
  select prefix into p from public.hub_state_source where state_id = upper(p_state);
  if p is null then
    s := ('',
          'candidates', 'races', 'race_participants',
          'candidate_contributions_attributed', 'true',
          'contributions',
          'candidate_expenditures_attributed', 'true',
          'candidate_ie_expenditures', 'true',
          'race_polls', 'race_poll_results');
  else
    s := (p,
          p || '_candidates', p || '_races', p || '_race_participants',
          p || '_contributions', '(receipt_type is null or receipt_type in (''contribution'', ''public_funds''))',
          p || '_contributions',
          p || '_expenditures', '(support_oppose is null or support_oppose = '''')',
          p || '_expenditures', '(support_oppose in (''S'', ''O''))',
          p || '_race_polls', p || '_race_poll_results');
  end if;
  return s;
end
$$;

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------

drop function if exists public.hub_candidates(text, text, int, int);
create or replace function public.hub_candidates(
  p_state text, p_office text default null, p_district int default null, p_year int default null)
returns table (
  id uuid, slug text, name text, raw_name text, party text, title text, bio text,
  photo_url text, photo_url_large text, photo_url_medium text, photo_url_thumb text,
  website text, twitter_user text, instagram_user text, facebook_user text, youtube_user text,
  state text, office text, district int, race_id uuid, race_slug text, election_year int,
  status text, on_ballot boolean, disposition text, is_incumbent boolean, featured boolean,
  committee_name text, state_filer_id text
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    select c.candidate_id,
           coalesce(nullif(c.slug, ''), c.candidate_id::text)::text,
           public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name)::text,
           c.candidate_name::text,
           coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1))::text,
           coalesce(o.title, c.title)::text, coalesce(o.bio, c.bio)::text,
           coalesce(o.photo_url, c.photo_url)::text, coalesce(o.photo_url_large, c.photo_url_large)::text,
           coalesce(o.photo_url_medium, c.photo_url_medium)::text, coalesce(o.photo_url_thumb, c.photo_url_thumb)::text,
           coalesce(o.website, c.website)::text,
           o.twitter_user::text, o.instagram_user::text, o.facebook_user::text, o.youtube_user::text,
           lower(r.state_id)::text, r.office::text, nullif(r.office_num, 0)::int, r.race_id, r.slug::text, r.year::int,
           public.hub_status(rp.on_ballot, rp.disposition, o.status)::text,
           rp.on_ballot, rp.disposition::text, rp.is_incumbent,
           coalesce(o.featured, c.featured, false),
           (c.committee_name)[1]::text, c.state_filer_id::text
    from public.%I rp
    join public.%I r on r.race_id = rp.race_id
    join public.%I c on c.candidate_id = rp.candidate_id
    left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
    where r.state_id = upper($1)
      and ($2 is null or r.office = $2)
      and ($3 is null or r.office_num = $3)
      and ($4 is null or r.year = $4)
  $q$, s.participants, s.races, s.candidates)
  using p_state, p_office, p_district, p_year;
end
$$;

-- Raised / spent per candidate of a race: his summaries, or our cache.
drop function if exists public.hub_race_totals(text, text, int);
create or replace function public.hub_race_totals(p_state text, p_office text default null, p_district int default null)
returns table (candidate_id uuid, raised numeric, spent numeric)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  if s.prefix = '' then
    return query execute $q$
      select rp.candidate_id, coalesce(s.total_contributions, 0)::numeric, coalesce(e.total_expenditures, 0)::numeric
      from public.race_participants rp
      join public.races r on r.race_id = rp.race_id
      left join public.candidate_contributions_summaries s on s.candidate_id = rp.candidate_id
      left join public.candidate_expenditures_summaries e on e.candidate_id = rp.candidate_id
      where r.state_id = upper($1) and ($2 is null or r.office = $2) and ($3 is null or r.office_num = $3)
    $q$ using p_state, p_office, p_district;
  else
    return query execute format($q$
      select rp.candidate_id, coalesce(f.total_raised, 0)::numeric, coalesce(f.total_spent, 0)::numeric
      from public.%I rp
      join public.%I r on r.race_id = rp.race_id
      left join public.hub_cache_candidate_finance f on f.candidate_id = rp.candidate_id
      where r.state_id = upper($1) and ($2 is null or r.office = $2) and ($3 is null or r.office_num = $3)
    $q$, s.participants, s.races) using p_state, p_office, p_district;
  end if;
end
$$;

-- Top donors per candidate across a race, from the cache.
drop function if exists public.hub_race_top_donors(text, text, int, text, int);
create or replace function public.hub_race_top_donors(
  p_state text, p_office text, p_district int default null, p_kind text default 'all', p_per_candidate int default 300)
returns table (
  candidate_id uuid, contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, city text, state text,
  contribution_count bigint, total_amount numeric, last_contribution_date date
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    select d.candidate_id, d.contributor_last_name, d.contributor_first_name, d.contributor_type,
           d.employer, d.occupation, d.city, d.state, d.contribution_count, d.total_amount, d.last_contribution_date
    from public.%I rp
    join public.%I r on r.race_id = rp.race_id
    join public.hub_cache_candidate_donors d on d.candidate_id = rp.candidate_id
    where r.state_id = upper($1) and r.office = $2
      and ($3 is null or r.office_num = $3)
      and ($4 = 'all' or ($4 = 'individual' and d.contributor_type = 'INDIVIDUAL') or ($4 = 'pac' and d.contributor_type = 'ENTITY'))
      and d.rn <= least(greatest(coalesce($5, 300), 1), 300)
    order by d.total_amount desc
  $q$, s.participants, s.races) using p_state, p_office, p_district, p_kind, p_per_candidate;
end
$$;

-- Self-funding (by name, from the attributed rows) and itemized loans (cache).
drop function if exists public.hub_candidate_loans(uuid);
drop function if exists public.hub_candidate_loans(text, uuid);
create or replace function public.hub_candidate_loans(p_state text, p_candidate_id uuid)
returns table (
  contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, total_amount numeric, contribution_count bigint, last_date date, source text
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    with x as (
      select 'self'::text as source, a.contributor_name::text as name, 'INDIVIDUAL'::text as t,
             max(nullif(a.contributor_employer, ''))::text as employer, max(nullif(a.contributor_occupation, ''))::text as occupation,
             sum(a.amount) as total, count(*) as n, max(a.contribution_date) as last_date
      from public.%I a
      where a.candidate_id = $1 and %s
        and (a.contributor_type = 'Self-funding' or a.contributor_kind = 'self')
      group by a.contributor_name
      union all
      select 'loan', l.contributor_name::text,
             case when position(',' in l.contributor_name) > 0 then 'INDIVIDUAL' else 'ENTITY' end,
             null::text, null::text, sum(l.amount), count(*), max(l.contribution_date)
      from public.hub_cache_loans l
      where l.candidate_id = $1
      group by l.contributor_name
    )
    select public.hub_last_name(name, t), public.hub_first_name(name, t), t,
           employer, occupation, total::numeric, n::bigint, last_date::date, source
    from x where name is not null
    order by total desc
  $q$, s.contrib_attr, s.contrib_attr_pred) using p_candidate_id;
end
$$;

-- Top employers of a candidate's individual donors: his matview, or live.
drop function if exists public.hub_candidate_top_employers(text, uuid, int);
create or replace function public.hub_candidate_top_employers(p_state text, p_candidate_id uuid, p_limit int default 10)
returns table (name text, amount numeric, donors bigint)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  if s.prefix = '' then
    return query select e.employer::text, e.amount::numeric, e.donors::bigint
      from public.candidate_top_employers e where e.candidate_id = p_candidate_id
      order by e.rnk limit least(greatest(coalesce(p_limit, 10), 1), 50);
  else
    return query execute format($q$
      select a.contributor_employer::text, sum(a.amount)::numeric, count(distinct a.contributor_name)::bigint
      from public.%I a
      where a.candidate_id = $1 and %s
        and public.hub_contributor_type(a.contributor_kind, a.contributor_type) = 'INDIVIDUAL'
        and nullif(btrim(a.contributor_employer), '') is not null
      group by a.contributor_employer
      order by sum(a.amount) desc
      limit least(greatest(coalesce($2, 10), 1), 50)
    $q$, s.contrib_attr, s.contrib_attr_pred) using p_candidate_id, p_limit;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Outside spending
-- ---------------------------------------------------------------------------

drop function if exists public.hub_race_ie_by_candidate(text, text, int);
create or replace function public.hub_race_ie_by_candidate(p_state text, p_office text, p_district int default null)
returns table (
  candidate_id uuid, slug text, name text, cycle text,
  total_supporting numeric, total_opposing numeric, supporting_count bigint, opposing_count bigint,
  committee_count bigint, as_of date
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    select rp.candidate_id,
           coalesce(nullif(c.slug, ''), c.candidate_id::text)::text,
           public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name)::text,
           'all'::text,
           coalesce(sum(ie.amount) filter (where ie.support_oppose = 'S'), 0)::numeric,
           coalesce(sum(ie.amount) filter (where ie.support_oppose = 'O'), 0)::numeric,
           count(*) filter (where ie.support_oppose = 'S'),
           count(*) filter (where ie.support_oppose = 'O'),
           count(distinct ie.spender_name),
           max(ie.expenditure_date)::date
    from public.%I rp
    join public.%I r on r.race_id = rp.race_id
    join public.%I c on c.candidate_id = rp.candidate_id
    left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
    cross join lateral (select * from public.%I ie where ie.candidate_id = rp.candidate_id and %s) ie
    where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
    group by rp.candidate_id, c.candidate_id, o.display_name
  $q$, s.participants, s.races, s.candidates, s.ie, s.ie_pred) using p_state, p_office, p_district;
end
$$;

drop function if exists public.hub_race_ie_committees(text, text, int);
create or replace function public.hub_race_ie_committees(p_state text, p_office text, p_district int default null)
returns table (filer_id text, name text, total_amount numeric, supporting numeric, opposing numeric, transaction_count bigint)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  return query execute format($q$
    select coalesce(ie.committee_id::text, ie.spender_name::text), ie.spender_name::text,
           sum(ie.amount)::numeric,
           coalesce(sum(ie.amount) filter (where ie.support_oppose = 'S'), 0)::numeric,
           coalesce(sum(ie.amount) filter (where ie.support_oppose = 'O'), 0)::numeric,
           count(*)
    from public.%I rp
    join public.%I r on r.race_id = rp.race_id
    cross join lateral (select * from public.%I ie where ie.candidate_id = rp.candidate_id and %s) ie
    where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
      and ie.spender_name is not null
    group by coalesce(ie.committee_id::text, ie.spender_name::text), ie.spender_name
    order by sum(ie.amount) desc
  $q$, s.participants, s.races, s.ie, s.ie_pred) using p_state, p_office, p_district;
end
$$;

-- Donors to the committees spending in a race, per committee.
drop function if exists public.hub_race_ie_donors(text, text, int, text);
create or replace function public.hub_race_ie_donors(p_state text, p_office text, p_district int default null, p_kind text default 'all')
returns table (
  ie_filer_ident text, committee_name text,
  contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, city text, state text,
  contribution_count bigint, total_amount numeric, last_contribution_date date
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  if s.prefix = '' then
    return query execute $q$
      with rows_ as (
        select distinct ic.committee, ic.contributor_name, ic.amount, ic.contribution_date,
               case when position(',' in ic.contributor_name) > 0 then 'INDIVIDUAL' else 'ENTITY' end as t,
               public.hub_norm_name(ic.contributor_name) as k
        from public.race_participants rp
        join public.races r on r.race_id = rp.race_id
        cross join lateral (select * from public.candidate_ie_contributors ic where ic.candidate_id = rp.candidate_id) ic
        where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
      ), g as (
        select committee, t, k,
               (array_agg(contributor_name order by contribution_date desc nulls last))[1] as name,
               count(*) as n, sum(amount) as total, max(contribution_date) as last_date
        from rows_
        where k is not null
          and ($4 = 'all' or ($4 = 'individual' and t = 'INDIVIDUAL') or ($4 = 'pac' and t = 'ENTITY'))
        group by committee, t, k
      )
      select committee::text, committee::text,
             public.hub_last_name(name, t), public.hub_first_name(name, t), t,
             null::text, null::text, null::text, null::text, n, total::numeric, last_date::date
      from g order by total desc
    $q$ using p_state, p_office, p_district, p_kind;
  else
    return query execute format($q$
      with cmtes as (
        select distinct ie.committee_id
        from public.%1$I rp
        join public.%2$I r on r.race_id = rp.race_id
        cross join lateral (select committee_id from public.%3$I ie where ie.candidate_id = rp.candidate_id and %4$s) ie
        where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
          and ie.committee_id is not null
      ), rows_ as (
        select ic.committee_id, ic.committee_name, ic.contributor_name, ic.amount, ic.contribution_date,
               ic.contributor_employer, ic.contributor_occupation, ic.contributor_city, ic.contributor_state,
               public.hub_contributor_type(ic.contributor_kind, ic.contributor_type) as t,
               public.hub_norm_name(ic.contributor_name) as k
        from public.%5$I ic join cmtes on cmtes.committee_id = ic.committee_id
      ), g as (
        select committee_id, t, k,
               (array_agg(committee_name order by contribution_date desc nulls last))[1] as cname,
               (array_agg(contributor_name order by contribution_date desc nulls last))[1] as name,
               (array_agg(contributor_employer order by contribution_date desc nulls last) filter (where nullif(contributor_employer, '') is not null))[1] as employer,
               (array_agg(contributor_occupation order by contribution_date desc nulls last) filter (where nullif(contributor_occupation, '') is not null))[1] as occupation,
               (array_agg(contributor_city order by contribution_date desc nulls last) filter (where nullif(contributor_city, '') is not null))[1] as city,
               (array_agg(contributor_state order by contribution_date desc nulls last) filter (where nullif(contributor_state, '') is not null))[1] as st,
               count(*) as n, sum(amount) as total, max(contribution_date) as last_date
        from rows_
        where k is not null
          and ($4 = 'all' or ($4 = 'individual' and t = 'INDIVIDUAL') or ($4 = 'pac' and t = 'ENTITY'))
        group by committee_id, t, k
      )
      select committee_id::text, coalesce(cname, committee_id)::text,
             public.hub_last_name(name, t), public.hub_first_name(name, t), t,
             employer::text, occupation::text, city::text, st::text, n, total::numeric, last_date::date
      from g order by total desc
    $q$, s.participants, s.races, s.ie, s.ie_pred, s.prefix || '_ie_contributions')
    using p_state, p_office, p_district, p_kind;
  end if;
end
$$;

-- Most recent independent expenditures for or against one candidate.
drop function if exists public.hub_candidate_ie_activity(text, uuid, int);
create or replace function public.hub_candidate_ie_activity(p_state text, p_candidate_id uuid, p_limit int default 10)
returns table (committee text, filer_id text, payee text, purpose text, amount numeric, expenditure_date date, support_oppose text)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state);
begin
  if s.prefix = '' then
    return query select a.committee::text, a.committee::text, a.payee::text, a.purpose::text, a.amount::numeric, a.expenditure_date::date, a.support_oppose::text
      from public.candidate_ie_activity a
      where a.candidate_id = p_candidate_id and a.support_oppose in ('S', 'O') and a.rnk_by_date <= least(greatest(coalesce(p_limit, 10), 1), 100)
      order by a.expenditure_date desc nulls last, a.amount desc
      limit least(greatest(coalesce(p_limit, 10), 1), 100);
  else
    return query execute format($q$
      select ie.spender_name::text, coalesce(ie.committee_id::text, ie.spender_name::text), ie.payee_name::text, ie.purpose::text,
             ie.amount::numeric, ie.expenditure_date::date, ie.support_oppose::text
      from public.%I ie
      where ie.candidate_id = $1 and %s
      order by ie.expenditure_date desc nulls last, ie.amount desc
      limit least(greatest(coalesce($2, 10), 1), 100)
    $q$, s.ie, s.ie_pred) using p_candidate_id, p_limit;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Ticker and river
-- ---------------------------------------------------------------------------

drop function if exists public.hub_latest_contributions(text, text, int, numeric, int);
create or replace function public.hub_latest_contributions(
  p_state text, p_office text, p_district int default null, p_min_amount numeric default 30000, p_limit int default 20)
returns table (
  id uuid, amount numeric, contribution_date date, contributor_type text,
  contributor_first_name text, contributor_last_name text, employer text, city text, state text,
  candidate_id uuid, candidate_name text, candidate_party text
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state); lat text;
begin
  if s.prefix = '' then
    -- His (candidate_id, amount desc) index makes the floor cheap; the
    -- attribution rule is applied to the few rows above it.
    lat := $l$
      select a.contribution_id, a.amount, a.contribution_date, a.contributor_name,
             public.hub_contributor_type(a.contributor_kind, a.contributor_type) as t,
             a.contributor_employer, a.contributor_city, a.contributor_state, a.candidate_id
      from public.contributions a
      left join public.candidate_committee_attribution cca on cca.candidate_id = a.candidate_id
      where a.candidate_id = cands.candidate_id
        and a.amount >= $4 and a.contribution_date is not null
        and (a.receipt_type is null or a.receipt_type in ('contribution', 'public_funds'))
        and (cca.committee_names_norm is null or public.hub_committee_norm(a.committee_name) = any (cca.committee_names_norm))
      order by a.contribution_date desc, a.amount desc
      limit least(greatest(coalesce($5, 20), 1), 100)$l$;
  else
    lat := format($l$
      select a.contribution_id, a.amount, a.contribution_date, a.contributor_name,
             public.hub_contributor_type(a.contributor_kind, a.contributor_type) as t,
             a.contributor_employer, a.contributor_city, a.contributor_state, a.candidate_id
      from public.%I a
      where a.candidate_id = cands.candidate_id
        and a.amount >= $4 and a.contribution_date is not null and %s
      order by a.contribution_date desc, a.amount desc
      limit least(greatest(coalesce($5, 20), 1), 100)$l$, s.contrib_raw, s.contrib_attr_pred);
  end if;
  return query execute format($q$
    with cands as (
      select rp.candidate_id,
             public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name) as name,
             coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1)) as party
      from public.%I rp
      join public.%I r on r.race_id = rp.race_id
      join public.%I c on c.candidate_id = rp.candidate_id
      left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
      where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
        and public.hub_status(rp.on_ballot, rp.disposition, o.status)
            not in ('withdrawn', 'lost_primary', 'disqualified', 'not_on_ballot')
    ), a as (
      select x.* from cands cross join lateral (%s) x
    )
    select a.contribution_id, a.amount::numeric, a.contribution_date::date, a.t::text,
           public.hub_first_name(a.contributor_name, a.t), public.hub_last_name(a.contributor_name, a.t),
           nullif(a.contributor_employer, '')::text, nullif(a.contributor_city, '')::text, nullif(a.contributor_state, '')::text,
           a.candidate_id, cands.name::text, cands.party::text
    from a join cands on cands.candidate_id = a.candidate_id
    order by a.contribution_date desc, a.amount desc
    limit least(greatest(coalesce($5, 20), 1), 100)
  $q$, s.participants, s.races, s.candidates, lat)
  using p_state, p_office, p_district, p_min_amount, p_limit;
end
$$;

drop function if exists public.hub_money_river(text, text, int, text, uuid, int, int);
create or replace function public.hub_money_river(
  p_state text, p_office text, p_district int default null, p_kind text default 'all',
  p_candidate uuid default null, p_limit int default 50, p_offset int default 0)
returns table (
  kind text, id uuid, txn_date date, amount numeric, candidate_id uuid, candidate_slug text,
  candidate_name text, candidate_party text, state text, office text, district text,
  counterparty text, counterparty_type text, detail text, support_oppose text, cycle text,
  imported_at timestamptz, total_count bigint
)
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state); clat text;
begin
  -- Only the rows that can reach this page per candidate, walked by the
  -- (candidate_id, contribution_date desc) index.
  if s.prefix = '' then
    clat := $l$
      select a.*
      from public.contributions a
      left join public.candidate_committee_attribution cca on cca.candidate_id = a.candidate_id
      where a.candidate_id = cands.candidate_id
        and (a.receipt_type is null or a.receipt_type in ('contribution', 'public_funds'))
        and (cca.committee_names_norm is null or public.hub_committee_norm(a.committee_name) = any (cca.committee_names_norm))
      order by a.contribution_date desc nulls last
      limit least(greatest(coalesce($6, 50), 1), 200) + greatest(coalesce($7, 0), 0)$l$;
  else
    clat := format($l$
      select a.*
      from public.%I a
      where a.candidate_id = cands.candidate_id and %s
      order by a.contribution_date desc nulls last
      limit least(greatest(coalesce($6, 50), 1), 200) + greatest(coalesce($7, 0), 0)$l$, s.contrib_raw, s.contrib_attr_pred);
  end if;
  return query execute format($q$
    with cands as (
      select rp.candidate_id,
             coalesce(nullif(c.slug, ''), c.candidate_id::text) as slug,
             public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name) as name,
             coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1)) as party,
             lower(r.state_id) as state, r.office::text as office, nullif(r.office_num, 0)::text as district
      from public.%1$I rp
      join public.%2$I r on r.race_id = rp.race_id
      join public.%3$I c on c.candidate_id = rp.candidate_id
      left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
      where r.state_id = upper($1) and r.office = $2 and ($3 is null or r.office_num = $3)
        and ($5 is null or rp.candidate_id = $5)
    ), rows_ as (
      select 'contribution'::text as kind, a.contribution_id as id, a.contribution_date as txn_date, a.amount,
             a.candidate_id, a.contributor_name::text as who, a.contributor_kind::text as who_kind, a.contributor_type::text as who_type,
             a.contributor_employer::text as d1, a.contributor_city::text as d2, a.contributor_state::text as d3,
             null::text as support_oppose, a.election_year, a.created_at as imported_at
      from cands cross join lateral (%4$s) a
      where $4 in ('all', 'contribution')
      union all
      select 'expenditure', e.expenditure_id, e.expenditure_date, e.amount, e.candidate_id,
             e.payee_name::text, 'payee', null, e.purpose::text, e.category::text, e.payee_city::text,
             null, e.election_year, e.created_at
      from cands cross join lateral (select * from public.%5$I e where e.candidate_id = cands.candidate_id and %6$s) e
      where $4 in ('all', 'expenditure')
      union all
      select 'loan', co.contribution_id, co.contribution_date, co.amount, co.candidate_id,
             co.contributor_name::text, co.contributor_kind::text, co.contributor_type::text,
             null, null, null, null, co.election_year, co.created_at
      from cands cross join lateral (select * from public.hub_cache_loans co where co.candidate_id = cands.candidate_id) co
      where $4 in ('all', 'loan')
      union all
      select 'outside', ie.expenditure_id, ie.expenditure_date, ie.amount, ie.candidate_id,
             ie.spender_name::text, 'committee', null, ie.purpose::text, ie.payee_name::text, null,
             ie.support_oppose::text, ie.election_year, ie.created_at
      from cands cross join lateral (select * from public.%7$I ie where ie.candidate_id = cands.candidate_id and %8$s) ie
      where $4 in ('all', 'outside')
    ), total as (
      select coalesce(sum(
               case when $4 in ('all', 'contribution') then f.contribution_count else 0 end
             + case when $4 in ('all', 'expenditure') then f.expenditure_count else 0 end
             + case when $4 in ('all', 'outside') then f.ie_count else 0 end), 0)::bigint
           + (select count(*) from public.hub_cache_loans l join cands on cands.candidate_id = l.candidate_id
              where $4 in ('all', 'loan'))::bigint as n
      from cands
      left join public.hub_cache_candidate_finance f on f.candidate_id = cands.candidate_id
    ), page as (
      select x.* from rows_ x
      order by x.txn_date desc nulls last, x.imported_at desc, x.id
      limit least(greatest(coalesce($6, 50), 1), 200) offset greatest(coalesce($7, 0), 0)
    )
    select x.kind, x.id, x.txn_date::date, x.amount::numeric, x.candidate_id, c.slug::text, c.name::text, c.party::text,
           c.state::text, c.office::text, c.district::text,
           (case when x.kind in ('contribution', 'loan') and public.hub_contributor_type(x.who_kind, x.who_type) = 'INDIVIDUAL'
                 then public.hub_flip_name(x.who) else x.who end)::text,
           (case when x.kind in ('contribution', 'loan') then public.hub_contributor_type(x.who_kind, x.who_type)
                 when x.kind = 'outside' then 'COMMITTEE' else null end)::text,
           nullif(concat_ws(' · ', nullif(x.d1, ''), nullif(x.d2, ''), nullif(x.d3, '')), '')::text,
           x.support_oppose::text, x.election_year::text, x.imported_at::timestamptz,
           (select n from total)
    from page x
    join cands c on c.candidate_id = x.candidate_id
    order by x.txn_date desc nulls last, x.imported_at desc, x.id
  $q$, s.participants, s.races, s.candidates, clat, s.exp_attr, s.exp_attr_pred, s.ie, s.ie_pred)
  using p_state, p_office, p_district, p_kind, p_candidate, p_limit, p_offset;
end
$$;

-- ---------------------------------------------------------------------------
-- Polling: every poll of a race with its results, plus the race's published
-- average when one exists (hub_poll_averages).
-- ---------------------------------------------------------------------------

drop function if exists public.hub_race_polls(text, text);
create or replace function public.hub_race_polls(p_state text, p_slug text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare s public.hub_source_t := public.hub_src(p_state); polls jsonb; avg jsonb;
begin
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object(
             'poll_id', p.poll_id, 'source', p.source, 'poll_date', p.poll_date,
             'sample_size', p.sample_size, 'sample_type', p.sample_type, 'margin_of_error', p.margin_of_error,
             'matchup', %s, 'source_url', %s,
             'results', (select coalesce(jsonb_agg(jsonb_build_object(
                           'label', x.label, 'party', x.party, 'pct', x.pct, 'candidate_id', x.candidate_id)), '[]'::jsonb)
                         from public.%I x where x.poll_id = p.poll_id)
           ) order by p.poll_date desc nulls last), '[]'::jsonb)
    from public.%I p
    join public.%I r on r.race_id = p.race_id
    where r.state_id = upper($1) and r.slug = $2
  $q$, case when s.prefix = '' then 'null' else 'p.matchup' end,
       case when s.prefix = '' then 'null' else 'p.source_url' end,
       s.poll_results, s.polls, s.races)
  into polls using p_state, p_slug;
  select jsonb_build_object('source', a.source, 'source_url', a.source_url, 'as_of', a.as_of, 'spread', a.spread,
                            'last_updated', a.last_updated, 'averages', a.averages)
    into avg from public.hub_poll_averages a where a.state_id = upper(p_state) and a.race_slug = p_slug;
  return jsonb_build_object('polls', polls, 'average', avg);
end
$$;

-- ---------------------------------------------------------------------------
-- The cache refresh, routed per state.
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
  st text; s public.hub_source_t;
begin
  create temp table hub_t_rows (
    candidate_id uuid, state_id text, contributor_name text, amount numeric, contribution_date date,
    contributor_employer text, contributor_occupation text, contributor_city text, contributor_state text,
    t text, is_self boolean, is_public boolean, named boolean, k text
  ) on commit drop;
  create temp table hub_t_loans (like public.hub_cache_loans) on commit drop;
  create temp table hub_t_counts (candidate_id uuid, total_spent numeric, expenditure_count bigint, ie_count bigint) on commit drop;

  for st in
    select x.state_id from (
      select distinct r.state_id::text from public.races r
      union select h.state_id from public.hub_state_source h
    ) x
    where states is null or x.state_id = any (states)
  loop
    s := public.hub_src(st);
    execute format($q$
      insert into hub_t_rows
      select a.candidate_id, a.state_id::text, a.contributor_name::text, a.amount, a.contribution_date,
             a.contributor_employer::text, a.contributor_occupation::text, a.contributor_city::text, a.contributor_state::text,
             public.hub_contributor_type(a.contributor_kind, a.contributor_type),
             coalesce(a.contributor_type = 'Self-funding' or a.contributor_kind = 'self', false),
             coalesce(a.contributor_kind, '') = 'public' or coalesce(a.contributor_type, '') = 'Public funds',
             public.hub_is_named(a.contributor_name),
             public.hub_norm_name(a.contributor_name)
      from public.%I a
      where a.state_id = $1 and %s
        and a.candidate_id in (select candidate_id from public.%I where state_id = $1)
    $q$, s.contrib_attr, s.contrib_attr_pred, s.participants) using st;

    execute format($q$
      insert into hub_t_loans
      select co.contribution_id, co.candidate_id, co.state_id::text, co.contribution_date, co.amount,
             co.contributor_name::text, co.contributor_kind::text, co.contributor_type::text, co.election_year, co.created_at
      from public.%I co
      where co.receipt_type = 'loan' and co.state_id = $1
        and co.candidate_id in (select candidate_id from public.%I where state_id = $1)
    $q$, s.contrib_raw, s.participants) using st;

    if s.prefix = '' then
      execute $q$
        insert into hub_t_counts
        select rp.candidate_id,
               (select coalesce(e.total_expenditures, 0) from public.candidate_expenditures_summaries e where e.candidate_id = rp.candidate_id),
               (select count(*) from public.candidate_expenditures_attributed x where x.candidate_id = rp.candidate_id),
               (select count(*) from public.candidate_ie_expenditures y where y.candidate_id = rp.candidate_id and y.support_oppose in ('S', 'O'))
        from (select distinct candidate_id from public.race_participants where state_id = $1) rp
      $q$ using st;
    else
      execute format($q$
        insert into hub_t_counts
        select rp.candidate_id,
               (select coalesce(sum(x.amount), 0) from public.%1$I x where x.candidate_id = rp.candidate_id and %2$s),
               (select count(*) from public.%1$I x where x.candidate_id = rp.candidate_id and %2$s),
               (select count(*) from public.%3$I y where y.candidate_id = rp.candidate_id and %4$s)
        from (select distinct candidate_id from public.%5$I where state_id = $1) rp
      $q$, s.exp_attr, s.exp_attr_pred, s.ie, s.ie_pred, s.participants) using st;
    end if;
  end loop;
  create index on hub_t_rows (candidate_id, t, k);

  -- 1. Finance rollup per candidate.
  delete from public.hub_cache_candidate_finance where states is null or state_id = any (states);
  insert into public.hub_cache_candidate_finance
  select f.candidate_id, f.state_id, f.total_raised, f.individual_contributions, f.self_funding,
         f.entity_contributions, f.small_dollar_contributions, f.small_dollar_count, f.individual_donor_count,
         f.as_of, coalesce(c.total_spent, 0), f.contribution_count, coalesce(c.expenditure_count, 0), coalesce(c.ie_count, 0)
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
  left join hub_t_counts c on c.candidate_id = f.candidate_id;
  get diagnostics v_rows = row_count;
  insert into public.hub_cache_meta (name, refreshed_at, states, rows_written, duration_ms)
  values ('candidate_finance', now(), states, v_rows, extract(epoch from clock_timestamp() - t0) * 1000)
  on conflict (name) do update set refreshed_at = excluded.refreshed_at, states = excluded.states,
    rows_written = excluded.rows_written, duration_ms = excluded.duration_ms;

  -- 1b. Itemized loans.
  delete from public.hub_cache_loans where states is null or state_id = any (states);
  insert into public.hub_cache_loans select * from hub_t_loans;

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
    select r.contributor_name as name,
           nullif(r.contributor_employer, '') as employer, nullif(r.contributor_occupation, '') as occupation,
           nullif(r.contributor_city, '') as city, nullif(r.contributor_state, '') as st
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
    select lower(state_id) as state, k, contributor_name as name,
           nullif(contributor_city, '') as city, nullif(contributor_state, '') as cstate,
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

grant execute on function
  public.hub_src(text),
  public.hub_candidates(text, text, int, int), public.hub_race_totals(text, text, int),
  public.hub_race_top_donors(text, text, int, text, int), public.hub_candidate_loans(text, uuid),
  public.hub_candidate_top_employers(text, uuid, int),
  public.hub_race_ie_by_candidate(text, text, int), public.hub_race_ie_committees(text, text, int),
  public.hub_race_ie_donors(text, text, int, text), public.hub_candidate_ie_activity(text, uuid, int),
  public.hub_latest_contributions(text, text, int, numeric, int),
  public.hub_money_river(text, text, int, text, uuid, int, int),
  public.hub_race_polls(text, text)
to anon, authenticated, service_role;
