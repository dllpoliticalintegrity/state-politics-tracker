-- state_sites: one row per dedicated state site (michiganpoliticstracker.com
-- and friends), edited from the data-diamine admin's Site tab through the
-- spt-tracker-admin edge function (service role). The site reads its chrome
-- from here with the anon key, and the Worker maps a hostname to a state.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

create table if not exists public.state_sites (
  state         text primary key check (state ~ '^[a-z]{2}$'),
  hostname      text not null unique
                check (hostname = lower(hostname) and hostname !~ '^https?://' and hostname !~ '/'),
  worker_name   text not null unique check (worker_name ~ '^[a-z0-9-]{3,63}$'),
  display_name  text not null,
  tagline       text,
  logo_url      text,
  accent_color  text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  about_text    text,
  credits_text  text,
  hidden_races  text[] not null default '{}',
  published     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.state_sites is
  'Per-state dedicated site settings (chrome, hostname, Worker). Public read; written only by the admin edge function.';

alter table public.state_sites enable row level security;

drop policy if exists "state_sites public read" on public.state_sites;
create policy "state_sites public read" on public.state_sites
  for select using (true);
-- No insert/update/delete policies on purpose: the service role bypasses RLS.
