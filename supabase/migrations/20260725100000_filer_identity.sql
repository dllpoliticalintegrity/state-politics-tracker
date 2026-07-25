-- Filer identity layer + per-officeholder finance rollups.
--
-- The problem this solves: until now, candidate → committee mapping lived in a
-- hand-maintained dict in the importer and a mirrored `filer_refs` jsonb on
-- cf_candidates. That works for a few dozen curated statewide candidates and
-- cannot work for a legislature (148 members in Michigan alone), let alone
-- 25 states.
--
-- Instead: import each state's filer universe wholesale (cf_filers), match
-- officeholders to it by rule (cf_filer_links, recording *how* each match was
-- made), and roll the money up per officeholder (cf_official_finance). The
-- match method is stored on every link so coverage is measurable and a fuzzy
-- match can never be mistaken for a state-issued identifier.

-- ---------------------------------------------------------------------------
-- Filer registry — every committee a state discloses, imported as-is
-- ---------------------------------------------------------------------------
create table public.cf_filers (
  id uuid primary key default gen_random_uuid(),
  state text not null,                       -- lowercase 2-letter code
  filer_id text not null,                    -- the state's own committee id
  name text not null,                        -- committee legal name
  committee_type text,                       -- Candidate | Independent | …
  -- Candidate committees carry the filer's own account of who they're for.
  -- This is what makes rule-based matching possible instead of name guessing.
  candidate_first_name text,
  candidate_last_name text,
  candidate_party text,
  office_sought text,                        -- as the state words it
  district_sought text,                      -- as the state words it ("32nd District")
  district_number integer,                   -- parsed, for matching
  cycle text not null default '2026',
  source text not null default 'state-disclosure',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index cf_filers_state_filer_unique on public.cf_filers (state, filer_id, cycle);
create index idx_cf_filers_office on public.cf_filers (state, office_sought, district_number);

alter table public.cf_filers enable row level security;
create policy "cf_filers are publicly readable"
  on public.cf_filers for select using (true);

-- ---------------------------------------------------------------------------
-- Officeholder/candidate ↔ filer links, with provenance
-- ---------------------------------------------------------------------------
create table public.cf_filer_links (
  id uuid primary key default gen_random_uuid(),
  state text not null,
  filer_id text not null,
  -- Exactly one of these is set: a sitting officeholder (legislature page) or
  -- a curated statewide candidate (race dashboards).
  official_id uuid references public.cf_officials(id) on delete cascade,
  candidate_id uuid references public.cf_candidates(id) on delete cascade,
  -- How the link was made, strongest first. Anything below 'name_unique' is
  -- not written by the importer — it's reported for a human to confirm.
  --   state_id     the state's own filing lists the officeholder's id
  --   district_id  office + district + surname all agree
  --   name_unique  office + surname agree and the match is unambiguous
  --   manual       curated by hand
  match_method text not null,
  match_note text,                           -- e.g. "committee lists pre-2022 district"
  created_at timestamptz not null default now(),
  constraint cf_filer_links_one_subject check (
    (official_id is not null)::int + (candidate_id is not null)::int = 1
  ),
  constraint cf_filer_links_method check (
    match_method in ('state_id', 'district_id', 'name_unique', 'manual')
  )
);

create unique index cf_filer_links_unique
  on public.cf_filer_links (state, filer_id, coalesce(official_id, candidate_id));
create index idx_cf_filer_links_official on public.cf_filer_links (official_id);

alter table public.cf_filer_links enable row level security;
create policy "cf_filer_links are publicly readable"
  on public.cf_filer_links for select using (true);

-- ---------------------------------------------------------------------------
-- Per-officeholder finance rollup
-- ---------------------------------------------------------------------------
-- Written by the state importer, which is the only thing that reads every
-- transaction. A legislature is hundreds of members per state; aggregating
-- their transactions live would not survive 25 states, and the roster page
-- only ever shows totals.
--
-- Every row is self-describing: which committees it covers, how they were
-- matched, the date window that defines the cycle, and when it was computed —
-- so a number on the page can always be traced back without the raw rows.
create table public.cf_official_finance (
  id uuid primary key default gen_random_uuid(),
  official_id uuid not null references public.cf_officials(id) on delete cascade,
  state text not null,
  cycle text not null default '2026',
  cycle_start date not null,
  cycle_end date not null,
  raised numeric(14,2) not null default 0,
  spent numeric(14,2) not null default 0,
  contribution_count integer not null default 0,
  expenditure_count integer not null default 0,
  -- [{filer_id, name, match_method}, …] — the committees behind the totals.
  committees jsonb not null default '[]'::jsonb,
  -- Weakest match backing this row, so the UI can flag a total that rests on
  -- something less certain than a district-level match.
  weakest_match text,
  source text not null default 'state-disclosure',
  as_of timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index cf_official_finance_unique
  on public.cf_official_finance (official_id, cycle);
create index idx_cf_official_finance_state on public.cf_official_finance (state, cycle);

alter table public.cf_official_finance enable row level security;
create policy "cf_official_finance is publicly readable"
  on public.cf_official_finance for select using (true);

-- Per-state coverage, so "how much of this legislature do we actually have?"
-- is a query rather than a claim. Rendered on the legislature page.
create view public.cf_legislature_coverage as
select
  o.state,
  o.chamber,
  f.cycle,
  count(*)::int as seats,
  count(f.id)::int as with_finance,
  count(*) filter (where f.weakest_match = 'district_id')::int as strong_matches,
  coalesce(sum(f.raised), 0)::numeric as total_raised,
  max(f.as_of) as as_of
from public.cf_officials o
left join public.cf_official_finance f on f.official_id = o.id
where o.chamber is not null
group by o.state, o.chamber, f.cycle;

grant select on public.cf_legislature_coverage to anon, authenticated, service_role;
