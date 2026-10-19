-- ca_cf_expenditures: the Schedule D / Schedule E twin check from
-- 20261019020000 scanned the whole latest-amendment set for every Schedule D
-- row (~15 s per evaluation), which made publish_california_to_cf() run long
-- enough for the SQL editor's connection to drop. Same rule, now an indexed
-- probe of ca_expenditures (filing_id, amend_id, ...): a Schedule D row is
-- dropped when the same filing and amendment has a Schedule E payment with
-- the same payee, amount and date.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc).

create or replace view public.ca_cf_expenditures with (security_invoker = true) as
with max_amend as (
  select ca_expenditures.filing_id, max(ca_expenditures.amend_id) as max_amend_id
    from public.ca_expenditures
   group by ca_expenditures.filing_id
)
select e.id,
  e.candidate_id,
  'ca:'::text || e.committee_filer_id as committee_id,
  (e.filing_id::text || '-'::text) || e.tran_id as source_txn_id,
  null::text as payee_type,
  e.payee_last_name,
  e.payee_first_name,
  e.payee_city,
  e.payee_state,
  e.payee_zip,
  e.amount,
  e.expenditure_date,
  e.expn_code as category,
  e.expn_description as description,
  coalesce(e.cycle, 'unknown'::text) as cycle
from public.ca_expenditures e
join max_amend m on m.filing_id = e.filing_id and m.max_amend_id = e.amend_id
where e.candidate_id is not null
  and not (e.source_form_type = 'D'
           and exists (
             select 1 from public.ca_expenditures x
              where x.filing_id = e.filing_id and x.amend_id = e.amend_id
                and x.source_form_type = 'E'
                and x.amount = e.amount
                and x.expenditure_date is not distinct from e.expenditure_date
                and upper(coalesce(x.payee_last_name, '')) = upper(coalesce(e.payee_last_name, ''))));
