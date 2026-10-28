-- Apply to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP:
-- the DDL below with execute_sql, then rebuild_cf_top_donors() from a
-- one-off pg_cron job (the rebuild takes minutes, longer than the MCP's
-- statement window). Status 2026-10-28: cf_donor_key() is created; the
-- view, rebuild_cf_top_donors() and the one-off job are still to run.
--
-- cf_top_donors grouped a candidate's contributions on (normalised last
-- name, normalised first name), so the same person ranked twice whenever an
-- importer wrote the name two ways. The importers do not agree: the SLCF
-- loader stores a lender's whole name in lender_last_name ("MICHAEL COX",
-- first null — pipelines/load/mapping.py, the loans_debts branch, for every
-- SLCF state) while the same person's gifts are split ("COX" / "MICHAEL");
-- Georgia's lenders file as "Jones, William Burton", Wisconsin's as
-- "STEELE KEVIN M"; Texas and California publish their own shapes. On the
-- Michigan governor's Top Donors page Mike Cox appeared as "MICHAEL COX"
-- ($3.0M, loans) and "COX, MICHAEL" ($1.04M, gifts), Laura Cox likewise.
-- Live on 2026-10-28: ~1,700 whole-name individual lenders ($57M) across
-- AZ, CO, FL, GA, ID, MI and WI, so the fix belongs in the view, not in one
-- state's importer.
--
-- cf_donor_key(): the name parts joined, normalised as before (upper case,
-- letters/digits/spaces only) and, for a person, sorted word by word, so
-- that word order — and which field each word sat in — stops mattering:
-- "MICHAEL COX", "COX, MICHAEL" and ("COX", "MICHAEL") all key as
-- "COX MICHAEL". Organisations keep their word order. Middle names and
-- initials still tell donors apart, as before. The site mirrors the rule in
-- src/lib/donorNames.ts (donorKey; pinned by donorNames.test.ts) for its
-- cross-candidate rankings, loan lists and the self-funding filter; keep
-- the two in step.
--
-- The view also now shows a merged donor by the split form of the name when
-- it has one (the first/last pair, with the latest non-null employer,
-- occupation, city and state) instead of whatever the latest row carried.
-- Columns are unchanged, with donor_key appended; the matview is rebuilt
-- (its column list is fixed at creation) under a temporary name and swapped
-- in, so readers block only for the swap.

create or replace function public.cf_donor_key(
  contributor_type text,
  last_name text,
  first_name text
)
returns text
language sql
immutable
parallel safe
as $$
  with joined as (
    select nullif(
      btrim(regexp_replace(
        regexp_replace(upper(concat_ws(' ', last_name, first_name)), '[^A-Z0-9 ]', '', 'g'),
        '\s+', ' ', 'g')),
      '') as name
  )
  select case
    when name is null then null
    when upper(contributor_type) = 'ENTITY' then name
    else (select string_agg(t, ' ' order by t collate "C")
          from unnest(string_to_array(name, ' ')) as t)
  end
  from joined
$$;

comment on function public.cf_donor_key(text, text, text) is
  'Grouping key for a contribution''s donor: name parts joined and normalised, word-sorted for a person. Mirrored by src/lib/donorNames.ts donorKey().';

create or replace view public.cf_top_donors_live as
with normalized as (
  select
    candidate_id,
    contributor_type,
    public.cf_donor_key(contributor_type, contributor_last_name, contributor_first_name) as donor_key,
    contributor_last_name,
    contributor_first_name,
    (nullif(btrim(contributor_first_name), '') is null) as whole_name,
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
  (array_agg(contributor_last_name  order by whole_name, contribution_date desc nulls last))[1] as contributor_last_name,
  (array_agg(contributor_first_name order by whole_name, contribution_date desc nulls last))[1] as contributor_first_name,
  (array_agg(contributor_type       order by contribution_date desc nulls last))[1] as contributor_type,
  (array_agg(employer               order by (employer is null), contribution_date desc nulls last))[1] as employer,
  (array_agg(occupation             order by (occupation is null), contribution_date desc nulls last))[1] as occupation,
  (array_agg(city                   order by (city is null), contribution_date desc nulls last))[1] as city,
  (array_agg(state                  order by (state is null), contribution_date desc nulls last))[1] as state,
  count(*)::bigint                  as contribution_count,
  coalesce(sum(amount), 0)::numeric as total_amount,
  max(contribution_date)            as last_contribution_date,
  donor_key
from normalized
group by candidate_id, donor_key;

grant select on public.cf_top_donors_live to anon, authenticated, service_role;

-- Rebuild the matview with the new definition (and the donor_key column)
-- beside the live one, then swap. One transaction: the old matview is
-- locked only from its drop to the commit a moment later.
create or replace function public.rebuild_cf_top_donors()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '30min'
as $$
begin
  drop materialized view if exists public.cf_top_donors_new;
  create materialized view public.cf_top_donors_new as
  select
    row_number() over (order by candidate_id, total_amount desc, contributor_last_name, contributor_first_name) as rn,
    *
  from public.cf_top_donors_live;
  create unique index cf_top_donors_new_pk on public.cf_top_donors_new (rn);
  create index cf_top_donors_new_candidate_amount_idx
    on public.cf_top_donors_new (candidate_id, total_amount desc);
  create index cf_top_donors_new_candidate_type_idx
    on public.cf_top_donors_new (candidate_id, contributor_type);
  create index cf_top_donors_new_candidate_type_amount_idx
    on public.cf_top_donors_new (candidate_id, contributor_type, total_amount desc);
  grant select on public.cf_top_donors_new to anon, authenticated, service_role;

  drop materialized view if exists public.cf_top_donors;
  alter materialized view public.cf_top_donors_new rename to cf_top_donors;
  alter index public.cf_top_donors_new_pk rename to cf_top_donors_pk;
  alter index public.cf_top_donors_new_candidate_amount_idx rename to cf_top_donors_candidate_amount_idx;
  alter index public.cf_top_donors_new_candidate_type_idx rename to cf_top_donors_candidate_type_idx;
  alter index public.cf_top_donors_new_candidate_type_amount_idx rename to cf_top_donors_candidate_type_amount_idx;
end;
$$;

-- Run once, out of band (minutes): a one-off pg_cron job that removes itself.
--   select cron.schedule('cf-top-donors-rebuild-once', '<MM HH * * *, a few minutes ahead>',
--     $job$ select public.rebuild_cf_top_donors(); select cron.unschedule('cf-top-donors-rebuild-once'); $job$);
-- refresh_cf_finance_views() keeps refreshing the swapped-in matview by
-- name; nothing else changes.
