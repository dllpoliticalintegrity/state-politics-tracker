-- Legislative (districted) races — applied to the shared TX-tracker project
-- on 2026-09-22 via the Supabase MCP (apply_migration "cf_candidates_district").
--
-- A candidate for a chamber seat (Michigan State Senate / State House to
-- start) carries the district number; statewide candidates keep null. The
-- statewide dashboards filter on (state, office) and are unaffected; the
-- district dashboards add `district`. See docs/plan.md, "Legislative races".
alter table public.cf_candidates add column if not exists district text;

create index if not exists idx_cf_candidates_state_office_district
  on public.cf_candidates (state, office, district);

comment on column public.cf_candidates.district is
  'District number for legislative races (e.g. "11"); null for statewide offices.';
