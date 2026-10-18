-- publish_california_to_cf(): copy California's settled CAL-ACCESS rows from
-- the ca_cf_* views (20261018160000) into cf_*, like publish_texas_to_cf()
-- does for Texas. Scoped so no other state's rows are ever touched: every
-- write and delete filters on source = 'calaccess' (and cf_ie_committees on
-- state = 'ca').
--
--   ca_cf_contributions            -> cf_contributions            (source 'calaccess')
--   ca_cf_expenditures             -> cf_expenditures             (source 'calaccess')
--   ca_cf_loans                    -> cf_loans                    (source 'calaccess')
--   ca_ie_committees               -> cf_ie_committees            (state 'ca', "ca:<filer_id>")
--   ca_cf_independent_expenditures -> cf_independent_expenditures (source 'calaccess')
--   ca_cf_ie_contributions         -> cf_ie_contributions         (source 'calaccess')
--
-- Rows that leave the views (an amendment dropped them, a 460 now covers a
-- 497, ...) are deleted from cf_*; unchanged rows are not rewritten. New rows
-- keep their staging uuid. Candidates are not published: California's
-- cf_candidates rows are their own editorial record (see 20261018160000).
-- cycle keeps CAL-ACCESS's phase labels (primary-2026 / general-2026), as
-- Texas keeps TEC's.
--
-- An empty ca_filings means the importer has never run (or staging was
-- emptied); publishing that would delete every California row, so the
-- function does nothing then.
--
-- Schedule: pg_cron at 10:30 UTC, after the 09:00 UTC CAL-ACCESS sync
-- (ca-finance-sync.yml, ~20 min), then the cf_* matview refresh. The command
-- sets its own statement_timeout: a function-level setting does not extend
-- the timer of the statement that calls it (see 20261007202000).
--
-- Contains DELETE statements, which the Supabase MCP will not run without a
-- confirmation it cannot show, so this file is applied in the Supabase SQL
-- editor (copy the raw file from GitHub).

create or replace function public.publish_california_to_cf()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '20min'
as $$
declare
  n_c int; n_c_del int;
  n_e int; n_e_del int;
  n_l int; n_l_del int;
  n_m int;
  n_i int; n_i_del int;
  n_x int; n_x_del int;
begin
  if not exists (select 1 from public.ca_filings) then
    return jsonb_build_object('skipped', 'ca_filings is empty: the CAL-ACCESS import has not run');
  end if;

  -- Contributions ----------------------------------------------------------
  delete from public.cf_contributions c
   where c.source = 'calaccess'
     and not exists (
       select 1 from public.ca_cf_contributions v where v.source_txn_id = c.source_txn_id);
  get diagnostics n_c_del = row_count;

  insert into public.cf_contributions as c (
    id, candidate_id, committee_id, source, source_txn_id, contributor_type,
    contributor_last_name, contributor_first_name, employer, occupation,
    amount, contribution_date, city, state, zip, cycle, source_form_type
  )
  select
    coalesce(v.id, gen_random_uuid()), v.candidate_id, v.committee_id,
    'calaccess', v.source_txn_id, v.contributor_type, v.contributor_last_name,
    v.contributor_first_name, v.employer, v.occupation, v.amount,
    v.contribution_date, v.city, v.state, v.zip, v.cycle, v.source_form_type
  from public.ca_cf_contributions v
  on conflict (source, source_txn_id) where source_txn_id is not null do update set
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
   where e.source = 'calaccess'
     and not exists (
       select 1 from public.ca_cf_expenditures v where v.source_txn_id = e.source_txn_id);
  get diagnostics n_e_del = row_count;

  insert into public.cf_expenditures as e (
    id, candidate_id, committee_id, source, source_txn_id, payee_type,
    payee_last_name, payee_first_name, payee_city, payee_state, payee_zip,
    amount, expenditure_date, category, description, cycle
  )
  select
    v.id, v.candidate_id, v.committee_id, 'calaccess', v.source_txn_id,
    v.payee_type, v.payee_last_name, v.payee_first_name, v.payee_city,
    v.payee_state, v.payee_zip, v.amount, v.expenditure_date, v.category,
    v.description, v.cycle
  from public.ca_cf_expenditures v
  on conflict (source, source_txn_id) where source_txn_id is not null do update set
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
   where l.source = 'calaccess'
     and not exists (
       select 1 from public.ca_cf_loans v where v.source_txn_id = l.source_txn_id);
  get diagnostics n_l_del = row_count;

  insert into public.cf_loans as l (
    id, candidate_id, committee_id, source, source_txn_id, lender_type,
    lender_last_name, lender_first_name, amount, loan_date, is_guarantor, cycle
  )
  select
    v.id, v.candidate_id, v.committee_id, 'calaccess', v.source_txn_id,
    v.lender_type, v.lender_last_name, v.lender_first_name, v.amount,
    v.loan_date, v.is_guarantor, v.cycle
  from public.ca_cf_loans v
  on conflict (source, source_txn_id) where source_txn_id is not null do update set
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
  insert into public.cf_ie_committees as m (filer_ident, state, name, committee_type)
  select 'ca:' || t.filer_id, 'ca',
         coalesce(nullif(t.name, ''), 'Filer ' || t.filer_id), t.filer_type
  from public.ca_ie_committees t
  on conflict (filer_ident) do update set
    name = excluded.name, committee_type = excluded.committee_type
  where m.state = 'ca'
    and (m.name, m.committee_type) is distinct from (excluded.name, excluded.committee_type);
  get diagnostics n_m = row_count;

  delete from public.cf_independent_expenditures i
   where i.source = 'calaccess'
     and not exists (
       select 1 from public.ca_cf_independent_expenditures v where v.source_txn_id = i.source_txn_id);
  get diagnostics n_i_del = row_count;

  insert into public.cf_independent_expenditures as i (
    id, ie_filer_ident, target_candidate_id, source, source_txn_id,
    support_oppose, amount, expenditure_date, description, cycle
  )
  select
    v.id, v.ie_filer_ident, v.target_candidate_id, 'calaccess', v.source_txn_id,
    v.support_oppose, v.amount, v.expenditure_date, v.description, v.cycle
  from public.ca_cf_independent_expenditures v
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
   where x.source = 'calaccess'
     and not exists (
       select 1 from public.ca_cf_ie_contributions v where v.source_txn_id = x.source_txn_id);
  get diagnostics n_x_del = row_count;

  insert into public.cf_ie_contributions as x (
    id, ie_filer_ident, source, source_txn_id, contributor_type,
    contributor_last_name, contributor_first_name, employer, occupation,
    amount, contribution_date, city, state, cycle
  )
  select
    v.id, v.ie_filer_ident, 'calaccess', v.source_txn_id, v.contributor_type,
    v.contributor_last_name, v.contributor_first_name, v.employer,
    v.occupation, v.amount, v.contribution_date, v.city, v.state, v.cycle
  from public.ca_cf_ie_contributions v
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

  return jsonb_build_object(
    'contributions', jsonb_build_object('upserted', n_c, 'deleted', n_c_del),
    'expenditures', jsonb_build_object('upserted', n_e, 'deleted', n_e_del),
    'loans', jsonb_build_object('upserted', n_l, 'deleted', n_l_del),
    'ie_committees', n_m,
    'independent_expenditures', jsonb_build_object('upserted', n_i, 'deleted', n_i_del),
    'ie_contributions', jsonb_build_object('upserted', n_x, 'deleted', n_x_del)
  );
end;
$$;

revoke all on function public.publish_california_to_cf() from public, anon, authenticated;

select cron.schedule(
  'ca-publish-to-cf-nightly',
  '30 10 * * *',
  $$set statement_timeout = '30min'; select public.publish_california_to_cf(); select public.refresh_cf_finance_views();$$
);
