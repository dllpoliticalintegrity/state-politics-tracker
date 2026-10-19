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
-- One DO block, so it is all-or-nothing in the Supabase SQL editor too (the
-- editor does not keep temp tables between statements). Safe to re-run: a
-- pair already merged is skipped.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc).

create table if not exists public.cf_candidates_backup_20261019 as
select c.* from public.cf_candidates c where false;
revoke all on public.cf_candidates_backup_20261019 from anon, authenticated;
alter table public.cf_candidates_backup_20261019 enable row level security;

do $$
declare
  pair record;
  b record;
  merged int := 0;
begin
  for pair in
    select * from (values
      ('40d219fe-21eb-4ad2-8cd1-1a9e1b3ec3a8'::uuid, 'b5461ad3-a9e5-4e14-b462-b148e95b42b9'::uuid),  -- GA HD44 Don Parsons
      ('bccfc406-a116-449e-973d-acb8bda94e67'::uuid, '0c970c89-7b65-4be7-8173-de68e9e0f8ba'::uuid),  -- GA HD175 John LaHood
      ('13576393-c603-4866-a490-d694b68f7344'::uuid, 'd05acca7-f343-424b-bfae-01bae504c3c4'::uuid),  -- GA SD21 Kori Simmons
      ('2009c276-69cb-46bb-b60f-4de45b4bca6b'::uuid, 'b38404e8-4937-40aa-a09d-d043b0f43cd0'::uuid),  -- OH HD55 Michelle Teska
      ('6e5a7f19-4f3c-43d1-9de1-680a33751cf4'::uuid, '2660e3ad-1991-49fe-8920-20b4cd3cceae'::uuid),  -- OH HD47 Diane Mullins
      ('786efab9-c139-4003-8fbd-ebf1460aa1d8'::uuid, 'd964648d-3ee4-492e-89e8-bf7136e6bce8'::uuid)   -- OH HD98 Scott Grund
    ) as t(bare_id, money_id)
  loop
    select id, name, slug, status, filer_refs into b from public.cf_candidates where id = pair.bare_id;
    if not found then
      continue;  -- already merged
    end if;
    if b.filer_refs <> '[]'::jsonb
       or exists (select 1 from public.cf_contributions x where x.candidate_id = pair.bare_id)
       or exists (select 1 from public.cf_expenditures x where x.candidate_id = pair.bare_id)
       or exists (select 1 from public.cf_loans x where x.candidate_id = pair.bare_id)
       or exists (select 1 from public.cf_independent_expenditures x where x.target_candidate_id = pair.bare_id) then
      raise exception '% has money or refs; merge by hand', b.name;
    end if;
    if not exists (select 1 from public.cf_candidates where id = pair.money_id) then
      raise exception 'money row % for % is missing', pair.money_id, b.name;
    end if;

    insert into public.cf_candidates_backup_20261019
    select c.* from public.cf_candidates c
     where c.id in (pair.bare_id, pair.money_id)
       and not exists (select 1 from public.cf_candidates_backup_20261019 k where k.id = c.id);

    delete from public.cf_candidates where id = pair.bare_id;
    update public.cf_candidates
       set name = b.name, slug = b.slug, status = b.status, updated_at = now()
     where id = pair.money_id;
    merged := merged + 1;
  end loop;
  raise notice 'merged % pairs', merged;
end $$;

-- Check: six rows, each with its committee in filer_refs.
select state, office, district, name, status, filer_refs
  from public.cf_candidates
 where slug in ('don-parsons-ga-hd44', 'john-lahood-ga-hd175', 'kori-simmons-ga-sd21',
                'michelle-teska-oh-hd55', 'diane-mullins-oh-hd47', 'scott-grund-oh-hd98')
 order by state, district;

-- Then: select public.refresh_cf_finance_views();
