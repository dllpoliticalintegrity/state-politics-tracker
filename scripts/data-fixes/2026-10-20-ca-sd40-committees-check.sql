-- Read-only check for 2026-10-20-ca-sd40-committees.sql. Writes nothing, makes
-- no tables. Every table query filters on candidate_id (indexed), so none of
-- them scans a whole table. Run before the fix (shows the problem) and after
-- it (shows the result).
--
-- Before the fix expect:
--   candidates : Elliott filer_refs ["ca:741949"], Bruce-Lane []
--   links      : Elliott committee_filer_id 741949, Bruce-Lane no row
--   money      : every Elliott row under committee 741949 (ca:741949), none for Bruce-Lane
-- After the fix and the next import + publish expect:
--   candidates : Elliott ["ca:1483627"], Bruce-Lane ["ca:1477126"]
--   links      : 1483628 / 1483627 and 1439276 / 1477126
--   money      : Elliott under 1483627 only, Bruce-Lane under 1477126 only,
--                nothing under 741949.

with ids(slug, id) as (
  values ('mara-elliott-ca-sd40',          'e3d77ed2-7dad-4321-ac8d-28a6d8db4eda'::uuid),
         ('kristie-bruce-lane-ca-sd40',    '5a5e3227-71f2-43a9-9385-6fb3eeb61aa7'::uuid)
)
-- 1. candidates and their committee links
select 'candidates' as what, c.slug, c.filer_refs::text as detail, null::bigint as n, null::numeric as amount
  from public.cf_candidates c join ids on ids.id = c.id
union all
select 'links', ids.slug,
       coalesce(f.candidate_filer_id::text, '-') || ' / ' || coalesce(f.committee_filer_id::text, '-'),
       null, null
  from ids left join public.ca_candidate_filers f on f.candidate_id = ids.id
-- 2. published money, by committee
union all
select 'cf_contributions', ids.slug, x.committee_id, count(*), sum(x.amount)
  from ids join public.cf_contributions x on x.candidate_id = ids.id
 group by ids.slug, x.committee_id
union all
select 'cf_expenditures', ids.slug, x.committee_id, count(*), sum(x.amount)
  from ids join public.cf_expenditures x on x.candidate_id = ids.id
 group by ids.slug, x.committee_id
union all
select 'cf_loans', ids.slug, x.committee_id, count(*), sum(x.amount)
  from ids join public.cf_loans x on x.candidate_id = ids.id
 group by ids.slug, x.committee_id
-- 3. staging, by committee
union all
select 'ca_contributions', ids.slug, x.committee_filer_id::text, count(*), sum(x.amount)
  from ids join public.ca_contributions x on x.candidate_id = ids.id
 group by ids.slug, x.committee_filer_id
union all
select 'ca_expenditures', ids.slug, x.committee_filer_id::text, count(*), sum(x.amount)
  from ids join public.ca_expenditures x on x.candidate_id = ids.id
 group by ids.slug, x.committee_filer_id
union all
select 'ca_loans', ids.slug, x.committee_filer_id::text, count(*), sum(x.amount_received)
  from ids join public.ca_loans x on x.candidate_id = ids.id
 group by ids.slug, x.committee_filer_id
-- 4. would the fix be refused? (any other candidate holding these filer ids;
--    ca_candidate_filers is small and has unique indexes on both columns)
union all
select 'conflict', c.slug, f.candidate_filer_id::text || ' / ' || coalesce(f.committee_filer_id::text, '-'), null, null
  from public.ca_candidate_filers f
  join public.cf_candidates c on c.id = f.candidate_id
 where f.candidate_id not in (select id from ids)
   and (f.candidate_filer_id in (1483628, 1439276)
     or f.committee_filer_id in (1483627, 1477126))
order by 1, 2, 3;
