-- One-time cleanup: outside spending counts only real independent
-- expenditures (pipelines/load/ie.py "Only a real independent expenditure
-- counts"; scripts/data-import/tec/import_tx_finance.py skips DONATIONS).
--
-- The loaders now skip these rows, but they only add and update, and the
-- SLCF loader's prune refuses to delete more than 10% of a state's rows in
-- one run, so the rows already loaded are removed here. Every deleted row
-- is copied to a dated backup table first.
--
--  1. Florida: every row from the candidate-chaired "Friends of" committees
--     listed in the registry (src/registries/committees/fl.csv). Florida's
--     data never marks an expenditure as independent; these committees'
--     spending (incl. $45.5M handed to the Republican Party of Florida) was
--     counted as outside spending for their chair. Their receipts
--     (cf_ie_contributions) and spender rows (cf_ie_committees) go too.
--  2. SLCF states: rows that are money handed to another committee
--     (contribution, transfer, refund) rather than spent.
--  3. Texas: TEC DONATIONS rows in tx_independent_expenditures; the nightly
--     publish_texas_to_cf() then drops their cf_* copies, deleted here too
--     so the site is right before it runs.
--  4. SLCF spenders left with no outside-spending rows: their receipts and
--     spender rows (the loader keys both on spenders it still produces).
-- California's few in-kind contributions that filers reported on Schedule E
-- are left as reported.
--
-- Safe to re-run: the backups skip rows they already hold, and a second run
-- finds nothing left to delete. Run with execute_sql (it has its own
-- begin/commit), after the loader change is deployed, or the next nightly
-- re-adds the rows.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc).

begin;

create table if not exists public.cf_independent_expenditures_backup_20261019 as
select ie.* from public.cf_independent_expenditures ie where false;

insert into public.cf_independent_expenditures_backup_20261019
select ie.* from public.cf_independent_expenditures ie
 where ((ie.source = 'slcf' and ie.ie_filer_ident in ('fl:89043', 'fl:74495', 'fl:79506', 'fl:89415', 'fl:89007', 'fl:89604'))
    or (ie.source = 'slcf' and ie.description ~* '\m(contributions?|transfers?|refunds?)\M'
                           and ie.description !~* 'independent\s+expenditure')
    or (ie.source = 'tec' and ie.source_txn_id in (
          select t.expend_info_id::text || '-' || t.expend_persent_id::text
            from public.tx_independent_expenditures t where upper(t.category_code) = 'DONATIONS')))
   and not exists (select 1 from public.cf_independent_expenditures_backup_20261019 b where b.id = ie.id);

create table if not exists public.cf_ie_contributions_backup_20261019 as
select c.* from public.cf_ie_contributions c where false;
insert into public.cf_ie_contributions_backup_20261019
select c.* from public.cf_ie_contributions c
 where c.source = 'slcf'
   and not exists (select 1 from public.cf_independent_expenditures ie
                    where ie.ie_filer_ident = c.ie_filer_ident
                      and not exists (select 1 from public.cf_independent_expenditures_backup_20261019 b
                                       where b.id = ie.id))
   and not exists (select 1 from public.cf_ie_contributions_backup_20261019 b where b.id = c.id);

create table if not exists public.tx_independent_expenditures_backup_20261019 as
select t.* from public.tx_independent_expenditures t where false;
insert into public.tx_independent_expenditures_backup_20261019
select t.* from public.tx_independent_expenditures t
 where upper(t.category_code) = 'DONATIONS'
   and not exists (select 1 from public.tx_independent_expenditures_backup_20261019 b
                    where b.expend_info_id = t.expend_info_id and b.expend_persent_id = t.expend_persent_id);

delete from public.cf_independent_expenditures ie
 using public.cf_independent_expenditures_backup_20261019 b where ie.id = b.id;
delete from public.cf_ie_contributions c
 using public.cf_ie_contributions_backup_20261019 b where c.id = b.id;
-- cf_ie_committees has no source column; SLCF spenders are the SLCF states'
-- prefixes (Texas and California spenders are left to their own publishes).
create table if not exists public.cf_ie_committees_backup_20261019 as
select k.* from public.cf_ie_committees k where false;
insert into public.cf_ie_committees_backup_20261019
select k.* from public.cf_ie_committees k
 where split_part(k.filer_ident, ':', 1) in ('ak', 'az', 'fl', 'ga', 'mi', 'oh', 'wi')
   and not exists (select 1 from public.cf_independent_expenditures ie where ie.ie_filer_ident = k.filer_ident)
   and not exists (select 1 from public.cf_ie_contributions c where c.ie_filer_ident = k.filer_ident)
   and not exists (select 1 from public.cf_ie_committees_backup_20261019 b where b.filer_ident = k.filer_ident);
delete from public.cf_ie_committees k
 using public.cf_ie_committees_backup_20261019 b where k.filer_ident = b.filer_ident;
delete from public.tx_independent_expenditures t
 using public.tx_independent_expenditures_backup_20261019 b
 where t.expend_info_id = b.expend_info_id and t.expend_persent_id = b.expend_persent_id;

-- Backups hold data with donor names: service role only.
revoke all on public.cf_independent_expenditures_backup_20261019,
              public.cf_ie_contributions_backup_20261019,
              public.cf_ie_committees_backup_20261019,
              public.tx_independent_expenditures_backup_20261019 from anon, authenticated;
alter table public.cf_independent_expenditures_backup_20261019 enable row level security;
alter table public.cf_ie_contributions_backup_20261019 enable row level security;
alter table public.cf_ie_committees_backup_20261019 enable row level security;
alter table public.tx_independent_expenditures_backup_20261019 enable row level security;

commit;
-- Then: select public.refresh_cf_finance_views();
