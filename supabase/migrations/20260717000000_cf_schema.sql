-- Multi-state (cf_*) schema, applied to the shared "TX Politics Tracker"
-- Supabase project (decision: reuse that project rather than pay for a new
-- one — see docs/plan.md). Strictly additive: nothing here touches tx_*.
--
-- Shapes mirror the tx_* tables so the frontend hooks port with a table
-- rename + state/office filters. Differences:
--   * cf_candidates carries state ('fl') + office ('governor') and a jsonb
--     filer_refs instead of TEC-specific filer_ident columns — each state's
--     importer stores its own committee/filer identifiers there.
--   * transaction tables carry a source_txn_id for idempotent upserts from
--     the SLCF importer; race scoping flows through candidate_id.
--   * cf_ie_committees.filer_ident is namespaced by state at import time
--     ("fl:12345") so identifiers can't collide across states.

-- ---------------------------------------------------------------------------
-- Candidates (editorial layer)
-- ---------------------------------------------------------------------------
create table public.cf_candidates (
  id uuid primary key default gen_random_uuid(),
  state text not null,                       -- lowercase 2-letter race state
  office text not null default 'governor',   -- registry race office slug
  slug text unique not null,
  name text not null,
  party text,
  filer_refs jsonb not null default '[]'::jsonb,
  committee_name text,
  election_year integer not null default 2026,
  status text default 'active',              -- active | withdrawn | lost_primary
  title text,
  bio text,
  photo_url text,
  photo_url_large text,
  photo_url_medium text,
  photo_url_thumb text,
  website text,
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_cf_candidates_state_office on public.cf_candidates (state, office);

alter table public.cf_candidates enable row level security;
create policy "cf_candidates are publicly readable"
  on public.cf_candidates for select using (true);

-- ---------------------------------------------------------------------------
-- Contributions / expenditures / loans
-- ---------------------------------------------------------------------------
create table public.cf_contributions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_id text,                         -- state filer/committee identifier
  source_txn_id text,                        -- importer-stable id for upserts
  contributor_type text,                     -- INDIVIDUAL | ENTITY
  contributor_last_name text,                -- organization name for ENTITY
  contributor_first_name text,
  employer text,
  occupation text,
  amount numeric(14,2) not null,
  contribution_date date,
  city text,
  state text,                                -- contributor's state (as in tx_*)
  zip text,
  cycle text default '2026',
  source_form_type text,
  source text not null default 'slcf',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index cf_contributions_txn_unique
  on public.cf_contributions (source, source_txn_id)
  where source_txn_id is not null;
create index idx_cf_contributions_candidate on public.cf_contributions (candidate_id);
create index idx_cf_contributions_candidate_amount
  on public.cf_contributions (candidate_id, amount desc);
create index idx_cf_contributions_date on public.cf_contributions (contribution_date desc);

alter table public.cf_contributions enable row level security;
create policy "cf_contributions are publicly readable"
  on public.cf_contributions for select using (true);

create table public.cf_expenditures (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_id text,
  source_txn_id text,
  payee_type text,
  payee_last_name text,
  payee_first_name text,
  payee_city text,
  payee_state text,
  payee_zip text,
  amount numeric(14,2) not null,
  expenditure_date date,
  category text,
  description text,
  cycle text default '2026',
  source text not null default 'slcf',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index cf_expenditures_txn_unique
  on public.cf_expenditures (source, source_txn_id)
  where source_txn_id is not null;
create index idx_cf_expenditures_candidate on public.cf_expenditures (candidate_id);

alter table public.cf_expenditures enable row level security;
create policy "cf_expenditures are publicly readable"
  on public.cf_expenditures for select using (true);

create table public.cf_loans (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  committee_id text,
  source_txn_id text,
  lender_type text,
  lender_last_name text,
  lender_first_name text,
  amount numeric(14,2) not null,
  loan_date date,
  is_guarantor boolean not null default false,
  cycle text default '2026',
  source text not null default 'slcf',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index cf_loans_txn_unique
  on public.cf_loans (source, source_txn_id)
  where source_txn_id is not null;
create index idx_cf_loans_candidate on public.cf_loans (candidate_id);

alter table public.cf_loans enable row level security;
create policy "cf_loans are publicly readable"
  on public.cf_loans for select using (true);

-- ---------------------------------------------------------------------------
-- Independent expenditures
-- ---------------------------------------------------------------------------
create table public.cf_ie_committees (
  filer_ident text primary key,              -- namespaced: "fl:12345"
  state text not null,
  name text not null,
  committee_type text,
  created_at timestamptz not null default now()
);

alter table public.cf_ie_committees enable row level security;
create policy "cf_ie_committees are publicly readable"
  on public.cf_ie_committees for select using (true);

create table public.cf_independent_expenditures (
  id uuid primary key default gen_random_uuid(),
  ie_filer_ident text references public.cf_ie_committees(filer_ident),
  target_candidate_id uuid references public.cf_candidates(id) on delete cascade,
  source_txn_id text,
  support_oppose text,                       -- S | O
  amount numeric(14,2) not null,
  expenditure_date date,
  description text,
  cycle text default '2026',
  source text not null default 'slcf',
  created_at timestamptz not null default now()
);

create unique index cf_ie_txn_unique
  on public.cf_independent_expenditures (source, source_txn_id)
  where source_txn_id is not null;
create index idx_cf_ie_target on public.cf_independent_expenditures (target_candidate_id);

alter table public.cf_independent_expenditures enable row level security;
create policy "cf_independent_expenditures are publicly readable"
  on public.cf_independent_expenditures for select using (true);

create table public.cf_ie_contributions (
  id uuid primary key default gen_random_uuid(),
  ie_filer_ident text references public.cf_ie_committees(filer_ident),
  source_txn_id text,
  contributor_type text,
  contributor_last_name text,
  contributor_first_name text,
  employer text,
  occupation text,
  amount numeric(14,2) not null,
  contribution_date date,
  city text,
  state text,
  cycle text default '2026',
  source text not null default 'slcf',
  created_at timestamptz not null default now()
);

create unique index cf_ie_contribs_txn_unique
  on public.cf_ie_contributions (source, source_txn_id)
  where source_txn_id is not null;
create index idx_cf_ie_contribs_committee on public.cf_ie_contributions (ie_filer_ident);

alter table public.cf_ie_contributions enable row level security;
create policy "cf_ie_contributions are publicly readable"
  on public.cf_ie_contributions for select using (true);

-- ---------------------------------------------------------------------------
-- Derived views (mirror the tx_* derived views)
-- ---------------------------------------------------------------------------
create view public.cf_contributions_deduped as
select
  c.id,
  c.candidate_id,
  c.committee_id,
  c.contributor_type,
  c.contributor_last_name,
  c.contributor_first_name,
  c.employer,
  c.occupation,
  c.amount,
  c.contribution_date,
  c.city,
  c.state,
  c.zip,
  c.cycle,
  c.source_form_type
from public.cf_contributions c
union all
select
  l.id,
  l.candidate_id,
  l.committee_id,
  l.lender_type       as contributor_type,
  l.lender_last_name  as contributor_last_name,
  l.lender_first_name as contributor_first_name,
  null                as employer,
  null                as occupation,
  l.amount,
  l.loan_date         as contribution_date,
  null                as city,
  null                as state,
  null                as zip,
  l.cycle,
  'B-LOAN'            as source_form_type
from public.cf_loans l
where not l.is_guarantor;

grant select on public.cf_contributions_deduped to anon, authenticated, service_role;

create view public.cf_top_donors as
with normalized as (
  select
    candidate_id,
    contributor_type,
    nullif(
      regexp_replace(
        regexp_replace(upper(btrim(contributor_last_name)), '[^A-Z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'
      ), ''
    ) as norm_last,
    nullif(
      regexp_replace(
        regexp_replace(upper(btrim(contributor_first_name)), '[^A-Z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'
      ), ''
    ) as norm_first,
    contributor_last_name,
    contributor_first_name,
    employer,
    occupation,
    city,
    state,
    amount,
    contribution_date
  from public.cf_contributions_deduped
  where candidate_id is not null
)
select
  candidate_id,
  (array_agg(contributor_last_name  order by contribution_date desc nulls last))[1] as contributor_last_name,
  (array_agg(contributor_first_name order by contribution_date desc nulls last))[1] as contributor_first_name,
  (array_agg(contributor_type       order by contribution_date desc nulls last))[1] as contributor_type,
  (array_agg(employer               order by contribution_date desc nulls last))[1] as employer,
  (array_agg(occupation             order by contribution_date desc nulls last))[1] as occupation,
  (array_agg(city                   order by contribution_date desc nulls last))[1] as city,
  (array_agg(state                  order by contribution_date desc nulls last))[1] as state,
  count(*)::bigint                  as contribution_count,
  coalesce(sum(amount), 0)::numeric as total_amount,
  max(contribution_date)            as last_contribution_date
from normalized
group by
  candidate_id,
  norm_last,
  coalesce(norm_first, '');

grant select on public.cf_top_donors to anon, authenticated, service_role;

create materialized view public.cf_contributions_summary as
select
  c.id as candidate_id,
  c.slug,
  c.name,
  c.state as race_state,
  c.office,
  coalesce(x.cycle, 'unknown') as cycle,
  count(*) filter (where x.contributor_type = 'INDIVIDUAL') as individual_donor_count,
  sum(x.amount) filter (where x.contributor_type = 'INDIVIDUAL') as individual_contributions,
  sum(x.amount) filter (where x.contributor_type = 'ENTITY') as entity_contributions,
  sum(x.amount) filter (where x.contributor_type = 'INDIVIDUAL' and x.amount < 200) as small_dollar_contributions,
  count(*) filter (where x.contributor_type = 'INDIVIDUAL' and x.amount < 200) as small_dollar_count,
  sum(x.amount) as total_raised,
  max(x.contribution_date) as as_of
from public.cf_candidates c
left join public.cf_contributions x on x.candidate_id = c.id
group by c.id, c.slug, c.name, c.state, c.office, x.cycle;

create unique index cf_contributions_summary_pk
  on public.cf_contributions_summary (candidate_id, cycle);
create index cf_contributions_summary_slug_idx
  on public.cf_contributions_summary (slug);

create materialized view public.cf_ie_by_candidate as
select
  c.id as candidate_id,
  c.slug,
  c.name,
  coalesce(ie.cycle, 'unknown') as cycle,
  sum(ie.amount) filter (where upper(ie.support_oppose) = 'S') as total_supporting,
  sum(ie.amount) filter (where upper(ie.support_oppose) = 'O') as total_opposing,
  count(*) filter (where upper(ie.support_oppose) = 'S') as supporting_count,
  count(*) filter (where upper(ie.support_oppose) = 'O') as opposing_count,
  count(distinct ie.ie_filer_ident) as committee_count,
  max(ie.expenditure_date) as as_of
from public.cf_candidates c
left join public.cf_independent_expenditures ie on ie.target_candidate_id = c.id
group by c.id, c.slug, c.name, ie.cycle;

create unique index cf_ie_by_candidate_pk
  on public.cf_ie_by_candidate (candidate_id, cycle);

create materialized view public.cf_top_ie_donors as
with normalized as (
  select
    ie_filer_ident,
    contributor_type,
    nullif(
      regexp_replace(
        regexp_replace(upper(btrim(contributor_last_name)), '[^A-Z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'
      ), ''
    ) as norm_last,
    nullif(
      regexp_replace(
        regexp_replace(upper(btrim(contributor_first_name)), '[^A-Z0-9 ]', '', 'g'),
        '\s+', ' ', 'g'
      ), ''
    ) as norm_first,
    contributor_last_name,
    contributor_first_name,
    employer,
    occupation,
    city,
    state,
    amount,
    contribution_date
  from public.cf_ie_contributions
)
select
  ie_filer_ident,
  coalesce(norm_last, '')  as norm_last_key,
  coalesce(norm_first, '') as norm_first_key,
  (array_agg(contributor_last_name  order by contribution_date desc nulls last))[1] as contributor_last_name,
  (array_agg(contributor_first_name order by contribution_date desc nulls last))[1] as contributor_first_name,
  (array_agg(contributor_type       order by contribution_date desc nulls last))[1] as contributor_type,
  (array_agg(employer               order by contribution_date desc nulls last))[1] as employer,
  (array_agg(occupation             order by contribution_date desc nulls last))[1] as occupation,
  (array_agg(city                   order by contribution_date desc nulls last))[1] as city,
  (array_agg(state                  order by contribution_date desc nulls last))[1] as state,
  count(*)::bigint                  as contribution_count,
  coalesce(sum(amount), 0)::numeric as total_amount,
  max(contribution_date)            as last_contribution_date
from normalized
group by
  ie_filer_ident,
  coalesce(norm_last,  ''),
  coalesce(norm_first, '');

create unique index cf_top_ie_donors_pk
  on public.cf_top_ie_donors (ie_filer_ident, norm_last_key, norm_first_key);
create index cf_top_ie_donors_total_amount_idx
  on public.cf_top_ie_donors (total_amount desc);

grant select on public.cf_contributions_summary to anon, authenticated;
grant select on public.cf_ie_by_candidate to anon, authenticated;
grant select on public.cf_top_ie_donors to anon, authenticated, service_role;

create or replace function public.refresh_cf_finance_views()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  refresh materialized view concurrently public.cf_contributions_summary;
  refresh materialized view concurrently public.cf_ie_by_candidate;
  refresh materialized view concurrently public.cf_top_ie_donors;
end;
$$;

grant execute on function public.refresh_cf_finance_views() to service_role;

-- ---------------------------------------------------------------------------
-- Polling: the shared races/race_polls/race_polling tables are already
-- state-generic (keyed by slug). Register the pilot races.
-- featured=false so nothing changes for the TX site's queries.
-- ---------------------------------------------------------------------------
insert into races (state, district, slug, year, featured)
values
  ('Florida',  'Governor', 'florida-governor-2026',  2026, false),
  ('Michigan', 'Governor', 'michigan-governor-2026', 2026, false),
  ('Georgia',  'Governor', 'georgia-governor-2026',  2026, false)
on conflict do nothing;
