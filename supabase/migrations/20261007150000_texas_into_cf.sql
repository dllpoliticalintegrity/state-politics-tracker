-- Texas joins the multi-state hub: publish the Texas tracker's tx_* data into
-- the state-keyed cf_* tables so the hub's pages (and, after the domain
-- cut-over, texaspoliticstracker.com served from this codebase in
-- single-state mode) render Texas exactly like every other state.
--
-- Why a copy and not a new importer: the TEC importer
-- (tx-politics-tracker, scripts/data-import/tec/import_tx_finance.py) carries
-- Texas-only semantics that have no place in the generic schema — each
-- candidate's two filer accounts (COH + specific-purpose committee), special
-- pre-election ("48-hour") reports whose rows are re-reported later, and
-- superseded reports — and resolves them in tx_* via
-- refresh_tx_special_supersession(). tx_* therefore stays Texas's staging
-- layer; this function publishes its settled rows (rereported = false) into
-- cf_*, the published layer every state's pages read. The live Texas site
-- keeps reading tx_* until the cut-over, so nothing changes for it.
--
-- What is copied, all scoped so no other state's rows are ever touched:
--   tx_candidates               -> cf_candidates (state 'tx', same uuid, same
--                                  slug; office GOVERNOR/LTGOVERNOR/ATTYGEN ->
--                                  governor/lt-governor/attorney-general;
--                                  filer_refs ["tx:<COH>", "tx:<SPAC>"])
--   tx_contributions            -> cf_contributions          (source 'tec')
--   tx_expenditures             -> cf_expenditures           (source 'tec')
--   tx_loans                    -> cf_loans                  (source 'tec')
--   tx_ie_committees            -> cf_ie_committees          (state 'tx')
--   tx_independent_expenditures -> cf_independent_expenditures (source 'tec')
--   tx_ie_contributions         -> cf_ie_contributions       (source 'tec')
-- source_txn_id is TEC's natural key ("<reportInfoIdent>-<infoId>"), and new
-- rows keep their tx_* uuid. Rows that disappear from tx_* or become
-- rereported are deleted from cf_*; unchanged rows are not rewritten.
-- cycle keeps TEC's phase labels (primary-2026 / runoff-2026 / general-2026);
-- the hub sums across cycles everywhere and the outside-spending page already
-- filters on them.
--
-- Until the cut-over, tx_candidates stays the editorial source for Texas (the
-- admin console edits it through tx-tracker-admin): every run overwrites the
-- Texas rows of cf_candidates from it.
--
-- Schedule: pg_cron at 14:30 UTC, after the 12:00 UTC TEC sync
-- (tx-finance-sync.yml, ~1 h) and its refresh_tx_finance_views(); the job then
-- refreshes the cf_* matviews. Applied to the shared tracker project
-- (lohxdfrxnxuxjdvvyfjc) on 2026-10-07 via the Supabase MCP.

-- ---------------------------------------------------------------------------
-- Candidate social handles (TX had them; every state can use them). Bare
-- handles, no "@" — the same convention as tx_candidates.
-- ---------------------------------------------------------------------------
alter table public.cf_candidates
  add column if not exists twitter_user text,
  add column if not exists instagram_user text,
  add column if not exists facebook_user text,
  add column if not exists youtube_user text;

-- ---------------------------------------------------------------------------
-- The publisher
-- ---------------------------------------------------------------------------
create or replace function public.publish_texas_to_cf()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '20min'
as $$
declare
  n_cand int; n_cand_del int;
  n_c int; n_c_del int;
  n_e int; n_e_del int;
  n_l int; n_l_del int;
  n_m int;
  n_i int; n_i_del int;
  n_x int; n_x_del int;
begin
  -- Candidates -------------------------------------------------------------
  insert into public.cf_candidates as k (
    id, state, office, district, slug, name, party, filer_refs, committee_name,
    election_year, status, title, bio, photo_url, photo_url_large,
    photo_url_medium, photo_url_thumb, website, twitter_user, instagram_user,
    facebook_user, youtube_user, featured
  )
  select
    t.id, 'tx',
    case t.office
      when 'GOVERNOR' then 'governor'
      when 'LTGOVERNOR' then 'lt-governor'
      when 'ATTYGEN' then 'attorney-general'
      else lower(t.office)
    end,
    null, t.slug, t.name, t.party,
    to_jsonb(array_remove(array['tx:' || t.filer_ident, 'tx:' || t.committee_filer_ident], null)),
    t.committee_name, t.election_year, t.status, t.title, t.bio, t.photo_url,
    t.photo_url_large, t.photo_url_medium, t.photo_url_thumb, t.website,
    t.twitter_user, t.instagram_user, t.facebook_user, t.youtube_user, t.featured
  from public.tx_candidates t
  on conflict (id) do update set
    office = excluded.office, slug = excluded.slug, name = excluded.name,
    party = excluded.party, filer_refs = excluded.filer_refs,
    committee_name = excluded.committee_name,
    election_year = excluded.election_year, status = excluded.status,
    title = excluded.title, bio = excluded.bio, photo_url = excluded.photo_url,
    photo_url_large = excluded.photo_url_large,
    photo_url_medium = excluded.photo_url_medium,
    photo_url_thumb = excluded.photo_url_thumb, website = excluded.website,
    twitter_user = excluded.twitter_user,
    instagram_user = excluded.instagram_user,
    facebook_user = excluded.facebook_user,
    youtube_user = excluded.youtube_user, featured = excluded.featured,
    updated_at = now()
  where k.state = 'tx'
    and (k.office, k.slug, k.name, k.party, k.filer_refs, k.committee_name,
         k.election_year, k.status, k.title, k.bio, k.photo_url,
         k.photo_url_large, k.photo_url_medium, k.photo_url_thumb, k.website,
         k.twitter_user, k.instagram_user, k.facebook_user, k.youtube_user,
         k.featured)
        is distinct from
        (excluded.office, excluded.slug, excluded.name, excluded.party,
         excluded.filer_refs, excluded.committee_name, excluded.election_year,
         excluded.status, excluded.title, excluded.bio, excluded.photo_url,
         excluded.photo_url_large, excluded.photo_url_medium,
         excluded.photo_url_thumb, excluded.website, excluded.twitter_user,
         excluded.instagram_user, excluded.facebook_user, excluded.youtube_user,
         excluded.featured);
  get diagnostics n_cand = row_count;

  -- Contributions ----------------------------------------------------------
  delete from public.cf_contributions c
   where c.source = 'tec'
     and not exists (
       select 1 from public.tx_contributions t
        where not t.rereported
          and t.report_info_ident::text || '-' || t.contribution_info_id::text = c.source_txn_id);
  get diagnostics n_c_del = row_count;

  insert into public.cf_contributions as c (
    id, candidate_id, committee_id, source, source_txn_id, contributor_type,
    contributor_last_name, contributor_first_name, employer, occupation,
    amount, contribution_date, city, state, zip, cycle, source_form_type
  )
  select
    t.id, t.candidate_id, t.filer_ident, 'tec',
    t.report_info_ident::text || '-' || t.contribution_info_id::text,
    t.contributor_type, t.contributor_last_name, t.contributor_first_name,
    t.employer, t.occupation, t.amount, t.contribution_date, t.city, t.state,
    t.zip, t.cycle, t.source_form_type
  from public.tx_contributions t
  where not t.rereported
  on conflict (source, source_txn_id) do update set
    candidate_id = excluded.candidate_id, committee_id = excluded.committee_id,
    contributor_type = excluded.contributor_type,
    contributor_last_name = excluded.contributor_last_name,
    contributor_first_name = excluded.contributor_first_name,
    employer = excluded.employer, occupation = excluded.occupation,
    amount = excluded.amount, contribution_date = excluded.contribution_date,
    city = excluded.city, state = excluded.state, zip = excluded.zip,
    cycle = excluded.cycle, source_form_type = excluded.source_form_type,
    updated_at = now()
  where (c.candidate_id, c.committee_id, c.contributor_type,
         c.contributor_last_name, c.contributor_first_name, c.employer,
         c.occupation, c.amount, c.contribution_date, c.city, c.state, c.zip,
         c.cycle, c.source_form_type)
        is distinct from
        (excluded.candidate_id, excluded.committee_id, excluded.contributor_type,
         excluded.contributor_last_name, excluded.contributor_first_name,
         excluded.employer, excluded.occupation, excluded.amount,
         excluded.contribution_date, excluded.city, excluded.state, excluded.zip,
         excluded.cycle, excluded.source_form_type);
  get diagnostics n_c = row_count;

  -- Expenditures -----------------------------------------------------------
  delete from public.cf_expenditures e
   where e.source = 'tec'
     and not exists (
       select 1 from public.tx_expenditures t
        where not t.rereported
          and t.report_info_ident::text || '-' || t.expend_info_id::text = e.source_txn_id);
  get diagnostics n_e_del = row_count;

  insert into public.cf_expenditures as e (
    id, candidate_id, committee_id, source, source_txn_id, payee_type,
    payee_last_name, payee_first_name, payee_city, payee_state, payee_zip,
    amount, expenditure_date, category, description, cycle
  )
  select
    t.id, t.candidate_id, t.filer_ident, 'tec',
    t.report_info_ident::text || '-' || t.expend_info_id::text,
    t.payee_type, t.payee_last_name, t.payee_first_name, t.payee_city,
    t.payee_state, t.payee_zip, t.amount, t.expenditure_date, t.category_code,
    t.description, t.cycle
  from public.tx_expenditures t
  where not t.rereported
  on conflict (source, source_txn_id) do update set
    candidate_id = excluded.candidate_id, committee_id = excluded.committee_id,
    payee_type = excluded.payee_type, payee_last_name = excluded.payee_last_name,
    payee_first_name = excluded.payee_first_name,
    payee_city = excluded.payee_city, payee_state = excluded.payee_state,
    payee_zip = excluded.payee_zip, amount = excluded.amount,
    expenditure_date = excluded.expenditure_date,
    category = excluded.category, description = excluded.description,
    cycle = excluded.cycle, updated_at = now()
  where (e.candidate_id, e.committee_id, e.payee_type, e.payee_last_name,
         e.payee_first_name, e.payee_city, e.payee_state, e.payee_zip, e.amount,
         e.expenditure_date, e.category, e.description, e.cycle)
        is distinct from
        (excluded.candidate_id, excluded.committee_id, excluded.payee_type,
         excluded.payee_last_name, excluded.payee_first_name,
         excluded.payee_city, excluded.payee_state, excluded.payee_zip,
         excluded.amount, excluded.expenditure_date, excluded.category,
         excluded.description, excluded.cycle);
  get diagnostics n_e = row_count;

  -- Loans ------------------------------------------------------------------
  delete from public.cf_loans l
   where l.source = 'tec'
     and not exists (
       select 1 from public.tx_loans t
        where not t.rereported
          and t.report_info_ident::text || '-' || t.loan_info_id::text = l.source_txn_id);
  get diagnostics n_l_del = row_count;

  insert into public.cf_loans as l (
    id, candidate_id, committee_id, source, source_txn_id, lender_type,
    lender_last_name, lender_first_name, amount, loan_date, is_guarantor, cycle
  )
  select
    t.id, t.candidate_id, t.filer_ident, 'tec',
    t.report_info_ident::text || '-' || t.loan_info_id::text,
    t.lender_type, t.lender_last_name, t.lender_first_name, t.amount,
    t.loan_date, t.is_guarantor, t.cycle
  from public.tx_loans t
  where not t.rereported
  on conflict (source, source_txn_id) do update set
    candidate_id = excluded.candidate_id, committee_id = excluded.committee_id,
    lender_type = excluded.lender_type,
    lender_last_name = excluded.lender_last_name,
    lender_first_name = excluded.lender_first_name, amount = excluded.amount,
    loan_date = excluded.loan_date, is_guarantor = excluded.is_guarantor,
    cycle = excluded.cycle, updated_at = now()
  where (l.candidate_id, l.committee_id, l.lender_type, l.lender_last_name,
         l.lender_first_name, l.amount, l.loan_date, l.is_guarantor, l.cycle)
        is distinct from
        (excluded.candidate_id, excluded.committee_id, excluded.lender_type,
         excluded.lender_last_name, excluded.lender_first_name, excluded.amount,
         excluded.loan_date, excluded.is_guarantor, excluded.cycle);
  get diagnostics n_l = row_count;

  -- Outside spending: committees first (both IE tables reference them) ------
  insert into public.cf_ie_committees as m (filer_ident, state, name)
  select t.filer_ident, 'tx', coalesce(nullif(t.name, ''), 'Filer ' || t.filer_ident)
  from public.tx_ie_committees t
  on conflict (filer_ident) do update set name = excluded.name
  where m.state = 'tx' and m.name is distinct from excluded.name;
  get diagnostics n_m = row_count;

  delete from public.cf_independent_expenditures i
   where i.source = 'tec'
     and not exists (
       select 1 from public.tx_independent_expenditures t
        where not t.rereported
          and t.expend_info_id::text || '-' || t.expend_persent_id::text = i.source_txn_id);
  get diagnostics n_i_del = row_count;

  insert into public.cf_independent_expenditures as i (
    id, ie_filer_ident, target_candidate_id, source, source_txn_id,
    support_oppose, amount, expenditure_date, description, cycle
  )
  select
    t.id, t.ie_filer_ident, t.target_candidate_id, 'tec',
    t.expend_info_id::text || '-' || t.expend_persent_id::text,
    t.support_oppose, t.amount, t.expenditure_date,
    -- cf has no category column; keep TEC's code in the description like the
    -- Texas site's river does.
    nullif(concat_ws(' · ', nullif(t.description, ''), nullif(t.category_code, '')), ''),
    t.cycle
  from public.tx_independent_expenditures t
  where not t.rereported
  on conflict (source, source_txn_id) where source_txn_id is not null do update set
    ie_filer_ident = excluded.ie_filer_ident,
    target_candidate_id = excluded.target_candidate_id,
    support_oppose = excluded.support_oppose, amount = excluded.amount,
    expenditure_date = excluded.expenditure_date,
    description = excluded.description, cycle = excluded.cycle
  where (i.ie_filer_ident, i.target_candidate_id, i.support_oppose, i.amount,
         i.expenditure_date, i.description, i.cycle)
        is distinct from
        (excluded.ie_filer_ident, excluded.target_candidate_id,
         excluded.support_oppose, excluded.amount, excluded.expenditure_date,
         excluded.description, excluded.cycle);
  get diagnostics n_i = row_count;

  delete from public.cf_ie_contributions x
   where x.source = 'tec'
     and not exists (
       select 1 from public.tx_ie_contributions t
        where not t.rereported
          and t.report_info_ident::text || '-' || t.contribution_info_id::text = x.source_txn_id);
  get diagnostics n_x_del = row_count;

  insert into public.cf_ie_contributions as x (
    id, ie_filer_ident, source, source_txn_id, contributor_type,
    contributor_last_name, contributor_first_name, employer, occupation,
    amount, contribution_date, city, state, cycle
  )
  select
    t.id, t.ie_filer_ident, 'tec',
    t.report_info_ident::text || '-' || t.contribution_info_id::text,
    t.contributor_type, t.contributor_last_name, t.contributor_first_name,
    t.employer, t.occupation, t.amount, t.contribution_date, t.city, t.state,
    t.cycle
  from public.tx_ie_contributions t
  where not t.rereported
  on conflict (source, source_txn_id) where source_txn_id is not null do update set
    ie_filer_ident = excluded.ie_filer_ident,
    contributor_type = excluded.contributor_type,
    contributor_last_name = excluded.contributor_last_name,
    contributor_first_name = excluded.contributor_first_name,
    employer = excluded.employer, occupation = excluded.occupation,
    amount = excluded.amount, contribution_date = excluded.contribution_date,
    city = excluded.city, state = excluded.state, cycle = excluded.cycle
  where (x.ie_filer_ident, x.contributor_type, x.contributor_last_name,
         x.contributor_first_name, x.employer, x.occupation, x.amount,
         x.contribution_date, x.city, x.state, x.cycle)
        is distinct from
        (excluded.ie_filer_ident, excluded.contributor_type,
         excluded.contributor_last_name, excluded.contributor_first_name,
         excluded.employer, excluded.occupation, excluded.amount,
         excluded.contribution_date, excluded.city, excluded.state,
         excluded.cycle);
  get diagnostics n_x = row_count;

  -- Retired candidates and committees last, once nothing references them.
  -- (Deleting a candidate cascades to its cf_* finance rows.)
  delete from public.cf_candidates k
   where k.state = 'tx'
     and not exists (select 1 from public.tx_candidates t where t.id = k.id);
  get diagnostics n_cand_del = row_count;

  delete from public.cf_ie_committees m
   where m.state = 'tx'
     and not exists (select 1 from public.tx_ie_committees t where t.filer_ident = m.filer_ident)
     and not exists (select 1 from public.cf_independent_expenditures i where i.ie_filer_ident = m.filer_ident)
     and not exists (select 1 from public.cf_ie_contributions x where x.ie_filer_ident = m.filer_ident);

  return jsonb_build_object(
    'candidates', jsonb_build_object('upserted', n_cand, 'deleted', n_cand_del),
    'contributions', jsonb_build_object('upserted', n_c, 'deleted', n_c_del),
    'expenditures', jsonb_build_object('upserted', n_e, 'deleted', n_e_del),
    'loans', jsonb_build_object('upserted', n_l, 'deleted', n_l_del),
    'ie_committees', jsonb_build_object('upserted', n_m),
    'independent_expenditures', jsonb_build_object('upserted', n_i, 'deleted', n_i_del),
    'ie_contributions', jsonb_build_object('upserted', n_x, 'deleted', n_x_del)
  );
end;
$$;

-- Service role and cron only: a public caller could otherwise start a
-- multi-minute bulk write with the anon key.
revoke execute on function public.publish_texas_to_cf() from public, anon, authenticated;
grant execute on function public.publish_texas_to_cf() to service_role;

-- ---------------------------------------------------------------------------
-- Money river: every itemized row for tracked candidates, newest first — the
-- hub port of the Texas site's tx_money_river (Money → River tab). Plain view
-- so it is live the moment an import or publish lands; pages always filter it
-- to one race (state + office [+ district]), which the candidate join keys.
-- ---------------------------------------------------------------------------
create or replace view public.cf_money_river
with (security_invoker = true) as
select
  'contribution'::text as kind,
  c.id,
  c.contribution_date as txn_date,
  c.amount,
  c.candidate_id,
  k.slug as candidate_slug,
  k.name as candidate_name,
  k.party as candidate_party,
  k.state,
  k.office,
  k.district,
  case
    when c.contributor_type = 'INDIVIDUAL'
      then nullif(trim(concat_ws(' ', nullif(c.contributor_first_name, ''), nullif(c.contributor_last_name, ''))), '')
    else coalesce(nullif(c.contributor_last_name, ''), nullif(c.contributor_first_name, ''))
  end as counterparty,
  nullif(c.contributor_type, '') as counterparty_type,
  nullif(concat_ws(' · ', nullif(c.employer, ''), nullif(c.city, ''), nullif(c.state, '')), '') as detail,
  null::text as support_oppose,
  c.cycle,
  c.created_at as imported_at
from public.cf_contributions c
join public.cf_candidates k on k.id = c.candidate_id
union all
select
  'expenditure', e.id, e.expenditure_date, e.amount, e.candidate_id,
  k.slug, k.name, k.party, k.state, k.office, k.district,
  case
    when e.payee_type = 'INDIVIDUAL'
      then nullif(trim(concat_ws(' ', nullif(e.payee_first_name, ''), nullif(e.payee_last_name, ''))), '')
    else coalesce(nullif(e.payee_last_name, ''), nullif(e.payee_first_name, ''))
  end,
  nullif(e.payee_type, ''),
  nullif(concat_ws(' · ', nullif(e.description, ''), nullif(e.category, ''), nullif(e.payee_city, '')), ''),
  null::text,
  e.cycle,
  e.created_at
from public.cf_expenditures e
join public.cf_candidates k on k.id = e.candidate_id
union all
select
  'loan', l.id, l.loan_date, l.amount, l.candidate_id,
  k.slug, k.name, k.party, k.state, k.office, k.district,
  case
    when l.lender_type = 'INDIVIDUAL'
      then nullif(trim(concat_ws(' ', nullif(l.lender_first_name, ''), nullif(l.lender_last_name, ''))), '')
    else coalesce(nullif(l.lender_last_name, ''), nullif(l.lender_first_name, ''))
  end,
  nullif(l.lender_type, ''),
  case when l.is_guarantor then 'Guarantor' end,
  null::text,
  l.cycle,
  l.created_at
from public.cf_loans l
join public.cf_candidates k on k.id = l.candidate_id
union all
select
  'outside', i.id, i.expenditure_date, i.amount, i.target_candidate_id,
  k.slug, k.name, k.party, k.state, k.office, k.district,
  coalesce(nullif(m.name, ''), i.ie_filer_ident),
  'COMMITTEE',
  nullif(i.description, ''),
  i.support_oppose,
  i.cycle,
  i.created_at
from public.cf_independent_expenditures i
join public.cf_candidates k on k.id = i.target_candidate_id
left join public.cf_ie_committees m on m.filer_ident = i.ie_filer_ident;

grant select on public.cf_money_river to anon, authenticated, service_role;

-- The river orders by date within a race; give expenditures and outside
-- spending the same (candidate, date) index contributions already have.
create index if not exists idx_cf_expenditures_candidate_date
  on public.cf_expenditures (candidate_id, expenditure_date desc);
create index if not exists idx_cf_ie_target_date
  on public.cf_independent_expenditures (target_candidate_id, expenditure_date desc);

-- ---------------------------------------------------------------------------
-- Nightly publish + matview refresh, after the TEC sync. cron.schedule() with
-- a job name upserts, so re-running this migration is safe.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.schedule(
  'tx-publish-to-cf-nightly',
  '30 14 * * *',
  $$select public.publish_texas_to_cf(); select public.refresh_cf_finance_views();$$
);
