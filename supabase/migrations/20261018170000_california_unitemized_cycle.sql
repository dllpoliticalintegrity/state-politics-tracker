-- ca_cf_contributions (20261018160000): count unitemized gifts only from
-- Form 460s covering the 2026 cycle.
--
-- The importer drops itemized contributions dated before 2025-01-01
-- (CYCLE_START): committees such as Yee's and Thurmond's were reused from
-- earlier campaigns, and their older reports are not 2026 money. The
-- unitemized line came from every Form 460 the committee ever filed, so it
-- still counted those reports (Yee $66k, Thurmond $19k too high against
-- cagovtracker.com, which only added unitemized amounts to cycles that had
-- itemized rows). Same view, one more condition.
--
-- Applied to the shared tracker project (lohxdfrxnxuxjdvvyfjc) via the
-- Supabase MCP.

create or replace view public.ca_cf_contributions with (security_invoker = true) as
select
  d.id, d.candidate_id, 'ca:' || d.committee_filer_id as committee_id,
  d.filing_id::text || '-' || d.tran_id as source_txn_id,
  case when upper(d.contributor_type) = 'IND' then 'INDIVIDUAL' else 'ENTITY' end as contributor_type,
  d.contributor_last_name, d.contributor_first_name, d.employer, d.occupation,
  d.amount, d.contribution_date, d.city, d.state, d.zip,
  coalesce(d.cycle, 'unknown') as cycle, d.source_form_type
from public.ca_contributions_deduped d
where coalesce(d.source_form_type, '') not like 'LOAN-%'
union all
-- Small gifts CAL-ACCESS doesn't itemize: one row per Form 460 (its latest
-- amendment), Schedule A line 2, dated the end of the period it covers —
-- the line cagovtracker.com added to make total raised match PowerSearch.
-- No contributor type, like the pilot's unitemized lump sums.
select
  null::uuid, f.candidate_id, 'ca:' || f.filer_id,
  'unitemized-' || f.filing_id::text,
  null, 'Unitemized (small-dollar) contributions', null, null, null,
  s.amount_a, f.rpt_end, null, null, null,
  case
    when f.rpt_end is null then 'unknown'
    when f.rpt_end < date '2025-01-01' then 'pre-cycle'
    when f.rpt_end <= date '2026-06-02' then 'primary-2026'
    when f.rpt_end <= date '2026-11-03' then 'general-2026'
    else 'post-2026'
  end,
  'A-UNITEMIZED'
from (
  select distinct on (lf.filer_id, lf.filing_id)
         lf.filer_id, lf.filing_id, lf.amend_id, lf.rpt_end, cf.candidate_id
  from public.ca_filings lf
  join public.ca_candidate_filers cf on cf.committee_filer_id = lf.filer_id
  where lf.form_type = 'F460'
  order by lf.filer_id, lf.filing_id, lf.amend_id desc
) f
join public.ca_summaries s
  on s.filing_id = f.filing_id and s.amend_id = f.amend_id
 and s.form_type = 'A' and s.line_item = '2'
where coalesce(s.amount_a, 0) <> 0
  -- Reports from before the cycle belong to earlier campaigns, as the
  -- importer's CYCLE_START does for itemized rows.
  and f.rpt_end >= date '2025-01-01';
