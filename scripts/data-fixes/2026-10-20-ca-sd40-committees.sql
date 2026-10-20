-- One-time fix: California Senate District 40 had the wrong committee on
-- Mara Elliott and none on Kristie Bruce-Lane.
--
-- pipelines/load/roster_ca.py picked each candidate's committee from any
-- 2025-26 CAL-ACCESS cover page naming them for the district. The Republican
-- Party of San Diego County (filer 741949, a party committee) filed an IE
-- report (F496) naming Elliott, so the roster seed linked that committee to
-- her. Her page then showed the county GOP's money, including its transfers
-- to Bruce-Lane ($1.67M raised, $1.43M spent), while Bruce-Lane showed $0.
-- The matcher now accepts only a candidate's own Form 460 / 450 covers.
--
-- Correct ids (CAL-ACCESS, State Senate District 40, 2026):
--   Mara Elliott         candidate 1483628, committee 1483627
--                        ("Elliott for Senate 2026; Mara")
--   Kristie Bruce-Lane   candidate 1439276, committee 1477126
--                        ("Bruce-Lane for Senate 2026")
-- (1497945 "Elliott for Senate 2026, sponsored by ..." is a sponsored
-- supporting committee, not hers to carry.)
--
-- Run 2026-10-20-ca-sd40-committees-check.sql first (read-only), then this.
--
-- No backups (the queries are too expensive). Nothing here is hard to get
-- back: the deleted rows are the county party's, loaded by the importer from
-- CAL-ACCESS, and the two candidate rows are changed by an update that this
-- header and the check file record.
--   before: Elliott filer_refs ["ca:741949"], link committee_filer_id 741949;
--           Bruce-Lane filer_refs [], no ca_candidate_filers row.
--
-- What it does, in one transaction:
--   1. deletes the ca_contributions / ca_expenditures / ca_loans staging rows
--      loaded for Elliott from committee 741949, and her published cf_* copies,
--      so the site is right before the nightly publish runs;
--   2. points cf_candidates.filer_refs and ca_candidate_filers at the two real
--      committees.
-- Every delete filters on Elliott's candidate_id (indexed) as well as the
-- committee. ca_filings / ca_summaries rows for 741949 stay: nothing joins to
-- them once the link moves.
--
-- Safe to re-run. Run it in the Supabase SQL editor (it deletes rows, which
-- the Supabase MCP will not run unconfirmed), and only after
-- pipelines/load/roster_ca.py has the Form 460/450 filter, or a manual
-- roster run can link the committee again.
--
-- Then: dispatch CA finance sync (ca-finance-sync.yml) so the importer loads
-- committees 1483627 and 1477126, and run
--   select public.publish_california_to_cf();
--   select public.refresh_cf_finance_views();
-- (pg_cron does both nightly: 09:00 UTC import, 10:30 UTC publish.)

begin;

do $$
declare
  elliott uuid := 'e3d77ed2-7dad-4321-ac8d-28a6d8db4eda';  -- mara-elliott-ca-sd40
  bruce   uuid := '5a5e3227-71f2-43a9-9385-6fb3eeb61aa7';  -- kristie-bruce-lane-ca-sd40
  n int;
begin
  if (select count(*) from public.cf_candidates
       where id in (elliott, bruce) and state = 'ca' and office = 'state-senate' and district = '40') <> 2 then
    raise exception 'SD40 candidate rows not as expected; stop';
  end if;
  if exists (select 1 from public.ca_candidate_filers
              where candidate_id not in (elliott, bruce)
                and (candidate_filer_id in (1483628, 1439276)
                  or committee_filer_id in (1483627, 1477126))) then
    raise exception 'another candidate already holds one of these filer ids; merge by hand';
  end if;

  -- 1. Remove what was loaded for the county party under Elliott.
  delete from public.ca_contributions where candidate_id = elliott and committee_filer_id = 741949;
  get diagnostics n = row_count;  raise notice 'ca_contributions deleted: %', n;
  delete from public.ca_expenditures  where candidate_id = elliott and committee_filer_id = 741949;
  get diagnostics n = row_count;  raise notice 'ca_expenditures deleted: %', n;
  delete from public.ca_loans         where candidate_id = elliott and committee_filer_id = 741949;
  get diagnostics n = row_count;  raise notice 'ca_loans deleted: %', n;
  delete from public.cf_contributions where candidate_id = elliott and source = 'calaccess' and committee_id = 'ca:741949';
  get diagnostics n = row_count;  raise notice 'cf_contributions deleted: %', n;
  delete from public.cf_expenditures  where candidate_id = elliott and source = 'calaccess' and committee_id = 'ca:741949';
  get diagnostics n = row_count;  raise notice 'cf_expenditures deleted: %', n;
  delete from public.cf_loans         where candidate_id = elliott and source = 'calaccess' and committee_id = 'ca:741949';
  get diagnostics n = row_count;  raise notice 'cf_loans deleted: %', n;

  -- 2. The right committees.
  update public.cf_candidates
     set filer_refs = '["ca:1483627"]'::jsonb, updated_at = now()
   where id = elliott;
  update public.cf_candidates
     set filer_refs = '["ca:1477126"]'::jsonb, updated_at = now()
   where id = bruce;

  insert into public.ca_candidate_filers (candidate_id, candidate_filer_id, committee_filer_id)
  values (elliott, 1483628, 1483627), (bruce, 1439276, 1477126)
  on conflict (candidate_id) do update
    set candidate_filer_id = excluded.candidate_filer_id,
        committee_filer_id = excluded.committee_filer_id;
end $$;

commit;
