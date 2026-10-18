-- 001: the hub's read layer in the Local Politics Tracker project (LPT,
-- rwiueylzgcgnzypdyszi) — see docs/lpt-frontend-plan.md.
--
-- How to apply: by hand, in order, with the Supabase MCP's execute_sql (not
-- apply_migration: this is Henry's project and it has no migration history).
-- Everything here is re-runnable (create or replace / if not exists).
--
-- Rules this file follows:
--   * every object is prefixed hub_;
--   * no view or materialized view of ours is built on Henry's objects — his
--     SQL may `drop ... cascade`, which would delete them silently. SQL
--     functions carry no dependency, so a cascade on his side leaves them in
--     place; they error until his objects are back, then work again;
--   * his tables are never altered. Curated fields live in
--     hub_candidate_overrides, keyed by candidate_id with no foreign key, so
--     his candidate rewrites can neither overwrite nor be blocked by us;
--   * functions are SECURITY INVOKER and schema-qualify every reference.
--     anon already has SELECT on his tables (public-read RLS) and matviews.
--
-- Vocabulary (his): state_id is upper case ('GA'); offices are
-- 'governor', 'lt-governor', 'state-senate', 'state-representative', …;
-- office_num is the district, 0 for statewide; contributor_type is
-- 'Individual' / 'Self-funding' / 'PAC & committees' / 'Other organizations'
-- / 'Party' / 'Public funds'; contributor_kind is the machine form
-- ('individual', 'self', 'pac', 'other_org', 'party', 'candidate_committee',
-- 'committee', 'public'); support_oppose on expenditures is 'S' / 'O' / 'U'.
--
-- Vocabulary (ours, what the functions return): contributor_type is
-- 'INDIVIDUAL' or 'ENTITY' (the TEC-derived split the site was built on);
-- district is null for statewide; state is lower case.
--
-- Performance: PostgREST passes RPC arguments as sub-selects, so inside a
-- function the state is never a literal and the planner's generic estimate
-- for `state_id = $1` picks a sequential scan of the 3.5M-row contribution
-- matview (32 s, past anon's 30 s statement timeout). Every race- or
-- state-scoped function therefore walks its candidates with a LATERAL join on
-- candidate_id, which forces the (candidate_id) index: 0.3–3 s instead.
--
-- Caches: the race- and state-wide donor aggregates and the per-candidate
-- finance rollup read nightly-refilled hub_cache_* tables instead (002); the
-- live versions here are replaced when 002 is applied.
--
-- Per-state tables: the states Henry loads live in his shared tables. A state
-- we load ourselves (California first) gets its own <st>_* tables in this
-- project, mirroring his columns, and these functions grow a branch per such
-- state. Nothing here reads a prefixed table yet.

-- ---------------------------------------------------------------------------
-- Curated fields
-- ---------------------------------------------------------------------------

create table if not exists public.hub_candidate_overrides (
  candidate_id   uuid primary key,
  -- Denormalized so a row can be re-pointed if his candidate_id ever changes.
  state_id       text,
  slug           text,
  display_name   text,
  title          text,
  bio            text,
  photo_url      text,
  photo_url_large  text,
  photo_url_medium text,
  photo_url_thumb  text,
  website        text,
  twitter_user   text,
  instagram_user text,
  facebook_user  text,
  youtube_user   text,
  featured       boolean,
  -- Manual ballot status when his on_ballot / disposition are wrong:
  -- 'active' | 'won_primary' | 'nominee' | 'lost_primary' | 'withdrawn' |
  -- 'disqualified' | 'not_on_ballot'.
  status         text,
  updated_at     timestamptz not null default now(),
  -- The writer, as an opaque tag ('data-diamine'), never a person's email:
  -- the table is public-read.
  updated_via    text
);
comment on table public.hub_candidate_overrides is
  'Hub-curated candidate fields layered over LPT candidates. Written by the data-diamine admin with the service role; public read.';

alter table public.hub_candidate_overrides enable row level security;
drop policy if exists hub_candidate_overrides_public_read on public.hub_candidate_overrides;
create policy hub_candidate_overrides_public_read
  on public.hub_candidate_overrides for select
  to anon, authenticated
  using (true);
-- No insert/update/delete policies, and the default-privilege writes are
-- revoked too, so only service_role (which bypasses RLS) can write.
revoke all on public.hub_candidate_overrides from anon, authenticated;
grant select on public.hub_candidate_overrides to anon, authenticated;
grant all on public.hub_candidate_overrides to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- 'JACKSON, RICHARD L.' -> 'RICHARD L. JACKSON'; names without a comma pass
-- through. Same rules as LPT's candidate_display_name(), kept separate so a
-- cascade on his side cannot take it away.
create or replace function public.hub_flip_name(n text)
returns text
language sql immutable
as $$
  select case
    when n is null then null
    when array_length(p, 1) = 2 and p[1] <> '' and p[2] <> ''
         and p[2] !~* '^(JR|SR|II|III|IV|V)\.?$'
      then p[2] || ' ' || p[1]
    when array_length(p, 1) = 3 and p[1] <> '' and p[3] <> ''
         and p[2] ~* '^(JR|SR|II|III|IV|V)\.?$'
      then p[3] || ' ' || p[1] || ' ' || p[2]
    when array_length(p, 1) = 3 and p[1] <> '' and p[2] <> ''
         and p[3] ~* '^(JR|SR|II|III|IV|V)\.?$'
      then p[2] || ' ' || p[1] || ' ' || p[3]
    else n
  end
  from (
    select array(
      select btrim(x) from unnest(string_to_array(n, ',')) with ordinality as t(x, o) order by o
    ) as p
  ) s
$$;

-- Filings that shout ('VIVEK RAMASWAMY') get title case; anything with a
-- lower-case letter is left as filed. initcap handles hyphens and
-- apostrophes; "Mc"/"Mac" names are a known rough edge for the overrides.
create or replace function public.hub_title_case(n text)
returns text
language sql immutable
as $$
  select case when n is null or n <> upper(n) then n else initcap(lower(n)) end
$$;

-- Display name of a candidate: the curated one, else "First Last" from his
-- cased name parts, else the flipped filing name; shouting names title-cased.
create or replace function public.hub_display_name(raw text, first_name text, last_name text, override text)
returns text
language sql immutable
as $$
  select coalesce(
    nullif(btrim(override), ''),
    -- A display-form name as filed ("Betty T. Yee": no comma, not shouting) is kept whole.
    case when raw !~ ',' and raw <> upper(raw) then btrim(raw) end,
    public.hub_title_case(nullif(btrim(concat_ws(' ', nullif(btrim(first_name), ''), nullif(btrim(last_name), ''))), '')),
    public.hub_title_case(public.hub_flip_name(raw))
  )
$$;

-- Grouping key for donor names: upper case, letters/digits/spaces only.
create or replace function public.hub_norm_name(n text)
returns text
language sql immutable
as $$
  select nullif(regexp_replace(regexp_replace(upper(btrim(n)), '[^A-Z0-9 ]', '', 'g'), '\s+', ' ', 'g'), '')
$$;

-- Rows that name a real donor: unitemized and anonymous aggregates
-- ('(name not reported)', 'UNITEMIZED', 'Anonymous') stay out of donor lists.
create or replace function public.hub_is_named(n text)
returns boolean
language sql immutable
as $$
  select n is not null and btrim(n) <> '' and btrim(n) !~ '^\(' and n !~* 'unitemized|not reported|anonymous|aggregate'
$$;

-- The site's two-way split of contributors.
create or replace function public.hub_contributor_type(kind text, ctype text)
returns text
language sql immutable
as $$
  select case
    when kind in ('individual', 'self') then 'INDIVIDUAL'
    when kind is null and ctype in ('Individual', 'Self-funding') then 'INDIVIDUAL'
    else 'ENTITY'
  end
$$;

-- Last / first name of a donor as the site expects them: people filed as
-- "Last, First" split on the comma; organizations keep the whole name as the
-- last name.
create or replace function public.hub_last_name(n text, ctype text)
returns text
language sql immutable
as $$
  select case
    when ctype = 'INDIVIDUAL' and position(',' in n) > 0 then btrim(split_part(n, ',', 1))
    when ctype = 'INDIVIDUAL' and n ~ '\s' then regexp_replace(btrim(n), '^.*\s', '')
    else btrim(n)
  end
$$;

create or replace function public.hub_first_name(n text, ctype text)
returns text
language sql immutable
as $$
  select case
    when ctype = 'INDIVIDUAL' and position(',' in n) > 0 then nullif(btrim(substr(n, position(',' in n) + 1)), '')
    when ctype = 'INDIVIDUAL' and n ~ '\s' then nullif(btrim(regexp_replace(btrim(n), '\s\S+$', '')), '')
    else null
  end
$$;

-- Henry's attribution rule, for reading his base `contributions` table with
-- its indexes instead of the un-indexed-by-date matview: a row counts for
-- its candidate when it is a contribution (or public funds) and, if the
-- candidate has known committee names, was filed by one of them. The
-- committee_name expression matches his idx_contributions_candidate_committee_norm.
create or replace function public.hub_committee_norm(n text)
returns text
language sql immutable
as $$
  select upper(regexp_replace(btrim(n), '\s+', ' ', 'g'))
$$;

-- Ballot status in the site's vocabulary, from his on_ballot + disposition.
create or replace function public.hub_status(on_ballot boolean, disposition text, override text)
returns text
language sql immutable
as $$
  select coalesce(nullif(btrim(override), ''),
    case
      -- The hub's own vocabulary, as the bridged states carry it.
      when lower(disposition) in ('active', 'won_primary', 'nominee', 'lost_primary', 'withdrawn', 'disqualified', 'not_on_ballot') then lower(disposition)
      when lower(disposition) = 'eliminated' then 'lost_primary'
      when lower(disposition) = 'dropped_out' then 'withdrawn'
      when on_ballot is false then
        case
          when disposition ~* 'withdr' then 'withdrawn'
          when disposition ~* 'defeated|lost primary|not nominated' then 'lost_primary'
          when disposition ~* 'disqualif' then 'disqualified'
          else 'not_on_ballot'
        end
      when disposition ~* 'renominated' then 'won_primary'
      when disposition ~* 'nominated|candidate in the general' then 'nominee'
      else 'active'
    end)
$$;

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------

-- Every (race, candidate) pair of a state, optionally one office and one
-- district (office_num; 0 = statewide; null = every district of the office).
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
language sql stable
set search_path = pg_catalog, public
as $$
  select
    c.candidate_id,
    coalesce(nullif(c.slug, ''), c.candidate_id::text),
    public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name),
    c.candidate_name,
    coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1)),
    coalesce(o.title, c.title),
    coalesce(o.bio, c.bio),
    coalesce(o.photo_url, c.photo_url),
    coalesce(o.photo_url_large, c.photo_url_large),
    coalesce(o.photo_url_medium, c.photo_url_medium),
    coalesce(o.photo_url_thumb, c.photo_url_thumb),
    coalesce(o.website, c.website),
    o.twitter_user, o.instagram_user, o.facebook_user, o.youtube_user,
    lower(r.state_id),
    r.office,
    nullif(r.office_num, 0),
    r.race_id,
    r.slug,
    r.year,
    public.hub_status(rp.on_ballot, rp.disposition, o.status),
    rp.on_ballot,
    rp.disposition,
    rp.is_incumbent,
    coalesce(o.featured, c.featured, false),
    c.committee_name[1],
    c.state_filer_id
  from public.race_participants rp
  join public.races r on r.race_id = rp.race_id
  join public.candidates c on c.candidate_id = rp.candidate_id
  left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
  where r.state_id = upper(p_state)
    and (p_office is null or r.office = p_office)
    and (p_district is null or r.office_num = p_district)
    and (p_year is null or r.year = p_year)
$$;

-- Raised / spent per candidate of a race (all-time, every participant —
-- the summaries are per candidate, not per race).
drop function if exists public.hub_race_totals(text, text, int);
create or replace function public.hub_race_totals(p_state text, p_office text default null, p_district int default null)
returns table (candidate_id uuid, raised numeric, spent numeric)
language sql stable
set search_path = pg_catalog, public
as $$
  select rp.candidate_id,
         coalesce(s.total_contributions, 0),
         coalesce(e.total_expenditures, 0)
  from public.race_participants rp
  join public.races r on r.race_id = rp.race_id
  left join public.candidate_contributions_summaries s on s.candidate_id = rp.candidate_id
  left join public.candidate_expenditures_summaries e on e.candidate_id = rp.candidate_id
  where r.state_id = upper(p_state)
    and (p_office is null or r.office = p_office)
    and (p_district is null or r.office_num = p_district)
$$;

-- ---------------------------------------------------------------------------
-- One candidate's finance
-- ---------------------------------------------------------------------------

-- The candidate-page rollup. individual_contributions includes self-funding,
-- as the site's cf_contributions_summary did; self_funding is broken out so
-- the page can subtract it (it also arrives through hub_candidate_loans).
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
  with a as (
    select amount, contribution_date,
           public.hub_contributor_type(contributor_kind, contributor_type) as t,
           contributor_type = 'Self-funding' or contributor_kind = 'self' as is_self
    from public.candidate_contributions_attributed
    where candidate_id = p_candidate_id
  )
  select p_candidate_id,
         coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where t = 'INDIVIDUAL'), 0),
         coalesce(sum(amount) filter (where is_self), 0),
         coalesce(sum(amount) filter (where t = 'ENTITY'), 0),
         coalesce(sum(amount) filter (where t = 'INDIVIDUAL' and not is_self and amount < 200), 0),
         count(*) filter (where t = 'INDIVIDUAL' and not is_self and amount < 200),
         count(*) filter (where t = 'INDIVIDUAL' and not is_self),
         max(contribution_date),
         (select coalesce(e.total_expenditures, 0) from public.candidate_expenditures_summaries e where e.candidate_id = p_candidate_id)
  from a
$$;

-- Top donors to one candidate, grouped by normalized name. p_kind: 'all',
-- 'individual' or 'pac' (every non-person).
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
  with a as (
    select contributor_name, amount, contribution_date, contributor_employer, contributor_occupation,
           contributor_city, contributor_state,
           public.hub_contributor_type(contributor_kind, contributor_type) as t,
           public.hub_norm_name(contributor_name) as k
    from public.candidate_contributions_attributed
    where candidate_id = p_candidate_id
      and public.hub_is_named(contributor_name)
  ), g as (
    select t, k, count(*) as n, sum(amount) as total, max(contribution_date) as last_date
    from a
    where (p_kind = 'all' or (p_kind = 'individual' and t = 'INDIVIDUAL') or (p_kind = 'pac' and t = 'ENTITY'))
    group by t, k
    order by total desc, k
    limit least(greatest(coalesce(p_limit, 10), 1), 500)
  ), rep as (
    -- The donor's most recent spelling and details, for the rows that made the cut.
    select distinct on (a.t, a.k) a.t, a.k, a.contributor_name as name,
           nullif(a.contributor_employer, '') as employer, nullif(a.contributor_occupation, '') as occupation,
           nullif(a.contributor_city, '') as city, nullif(a.contributor_state, '') as st
    from a join g on g.t = a.t and g.k = a.k
    order by a.t, a.k, a.contribution_date desc nulls last
  )
  select p_candidate_id,
         public.hub_last_name(rep.name, g.t), public.hub_first_name(rep.name, g.t), g.t,
         rep.employer::text, rep.occupation::text, rep.city::text, rep.st::text, g.n, g.total, g.last_date
  from g join rep on rep.t = g.t and rep.k = g.k
  order by g.total desc, rep.name
$$;

-- The same, for every candidate of a race, the top p_per_candidate per
-- candidate; the site re-aggregates across candidates client-side.
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
  with cands as (
    select rp.candidate_id
    from public.race_participants rp
    join public.races r on r.race_id = rp.race_id
    where r.state_id = upper(p_state) and r.office = p_office
      and (p_district is null or r.office_num = p_district)
  ), a as (
    select cands.candidate_id, x.*
    from cands
    cross join lateral (
      select contributor_name, amount, contribution_date, contributor_employer, contributor_occupation,
             contributor_city, contributor_state,
             public.hub_contributor_type(contributor_kind, contributor_type) as t,
             public.hub_norm_name(contributor_name) as k
      from public.candidate_contributions_attributed a
      where a.candidate_id = cands.candidate_id
        and public.hub_is_named(contributor_name)
    ) x
  ), g as (
    select candidate_id, t, k, count(*) as n, sum(amount) as total, max(contribution_date) as last_date
    from a
    where (p_kind = 'all' or (p_kind = 'individual' and t = 'INDIVIDUAL') or (p_kind = 'pac' and t = 'ENTITY'))
    group by candidate_id, t, k
  ), ranked as (
    select g.*, row_number() over (partition by candidate_id order by total desc, k) as rn from g
  ), kept as (
    select * from ranked where rn <= least(greatest(coalesce(p_per_candidate, 300), 1), 300)
  ), rep as (
    select distinct on (a.candidate_id, a.t, a.k) a.candidate_id, a.t, a.k, a.contributor_name as name,
           nullif(a.contributor_employer, '') as employer, nullif(a.contributor_occupation, '') as occupation,
           nullif(a.contributor_city, '') as city, nullif(a.contributor_state, '') as st
    from a join kept on kept.candidate_id = a.candidate_id and kept.t = a.t and kept.k = a.k
    order by a.candidate_id, a.t, a.k, a.contribution_date desc nulls last
  )
  select kept.candidate_id,
         public.hub_last_name(rep.name, kept.t), public.hub_first_name(rep.name, kept.t), kept.t,
         rep.employer::text, rep.occupation::text, rep.city::text, rep.st::text, kept.n, kept.total, kept.last_date
  from kept join rep on rep.candidate_id = kept.candidate_id and rep.t = kept.t and rep.k = kept.k
  order by kept.total desc
$$;

-- Self-funding (his 'Self-funding' contributor type, by name) and loans
-- (receipt_type 'loan', by lender).
drop function if exists public.hub_candidate_loans(uuid);
create or replace function public.hub_candidate_loans(p_candidate_id uuid)
returns table (
  contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, total_amount numeric, contribution_count bigint, last_date date, source text
)
language sql stable
set search_path = pg_catalog, public
as $$
  with x as (
    select 'self'::text as source, contributor_name as name, 'INDIVIDUAL'::text as t,
           max(nullif(contributor_employer, '')) as employer, max(nullif(contributor_occupation, '')) as occupation,
           sum(amount) as total, count(*) as n, max(contribution_date) as last_date
    from public.candidate_contributions_attributed
    where candidate_id = p_candidate_id
      and (contributor_type = 'Self-funding' or contributor_kind = 'self')
    group by contributor_name
    union all
    select 'loan', contributor_name,
           case when position(',' in contributor_name) > 0 then 'INDIVIDUAL' else 'ENTITY' end,
           null, null, amount, n, null
    from public.candidate_other_receipts
    where candidate_id = p_candidate_id and receipt_type = 'loan'
  )
  select public.hub_last_name(name, t), public.hub_first_name(name, t), t,
         employer, occupation, total, n, last_date, source
  from x
  where name is not null
  order by total desc
$$;

-- ---------------------------------------------------------------------------
-- Outside spending
-- ---------------------------------------------------------------------------

-- Independent expenditures for / against each candidate of a race.
drop function if exists public.hub_race_ie_by_candidate(text, text, int);
create or replace function public.hub_race_ie_by_candidate(p_state text, p_office text, p_district int default null)
returns table (
  candidate_id uuid, slug text, name text, cycle text,
  total_supporting numeric, total_opposing numeric, supporting_count bigint, opposing_count bigint,
  committee_count bigint, as_of date
)
language sql stable
set search_path = pg_catalog, public
as $$
  select rp.candidate_id,
         coalesce(nullif(c.slug, ''), c.candidate_id::text),
         public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name),
         'all',
         coalesce(sum(ie.amount) filter (where ie.support_oppose = 'S'), 0),
         coalesce(sum(ie.amount) filter (where ie.support_oppose = 'O'), 0),
         count(*) filter (where ie.support_oppose = 'S'),
         count(*) filter (where ie.support_oppose = 'O'),
         count(distinct ie.spender_name),
         max(ie.expenditure_date)
  from public.race_participants rp
  join public.races r on r.race_id = rp.race_id
  join public.candidates c on c.candidate_id = rp.candidate_id
  left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
  cross join lateral (
    select * from public.candidate_ie_expenditures ie where ie.candidate_id = rp.candidate_id
  ) ie
  where r.state_id = upper(p_state) and r.office = p_office
    and (p_district is null or r.office_num = p_district)
  group by rp.candidate_id, c.candidate_id, o.display_name
$$;

-- Committees spending in a race. LPT keys committees by name.
drop function if exists public.hub_race_ie_committees(text, text, int);
create or replace function public.hub_race_ie_committees(p_state text, p_office text, p_district int default null)
returns table (
  filer_id text, name text, total_amount numeric, supporting numeric, opposing numeric, transaction_count bigint
)
language sql stable
set search_path = pg_catalog, public
as $$
  select ie.spender_name, ie.spender_name,
         sum(ie.amount),
         coalesce(sum(ie.amount) filter (where ie.support_oppose = 'S'), 0),
         coalesce(sum(ie.amount) filter (where ie.support_oppose = 'O'), 0),
         count(*)
  from public.race_participants rp
  join public.races r on r.race_id = rp.race_id
  cross join lateral (
    select * from public.candidate_ie_expenditures ie where ie.candidate_id = rp.candidate_id
  ) ie
  where r.state_id = upper(p_state) and r.office = p_office
    and (p_district is null or r.office_num = p_district)
    and ie.spender_name is not null
  group by ie.spender_name
  order by sum(ie.amount) desc
$$;

-- Donors to the committees spending in a race, per committee (the site
-- re-aggregates across committees). From his candidate_ie_contributors,
-- which keeps the top 100 by amount and by date per candidate and side.
drop function if exists public.hub_race_ie_donors(text, text, int, text);
create or replace function public.hub_race_ie_donors(p_state text, p_office text, p_district int default null, p_kind text default 'all')
returns table (
  ie_filer_ident text, committee_name text,
  contributor_last_name text, contributor_first_name text, contributor_type text,
  employer text, occupation text, city text, state text,
  contribution_count bigint, total_amount numeric, last_contribution_date date
)
language sql stable
set search_path = pg_catalog, public
as $$
  with rows_ as (
    select distinct ic.committee, ic.contributor_name, ic.amount, ic.contribution_date,
           case when position(',' in ic.contributor_name) > 0 then 'INDIVIDUAL' else 'ENTITY' end as t,
           public.hub_norm_name(ic.contributor_name) as k
    from public.race_participants rp
    join public.races r on r.race_id = rp.race_id
    cross join lateral (
      select * from public.candidate_ie_contributors ic where ic.candidate_id = rp.candidate_id
    ) ic
    where r.state_id = upper(p_state) and r.office = p_office
      and (p_district is null or r.office_num = p_district)
  ), g as (
    select committee, t, k,
           (array_agg(contributor_name order by contribution_date desc nulls last))[1] as name,
           count(*) as n, sum(amount) as total, max(contribution_date) as last_date
    from rows_
    where k is not null
      and (p_kind = 'all' or (p_kind = 'individual' and t = 'INDIVIDUAL') or (p_kind = 'pac' and t = 'ENTITY'))
    group by committee, t, k
  )
  select committee::text, committee::text,
         public.hub_last_name(name, t), public.hub_first_name(name, t), t,
         null::text, null::text, null::text, null::text, n, total, last_date
  from g
  order by total desc
$$;

-- ---------------------------------------------------------------------------
-- State-level committee donors (the /committees page)
-- ---------------------------------------------------------------------------

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
  with cands as (
    select distinct rp.candidate_id from public.race_participants rp where rp.state_id = upper(p_state)
  ), n as (
    select x.*
    from cands
    cross join lateral (
      select public.hub_norm_name(a.contributor_name) as k, a.contributor_name::text as name,
             nullif(a.contributor_city, '')::text as city, nullif(a.contributor_state, '')::text as cstate,
             a.candidate_id, a.amount, a.contribution_date
      from public.candidate_contributions_attributed a
      where a.candidate_id = cands.candidate_id
        and public.hub_contributor_type(a.contributor_kind, a.contributor_type) = 'ENTITY'
        and coalesce(a.contributor_kind, '') <> 'public'
        and coalesce(a.contributor_type, '') <> 'Public funds'
        and public.hub_is_named(a.contributor_name)
    ) x
  ), per_candidate as (
    select k, candidate_id, count(*)::int as n, coalesce(sum(amount), 0) as total, max(contribution_date) as last_date
    from n where k is not null group by k, candidate_id
  ), splits as (
    select k, jsonb_agg(jsonb_build_object(
             'candidate_id', candidate_id, 'contribution_count', n,
             'total_amount', total, 'last_contribution_date', last_date) order by total desc) as j
    from per_candidate group by k
  ), rolled as (
    select k,
           mode() within group (order by name) as name,
           mode() within group (order by city) as city,
           mode() within group (order by cstate) as cstate,
           count(*)::int as n, coalesce(sum(amount), 0) as total,
           count(distinct candidate_id)::int as candidates,
           min(contribution_date) as first_date, max(contribution_date) as last_date
    from n where k is not null group by k
  )
  select row_number() over (order by r.total desc, r.k),
         lower(p_state), r.k, r.name, r.city, r.cstate, r.n, r.total, r.candidates, r.first_date, r.last_date,
         sp.j
  from rolled r
  join splits sp on sp.k = r.k
  order by r.total desc, r.k
$$;

-- ---------------------------------------------------------------------------
-- Latest gifts ticker
-- ---------------------------------------------------------------------------

drop function if exists public.hub_latest_contributions(text, text, int, numeric, int);
create or replace function public.hub_latest_contributions(
  p_state text, p_office text, p_district int default null, p_min_amount numeric default 30000, p_limit int default 20)
returns table (
  id uuid, amount numeric, contribution_date date, contributor_type text,
  contributor_first_name text, contributor_last_name text, employer text, city text, state text,
  candidate_id uuid, candidate_name text, candidate_party text
)
language sql stable
set search_path = pg_catalog, public
as $$
  with cands as (
    select rp.candidate_id,
           public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name) as name,
           coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1)) as party
    from public.race_participants rp
    join public.races r on r.race_id = rp.race_id
    join public.candidates c on c.candidate_id = rp.candidate_id
    left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
    where r.state_id = upper(p_state) and r.office = p_office
      and (p_district is null or r.office_num = p_district)
      and public.hub_status(rp.on_ballot, rp.disposition, o.status)
          not in ('withdrawn', 'lost_primary', 'disqualified', 'not_on_ballot')
  ), a as (
    -- The newest N per candidate, merged: a short index range per candidate
    -- instead of one sort across the race.
    select x.*
    from cands
    cross join lateral (
      -- His (candidate_id, amount desc) index makes the floor cheap; the
      -- attribution rule is applied to the few rows above it.
      select a.contribution_id, a.amount, a.contribution_date, a.contributor_name,
             public.hub_contributor_type(a.contributor_kind, a.contributor_type) as t,
             a.contributor_employer, a.contributor_city, a.contributor_state, a.candidate_id
      from public.contributions a
      left join public.candidate_committee_attribution cca on cca.candidate_id = a.candidate_id
      where a.candidate_id = cands.candidate_id
        and a.amount >= p_min_amount and a.contribution_date is not null
        and (a.receipt_type is null or a.receipt_type in ('contribution', 'public_funds'))
        and (cca.committee_names_norm is null or public.hub_committee_norm(a.committee_name) = any (cca.committee_names_norm))
      order by a.contribution_date desc, a.amount desc
      limit least(greatest(coalesce(p_limit, 20), 1), 100)
    ) x
  )
  select a.contribution_id, a.amount, a.contribution_date, a.t,
         public.hub_first_name(a.contributor_name, a.t), public.hub_last_name(a.contributor_name, a.t),
         nullif(a.contributor_employer, '')::text, nullif(a.contributor_city, '')::text, nullif(a.contributor_state, '')::text,
         a.candidate_id, cands.name, cands.party
  from a join cands on cands.candidate_id = a.candidate_id
  order by a.contribution_date desc, a.amount desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

-- ---------------------------------------------------------------------------
-- Money river
-- ---------------------------------------------------------------------------

-- Every itemized contribution, expenditure, loan and outside expenditure of a
-- race, newest first, one page at a time; total_count repeats the unpaged
-- row count on every row. p_kind: 'all' | 'contribution' | 'expenditure' |
-- 'loan' | 'outside'.
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
language sql stable
set search_path = pg_catalog, public
as $$
  with cands as (
    select rp.candidate_id,
           coalesce(nullif(c.slug, ''), c.candidate_id::text) as slug,
           public.hub_display_name(c.candidate_name, c.candidate_first_name, c.candidate_last_name, o.display_name) as name,
           coalesce(nullif(btrim(rp.party), ''), (select p from unnest(c.party) p limit 1)) as party,
           lower(r.state_id) as state, r.office::text as office, nullif(r.office_num, 0)::text as district
    from public.race_participants rp
    join public.races r on r.race_id = rp.race_id
    join public.candidates c on c.candidate_id = rp.candidate_id
    left join public.hub_candidate_overrides o on o.candidate_id = c.candidate_id
    where r.state_id = upper(p_state) and r.office = p_office
      and (p_district is null or r.office_num = p_district)
      and (p_candidate is null or rp.candidate_id = p_candidate)
  ), rows_ as (
    -- Raw columns only: the sort runs over every row of the race, so the
    -- display expressions wait until the page has been cut.
    select 'contribution'::text as kind, a.contribution_id as id, a.contribution_date as txn_date, a.amount,
           a.candidate_id, a.contributor_name::text as who, a.contributor_kind::text as who_kind, a.contributor_type::text as who_type,
           a.contributor_employer::text as d1, a.contributor_city::text as d2, a.contributor_state::text as d3,
           null::text as support_oppose, a.election_year, a.created_at as imported_at
    from cands
    cross join lateral (
      -- Only the rows that can reach this page: his (candidate_id,
      -- contribution_date desc) index stops after offset + limit rows per
      -- candidate, with the attribution rule applied on the way.
      select a.*
      from public.contributions a
      left join public.candidate_committee_attribution cca on cca.candidate_id = a.candidate_id
      where a.candidate_id = cands.candidate_id
        and (a.receipt_type is null or a.receipt_type in ('contribution', 'public_funds'))
        and (cca.committee_names_norm is null or public.hub_committee_norm(a.committee_name) = any (cca.committee_names_norm))
      -- Date alone, so the index is walked in order and stops early; the
      -- page's full ordering is applied to the merged rows below.
      order by a.contribution_date desc nulls last
      limit least(greatest(coalesce(p_limit, 50), 1), 200) + greatest(coalesce(p_offset, 0), 0)
    ) a
    where p_kind in ('all', 'contribution')
    union all
    select 'expenditure', e.expenditure_id, e.expenditure_date, e.amount, e.candidate_id,
           e.payee_name::text, 'payee', null,
           e.purpose::text, e.category::text, e.payee_city::text,
           null, e.election_year, e.created_at
    from cands
    cross join lateral (
      select * from public.candidate_expenditures_attributed e where e.candidate_id = cands.candidate_id
    ) e
    where p_kind in ('all', 'expenditure')
    union all
    select 'loan', co.contribution_id, co.contribution_date, co.amount, co.candidate_id,
           co.contributor_name::text, co.contributor_kind::text, co.contributor_type::text,
           null, null, null,
           null, co.election_year, co.created_at
    from cands
    cross join lateral (
      select * from public.hub_cache_loans co where co.candidate_id = cands.candidate_id
    ) co
    where p_kind in ('all', 'loan')
    union all
    select 'outside', ie.expenditure_id, ie.expenditure_date, ie.amount, ie.candidate_id,
           ie.spender_name::text, 'committee', null,
           ie.purpose::text, ie.payee_name::text, null,
           ie.support_oppose::text, ie.election_year, ie.created_at
    from cands
    cross join lateral (
      select * from public.candidate_ie_expenditures ie
      where ie.candidate_id = cands.candidate_id and ie.support_oppose in ('S', 'O')
    ) ie
    where p_kind in ('all', 'outside')
  ), total as (
    -- From the nightly counts (002), not by materializing the union.
    select coalesce(sum(
             case when p_kind in ('all', 'contribution') then f.contribution_count else 0 end
           + case when p_kind in ('all', 'expenditure') then f.expenditure_count else 0 end
           + case when p_kind in ('all', 'outside') then f.ie_count else 0 end), 0)::bigint
         + (select count(*) from public.hub_cache_loans l join cands on cands.candidate_id = l.candidate_id
            where p_kind in ('all', 'loan'))::bigint as n
    from cands
    left join public.hub_cache_candidate_finance f on f.candidate_id = cands.candidate_id
  ), page as (
    select x.*
    from rows_ x
    order by x.txn_date desc nulls last, x.imported_at desc, x.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)
  )
  select x.kind, x.id, x.txn_date, x.amount, x.candidate_id, c.slug, c.name, c.party, c.state, c.office, c.district,
         case
           when x.kind in ('contribution', 'loan') and public.hub_contributor_type(x.who_kind, x.who_type) = 'INDIVIDUAL'
             then public.hub_flip_name(x.who)
           else x.who
         end,
         case
           when x.kind in ('contribution', 'loan') then public.hub_contributor_type(x.who_kind, x.who_type)
           when x.kind = 'outside' then 'COMMITTEE'
           else null
         end,
         nullif(concat_ws(' · ', nullif(x.d1, ''), nullif(x.d2, ''), nullif(x.d3, '')), ''),
         x.support_oppose, x.election_year::text, x.imported_at,
         (select n from total)
  from page x
  join cands c on c.candidate_id = x.candidate_id
  order by x.txn_date desc nulls last, x.imported_at desc, x.id
$$;

-- ---------------------------------------------------------------------------
-- Privileges (default ACLs already grant EXECUTE to anon; explicit anyway)
-- ---------------------------------------------------------------------------

grant execute on function
  public.hub_flip_name(text), public.hub_title_case(text), public.hub_display_name(text, text, text, text), public.hub_norm_name(text),
  public.hub_contributor_type(text, text), public.hub_last_name(text, text), public.hub_first_name(text, text),
  public.hub_status(boolean, text, text), public.hub_is_named(text), public.hub_committee_norm(text),
  public.hub_candidates(text, text, int, int), public.hub_race_totals(text, text, int),
  public.hub_candidate_finance(uuid), public.hub_candidate_top_donors(uuid, text, int),
  public.hub_race_top_donors(text, text, int, text, int), public.hub_candidate_loans(uuid),
  public.hub_race_ie_by_candidate(text, text, int), public.hub_race_ie_committees(text, text, int),
  public.hub_race_ie_donors(text, text, int, text), public.hub_state_committee_donors(text),
  public.hub_latest_contributions(text, text, int, numeric, int),
  public.hub_money_river(text, text, int, text, uuid, int, int)
to anon, authenticated, service_role;
