-- 003: tables for the states the hub loads itself (Michigan, Texas,
-- California), in the Local Politics Tracker project — see
-- docs/lpt-frontend-plan.md. Henry's push owns the shared tables; ours are
-- prefixed per state (mi_*, tx_*, ca_*) and mirror the columns the hub_*
-- functions read from his, so one routed function serves both.
--
-- Apply by hand after 002 with execute_sql. Re-runnable.
--
-- Written by pipelines/lpt/publish_state.py (service role), nightly, from
-- the tracker's settled cf_* rows: idempotent by the tracker's ids.

-- Which states read prefixed tables. No row = Henry's shared tables.
create table if not exists public.hub_state_source (
  state_id text primary key,
  prefix   text not null,
  note     text,
  created_at timestamptz not null default now()
);

-- The FiftyPlusOne general-election average per race, as the tracker's
-- race_polling row carries it (the per-poll rows go in <st>_race_polls).
create table if not exists public.hub_poll_averages (
  state_id   text not null,
  race_slug  text not null,
  source     text not null,
  source_url text,
  as_of      date,
  spread     text,
  last_updated timestamptz,
  averages   jsonb not null,   -- [{label, party, pct, candidate_id}]
  primary key (state_id, race_slug)
);

create or replace function public.hub_create_state_tables(p text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare t text;
begin
  execute format($q$
    create table if not exists public.%1$I (
      candidate_id uuid primary key,
      candidate_name text not null,
      candidate_first_name text,
      candidate_last_name text,
      state_id text not null,
      office text,
      party text[],
      committee_name text[],
      status text,
      title text,
      bio text,
      photo_url text, photo_url_large text, photo_url_medium text, photo_url_thumb text,
      website text,
      featured boolean,
      state_filer_id text,
      slug text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    )$q$, p || '_candidates');
  execute format('create index if not exists %I on public.%I (state_id, office)', p || '_candidates_office_idx', p || '_candidates');

  execute format($q$
    create table if not exists public.%1$I (
      race_id uuid primary key,
      state_id text not null,
      office text not null,
      office_num int not null default 0,
      year int not null,
      slug text not null,
      unique (state_id, slug)
    )$q$, p || '_races');

  execute format($q$
    create table if not exists public.%1$I (
      race_id uuid not null,
      state_id text not null,
      candidate_id uuid not null,
      candidate_name text,
      on_ballot boolean,
      disposition text,
      is_incumbent boolean,
      party text,
      primary key (race_id, candidate_id)
    )$q$, p || '_race_participants');
  execute format('create index if not exists %I on public.%I (candidate_id)', p || '_race_participants_cand_idx', p || '_race_participants');

  execute format($q$
    create table if not exists public.%1$I (
      contribution_id uuid primary key,
      state_id text not null,
      committee_id text,
      committee_name text,
      candidate_id uuid not null,
      candidate_name text,
      contributor_name text,
      amount numeric(20,2),
      contribution_date date,
      contribution_type text,
      contributor_type text,
      contributor_city text,
      contributor_state text,
      contributor_zip text,
      contributor_employer text,
      contributor_occupation text,
      election_year int,
      cycle text,
      source_txn_id text,
      created_at timestamptz,
      updated_at timestamptz,
      receipt_type text,
      contributor_kind text
    )$q$, p || '_contributions');
  execute format('create index if not exists %I on public.%I (candidate_id)', p || '_contributions_cand_idx', p || '_contributions');
  execute format('create index if not exists %I on public.%I (candidate_id, contribution_date desc nulls last)', p || '_contributions_cand_date_idx', p || '_contributions');
  execute format('create index if not exists %I on public.%I (candidate_id, amount desc)', p || '_contributions_cand_amount_idx', p || '_contributions');

  execute format($q$
    create table if not exists public.%1$I (
      expenditure_id uuid primary key,
      state_id text not null,
      committee_id text,
      candidate_id uuid not null,
      spender_name text,
      amount numeric(20,2),
      expenditure_date date,
      expenditure_type text,
      payee_name text,
      purpose text,
      category text,
      payee_city text,
      payee_state text,
      payee_zip text,
      election_year int,
      cycle text,
      support_oppose text,
      source_txn_id text,
      created_at timestamptz,
      updated_at timestamptz,
      disbursement_type text,
      counts_as_spent boolean default true
    )$q$, p || '_expenditures');
  execute format('create index if not exists %I on public.%I (candidate_id, support_oppose)', p || '_expenditures_cand_idx', p || '_expenditures');

  -- Donors to the committees that make independent expenditures.
  execute format($q$
    create table if not exists public.%1$I (
      id uuid primary key,
      state_id text not null,
      committee_id text not null,
      committee_name text,
      contributor_name text,
      contributor_type text,
      contributor_kind text,
      contributor_employer text,
      contributor_occupation text,
      contributor_city text,
      contributor_state text,
      amount numeric(20,2),
      contribution_date date,
      cycle text,
      source_txn_id text
    )$q$, p || '_ie_contributions');
  execute format('create index if not exists %I on public.%I (committee_id)', p || '_ie_contributions_cmte_idx', p || '_ie_contributions');

  execute format($q$
    create table if not exists public.%1$I (
      poll_id uuid primary key,
      race_id uuid not null,
      source text not null,
      poll_date date,
      sample_size int,
      sample_type text,
      margin_of_error numeric(4,1),
      matchup text,
      source_url text,
      created_at timestamptz default now()
    )$q$, p || '_race_polls');
  execute format('create index if not exists %I on public.%I (race_id)', p || '_race_polls_race_idx', p || '_race_polls');

  execute format($q$
    create table if not exists public.%1$I (
      poll_id uuid not null,
      candidate_id uuid,
      label text not null,
      party text,
      pct numeric(5,2),
      primary key (poll_id, label)
    )$q$, p || '_race_poll_results');

  foreach t in array array['candidates', 'races', 'race_participants', 'contributions', 'expenditures', 'ie_contributions', 'race_polls', 'race_poll_results'] loop
    execute format('alter table public.%I enable row level security', p || '_' || t);
    execute format('drop policy if exists %I on public.%I', p || '_' || t || '_public_read', p || '_' || t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', p || '_' || t || '_public_read', p || '_' || t);
    execute format('revoke all on public.%I from anon, authenticated', p || '_' || t);
    execute format('grant select on public.%I to anon, authenticated', p || '_' || t);
    execute format('grant all on public.%I to service_role', p || '_' || t);
  end loop;
end
$$;
revoke all on function public.hub_create_state_tables(text) from public, anon, authenticated;

alter table public.hub_state_source enable row level security;
drop policy if exists hub_state_source_public_read on public.hub_state_source;
create policy hub_state_source_public_read on public.hub_state_source for select to anon, authenticated using (true);
revoke all on public.hub_state_source from anon, authenticated;
grant select on public.hub_state_source to anon, authenticated;
grant all on public.hub_state_source to service_role;

alter table public.hub_poll_averages enable row level security;
drop policy if exists hub_poll_averages_public_read on public.hub_poll_averages;
create policy hub_poll_averages_public_read on public.hub_poll_averages for select to anon, authenticated using (true);
revoke all on public.hub_poll_averages from anon, authenticated;
grant select on public.hub_poll_averages to anon, authenticated;
grant all on public.hub_poll_averages to service_role;

select public.hub_create_state_tables(p) from unnest(array['mi', 'tx', 'ca']) p;

insert into public.hub_state_source (state_id, prefix, note) values
  ('MI', 'mi', 'Michigan: the hub''s own importer (scripts/data-import/pilot), bridged from the tracker nightly'),
  ('TX', 'tx', 'Texas: the TEC bulk importer (scripts/data-import/tec), bridged from the tracker nightly'),
  ('CA', 'ca', 'California: the CAL-ACCESS importer (scripts/data-import/cal-access), bridged from the tracker nightly')
on conflict (state_id) do update set prefix = excluded.prefix, note = excluded.note;
