-- California: stop double counting in the ca_cf_* views that
-- publish_california_to_cf() copies into cf_* (it deletes cf rows that leave
-- a view, so the next publish removes them from the site).
--
-- Outside spending (ca_cf_independent_expenditures):
--  1. A primarily-formed PAC's Form 460 Schedule E mixes its independent
--     expenditures with its own running costs. Only IND rows, voter
--     communication codes (FPPC: LIT mail, MBR member communications, PHO
--     phone banks, PRT print ads, RAD radio, TEL TV/cable airtime, WEB
--     internet, CMP campaign materials, POS postage), uncoded rows and rows
--     paid through an agent ("SEE SCHEDULE G") count. Consultants, polling,
--     professional services, fundraising, office, salaries, travel and fees
--     (~$1.85M in Oct 2026, e.g. Greater Golden State's legal and bank fees
--     counted as opposing Hilton) do not.
--  2. Contributions, transfers and refunds reported on an IE schedule, as in
--     pipelines/load/ie.py: monetary contributions to a candidate, and one
--     PAC's in-kind contributions to another PAC that reports the same ads
--     as its own IE (Deliver for California -> California Back to Basics).
--  3. Payments the filer itself marks as made in error.
-- Raised (ca_cf_contributions):
--  4. Form 496 Part 3 lists contributions an IE filer received that it also
--     reports on its Form 460/497 (240 of 251 rows, $1.23M): a Part 3 row
--     with a twin (same candidate, contributor, amount, date) is dropped.
-- Spent (ca_cf_expenditures):
--  5. Contributions a candidate committee made are listed on Schedule D and
--     again as Schedule E payments (127 pairs, $1.70M): a Schedule D row with
--     a Schedule E twin in the same filing (payee, amount, date) is dropped.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

create or replace view public.ca_cf_independent_expenditures as
select id,
  'ca:'::text || ie_committee_filer_id as ie_filer_ident,
  target_candidate_id,
  (filing_id::text || '-'::text) || tran_id as source_txn_id,
  upper(support_oppose) as support_oppose,
  amount,
  expenditure_date,
  nullif(concat_ws(' · '::text, nullif(description, ''::text), nullif(expn_code, ''::text)), ''::text) as description,
  coalesce(cycle, 'unknown'::text) as cycle
from public.ca_independent_expenditures_deduped d
where target_candidate_id is not null and ie_committee_filer_id is not null
  and not (source_form_type = 'F460'
           and coalesce(expn_code, '') not in ('', 'IND', 'LIT', 'MBR', 'PHO', 'PRT', 'RAD', 'TEL', 'WEB', 'CMP', 'POS')
           and coalesce(description, '') !~* 'schedule\s+g')
  and not (coalesce(description, '') ~* '\m(contributions?|transfers?|refunds?)\M'
           and coalesce(description, '') !~* 'independent\s+expenditure')
  and coalesce(description, '') !~* '(duplicate\s+payment|processed\s+in\s+error)';

create or replace view public.ca_cf_contributions as
select d.id,
  d.candidate_id,
  'ca:'::text || d.committee_filer_id as committee_id,
  (d.filing_id::text || '-'::text) || d.tran_id as source_txn_id,
  case when upper(d.contributor_type) = 'IND'::text then 'INDIVIDUAL'::text else 'ENTITY'::text end as contributor_type,
  d.contributor_last_name,
  d.contributor_first_name,
  d.employer,
  d.occupation,
  d.amount,
  d.contribution_date,
  d.city,
  d.state,
  d.zip,
  coalesce(d.cycle, 'unknown'::text) as cycle,
  d.source_form_type
from public.ca_contributions_deduped d
where coalesce(d.source_form_type, ''::text) !~~ 'LOAN-%'::text
  and not (upper(coalesce(d.source_form_type, '')) = 'F496P3'
           and exists (
             select 1 from public.ca_contributions_deduped o
              where o.candidate_id = d.candidate_id
                and upper(coalesce(o.source_form_type, '')) <> 'F496P3'
                and o.amount = d.amount
                and o.contribution_date is not distinct from d.contribution_date
                and upper(coalesce(o.contributor_last_name, '')) = upper(coalesce(d.contributor_last_name, ''))))
union all
select null::uuid as id,
  f.candidate_id,
  'ca:'::text || f.filer_id as committee_id,
  'unitemized-'::text || f.filing_id::text as source_txn_id,
  null::text as contributor_type,
  'Unitemized (small-dollar) contributions'::text as contributor_last_name,
  null::text as contributor_first_name,
  null::text as employer,
  null::text as occupation,
  s.amount_a as amount,
  f.rpt_end as contribution_date,
  null::text as city,
  null::text as state,
  null::text as zip,
  case
    when f.rpt_end is null then 'unknown'::text
    when f.rpt_end < '2025-01-01'::date then 'pre-cycle'::text
    when f.rpt_end <= '2026-06-02'::date then 'primary-2026'::text
    when f.rpt_end <= '2026-11-03'::date then 'general-2026'::text
    else 'post-2026'::text
  end as cycle,
  'A-UNITEMIZED'::text as source_form_type
from (select distinct on (lf.filer_id, lf.filing_id) lf.filer_id, lf.filing_id, lf.amend_id, lf.rpt_end, cf.candidate_id
        from public.ca_filings lf
        join public.ca_candidate_filers cf on cf.committee_filer_id = lf.filer_id
       where lf.form_type = 'F460'::text
       order by lf.filer_id, lf.filing_id, lf.amend_id desc) f
join public.ca_summaries s on s.filing_id = f.filing_id and s.amend_id = f.amend_id
                          and s.form_type = 'A'::text and s.line_item = '2'::text
where coalesce(s.amount_a, 0::numeric) <> 0::numeric and f.rpt_end >= '2025-01-01'::date;

create or replace view public.ca_cf_expenditures as
with max_amend as (
  select ca_expenditures.filing_id, max(ca_expenditures.amend_id) as max_amend_id
    from public.ca_expenditures
   group by ca_expenditures.filing_id
), latest as (
  select e.* from public.ca_expenditures e
    join max_amend m on m.filing_id = e.filing_id and m.max_amend_id = e.amend_id
   where e.candidate_id is not null
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
from latest e
where not (e.source_form_type = 'D'
           and exists (
             select 1 from latest x
              where x.filing_id = e.filing_id and x.source_form_type = 'E'
                and x.amount = e.amount
                and x.expenditure_date is not distinct from e.expenditure_date
                and upper(coalesce(x.payee_last_name, '')) = upper(coalesce(e.payee_last_name, ''))));
