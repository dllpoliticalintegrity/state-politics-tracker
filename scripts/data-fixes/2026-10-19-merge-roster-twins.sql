-- One-time merge: legislative candidates the roster sync created twice on
-- 2026-10-18, once under their ballot name (on the ballot, no committee,
-- $0) and once under their filing name (off the ballot, with the committee
-- and the money, shown greyed out last). The committee names confirm each is
-- one person: "Friends of Don Parsons" filed by Donald L. Parsons,
-- "Conservatives for Michelle Teska" by Colleen Teska, "Families for Diane
-- Mullins" by Teresa Mullins, "Scott Grund for Ohio" by Mark Grund, "Kori
-- Simmons for the People" by Mitchell D. Simmons; John LaHood files as
-- George J. Lahood.
--
-- The row holding the money is kept (its finance rows stay attached) and
-- takes the ballot listing's name, slug and status; the empty ballot row is
-- deleted, refusing if it has any finance rows (cf_candidates deletes
-- cascade). pipelines/load/roster.py collapse_twins() now builds one row for
-- such pairs, so the nightly sync matches the kept row by slug and does not
-- recreate the other.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc).

begin;

create temp table twins (bare_id uuid, money_id uuid) on commit drop;
insert into twins values
  ('40d219fe-21eb-4ad2-8cd1-1a9e1b3ec3a8', 'b5461ad3-a9e5-4e14-b462-b148e95b42b9'),  -- GA HD44 Don Parsons
  ('bccfc406-a116-449e-973d-acb8bda94e67', '0c970c89-7b65-4be7-8173-de68e9e0f8ba'),  -- GA HD175 John LaHood
  ('13576393-c603-4866-a490-d694b68f7344', 'd05acca7-f343-424b-bfae-01bae504c3c4'),  -- GA SD21 Kori Simmons
  ('2009c276-69cb-46bb-b60f-4de45b4bca6b', 'b38404e8-4937-40aa-a09d-d043b0f43cd0'),  -- OH HD55 Michelle Teska
  ('6e5a7f19-4f3c-43d1-9de1-680a33751cf4', '2660e3ad-1991-49fe-8920-20b4cd3cceae'),  -- OH HD47 Diane Mullins
  ('786efab9-c139-4003-8fbd-ebf1460aa1d8', 'd964648d-3ee4-492e-89e8-bf7136e6bce8');  -- OH HD98 Scott Grund

do $$
begin
  if exists (
    select 1 from twins t
     where exists (select 1 from public.cf_contributions x where x.candidate_id = t.bare_id)
        or exists (select 1 from public.cf_expenditures x where x.candidate_id = t.bare_id)
        or exists (select 1 from public.cf_loans x where x.candidate_id = t.bare_id)
        or exists (select 1 from public.cf_independent_expenditures x where x.target_candidate_id = t.bare_id)
        or exists (select 1 from public.cf_candidates b where b.id = t.bare_id and b.filer_refs <> '[]'::jsonb)) then
    raise exception 'a ballot-name row has money or refs; merge by hand';
  end if;
end $$;

create table if not exists public.cf_candidates_backup_20261019 as
select c.* from public.cf_candidates c where false;
insert into public.cf_candidates_backup_20261019
select c.* from public.cf_candidates c
 where c.id in (select bare_id from twins union all select money_id from twins)
   and not exists (select 1 from public.cf_candidates_backup_20261019 b where b.id = c.id);
revoke all on public.cf_candidates_backup_20261019 from anon, authenticated;
alter table public.cf_candidates_backup_20261019 enable row level security;

create temp table bare on commit drop as
select t.money_id, b.name, b.slug, b.status from twins t join public.cf_candidates b on b.id = t.bare_id;

delete from public.cf_candidates c using twins t where c.id = t.bare_id;

update public.cf_candidates c
   set name = b.name, slug = b.slug, status = b.status, updated_at = now()
  from bare b where c.id = b.money_id;

commit;
-- Then: select public.refresh_cf_finance_views();
