-- Open States officeholder layer (cf_officials).
--
-- Source: https://github.com/openstates/people — curated, CC0 (public domain)
-- YAML records for every sitting state legislator, governor, and other
-- statewide executive, plus the derived per-state legislator CSVs published at
-- https://data.openstates.org/people/current/{state}.csv.
--
-- This is *officeholder* data, not candidate data: it answers "who holds this
-- office today" beside the cf_candidates editorial layer that answers "who is
-- running for it in 2026". The two are joined by name at read time (the
-- incumbent card links through to a candidate page when the officeholder is
-- also running), deliberately without a foreign key — Open States is synced
-- wholesale and must never be able to break curated candidate rows.
--
-- Strictly additive beside cf_* and tx_* (shared Supabase project — see
-- docs/plan.md).

create table public.cf_officials (
  id uuid primary key default gen_random_uuid(),
  -- Open States person id, e.g. "ocd-person/9b425a88-…". Stable across syncs.
  os_person_id text not null,
  state text not null,                       -- lowercase 2-letter code
  -- Raw Open States role type: "governor", "lt_governor", "attorney general",
  -- "secretary of state", "chief election officer", "treasurer", "auditor",
  -- or "upper"/"lower" for legislators.
  role_type text not null,
  -- Registry race-office slug when the role maps to one ("governor",
  -- "attorney-general", …); null for roles the site doesn't track as a race
  -- (legislators, treasurers, auditors).
  office text,
  chamber text,                              -- upper | lower, legislators only
  district text,
  name text not null,
  given_name text,
  family_name text,
  party text,                                -- "Democratic", "Republican", …
  image_url text,
  email text,
  phone text,
  capitol_address text,
  links jsonb not null default '[]'::jsonb,   -- [{url, note?}, …]
  sources jsonb not null default '[]'::jsonb,
  term_start date,
  term_end date,
  source text not null default 'openstates',
  -- Bumped on every sync touch; the importer prunes rows it didn't touch so
  -- people who leave office disappear instead of lingering.
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person per concurrent role (Burt Jones is Lt. Gov *and* a former
-- senator; only current roles are imported, but a person can legitimately hold
-- two at once — e.g. a Lt. Gov who also presides over the senate).
create unique index cf_officials_person_role_unique
  on public.cf_officials (os_person_id, role_type);
create index idx_cf_officials_state_office on public.cf_officials (state, office);
create index idx_cf_officials_state_chamber on public.cf_officials (state, chamber);

alter table public.cf_officials enable row level security;
create policy "cf_officials are publicly readable"
  on public.cf_officials for select using (true);

-- Seat counts per chamber, for the legislature page's party-split bars. Kept
-- as a view (not a matview) — a few hundred rows per state, refreshed weekly.
create view public.cf_legislature_party_summary as
select
  state,
  chamber,
  coalesce(nullif(btrim(party), ''), 'Unknown') as party,
  count(*)::int as seats
from public.cf_officials
where chamber is not null
group by state, chamber, coalesce(nullif(btrim(party), ''), 'Unknown');

grant select on public.cf_legislature_party_summary to anon, authenticated, service_role;
