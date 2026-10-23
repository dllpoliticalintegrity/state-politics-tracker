-- Money → River, one page at a time without reading the whole race.
--
-- The hub's river read the cf_money_river view with
--   order by txn_date desc nulls last, imported_at desc, id  limit 50
-- plus count(exact). A view that unions four tables can't be read in that
-- order from an index, so Postgres produced every row of the race and
-- top-N-sorted them: 278,444 rows (272,759 of them contributions) for the six
-- Arizona governor candidates, 639 ms with every page cached, over anon's 3 s
-- statement timeout on a cold cache (EXPLAIN ANALYZE on 2026-10-21). The
-- count repeats the scan.
--
-- cf_money_river_page() returns the same rows in the same order, for one race,
-- by reading only the newest (offset + limit) rows of each candidate from each
-- of the four tables, through the existing (candidate, date desc) indexes, and
-- sorting that handful:
--   cf_contributions            idx_cf_contributions_candidate_date
--   cf_expenditures             idx_cf_expenditures_candidate_date
--   cf_independent_expenditures idx_cf_ie_target_date
--   cf_loans                    idx_cf_loans_candidate
-- A row in the race's top (offset + limit) is always within the top
-- (offset + limit) of its own candidate and table, because every branch uses
-- the page's full ordering (date desc, created_at desc, id), so the result is
-- exactly the view's. Undated rows sort last, as before: they are read from
-- each table separately (the dated index is "nulls first" for desc, which
-- doesn't match nulls last), and only matter once the dated rows run out.
--
-- No total: the caller asks for one more row than it shows to know whether
-- there is a next page. Deep pages cost more than page 1 (offset + limit rows
-- per candidate per table), but nothing like the whole race.
--
-- Same columns as cf_money_river (see 20261007150000_texas_into_cf.sql); keep
-- the two in step. Runs as the caller (anon), so it sees what the view saw.
--
-- Not yet applied. Apply in the SQL editor, then run the check at the bottom.

create or replace function public.cf_money_river_page(
  p_state text,
  p_office text,
  p_district text default null,
  p_kind text default null,          -- contribution | expenditure | outside | loan; null = all
  p_candidate uuid default null,
  p_limit int default 50,            -- clamped to 1..200
  p_offset int default 0
)
returns table (
  kind text, id uuid, txn_date date, amount numeric, candidate_id uuid,
  candidate_slug text, candidate_name text, candidate_party text,
  state text, office text, district text,
  counterparty text, counterparty_type text, detail text, support_oppose text,
  cycle text, imported_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with lim as (
    select least(greatest(coalesce(p_limit, 50), 1), 200) as page,
           greatest(coalesce(p_offset, 0), 0) as skip
  ),
  need as (
    select page + skip as n from lim
  ),
  cands as (
    select k.id, k.slug, k.name, k.party, k.state, k.office, k.district
      from public.cf_candidates k
     where k.state = p_state
       and k.office = p_office
       and (p_district is null or k.district = p_district)
       and (p_candidate is null or k.id = p_candidate)
  )
  select r.*
  from (
    -- Contributions
    select 'contribution'::text, c.id, c.contribution_date, c.amount, c.candidate_id,
           k.slug, k.name, k.party, k.state, k.office, k.district,
           case
             when c.contributor_type = 'INDIVIDUAL'
               then nullif(trim(concat_ws(' ', nullif(c.contributor_first_name, ''), nullif(c.contributor_last_name, ''))), '')
             else coalesce(nullif(c.contributor_last_name, ''), nullif(c.contributor_first_name, ''))
           end,
           nullif(c.contributor_type, ''),
           nullif(concat_ws(' · ', nullif(c.employer, ''), nullif(c.city, ''), nullif(c.state, '')), ''),
           null::text, c.cycle, c.created_at
      from cands k
     cross join lateral (
       (select x.* from public.cf_contributions x
         where x.candidate_id = k.id and x.contribution_date is not null
         order by x.contribution_date desc, x.created_at desc, x.id
         limit (select n from need))
       union all
       (select x.* from public.cf_contributions x
         where x.candidate_id = k.id and x.contribution_date is null
         order by x.created_at desc, x.id
         limit (select n from need))
     ) c
     where p_kind is null or p_kind = 'contribution'

    union all
    -- Expenditures
    select 'expenditure'::text, e.id, e.expenditure_date, e.amount, e.candidate_id,
           k.slug, k.name, k.party, k.state, k.office, k.district,
           case
             when e.payee_type = 'INDIVIDUAL'
               then nullif(trim(concat_ws(' ', nullif(e.payee_first_name, ''), nullif(e.payee_last_name, ''))), '')
             else coalesce(nullif(e.payee_last_name, ''), nullif(e.payee_first_name, ''))
           end,
           nullif(e.payee_type, ''),
           nullif(concat_ws(' · ', nullif(e.description, ''), nullif(e.category, ''), nullif(e.payee_city, '')), ''),
           null::text, e.cycle, e.created_at
      from cands k
     cross join lateral (
       (select x.* from public.cf_expenditures x
         where x.candidate_id = k.id and x.expenditure_date is not null
         order by x.expenditure_date desc, x.created_at desc, x.id
         limit (select n from need))
       union all
       (select x.* from public.cf_expenditures x
         where x.candidate_id = k.id and x.expenditure_date is null
         order by x.created_at desc, x.id
         limit (select n from need))
     ) e
     where p_kind is null or p_kind = 'expenditure'

    union all
    -- Loans (a few rows per candidate; no date index needed)
    select 'loan'::text, l.id, l.loan_date, l.amount, l.candidate_id,
           k.slug, k.name, k.party, k.state, k.office, k.district,
           case
             when l.lender_type = 'INDIVIDUAL'
               then nullif(trim(concat_ws(' ', nullif(l.lender_first_name, ''), nullif(l.lender_last_name, ''))), '')
             else coalesce(nullif(l.lender_last_name, ''), nullif(l.lender_first_name, ''))
           end,
           nullif(l.lender_type, ''),
           case when l.is_guarantor then 'Guarantor' end,
           null::text, l.cycle, l.created_at
      from cands k
     cross join lateral (
       (select x.* from public.cf_loans x
         where x.candidate_id = k.id and x.loan_date is not null
         order by x.loan_date desc, x.created_at desc, x.id
         limit (select n from need))
       union all
       (select x.* from public.cf_loans x
         where x.candidate_id = k.id and x.loan_date is null
         order by x.created_at desc, x.id
         limit (select n from need))
     ) l
     where p_kind is null or p_kind = 'loan'

    union all
    -- Outside spending
    select 'outside'::text, i.id, i.expenditure_date, i.amount, i.target_candidate_id,
           k.slug, k.name, k.party, k.state, k.office, k.district,
           coalesce(nullif(m.name, ''), i.ie_filer_ident),
           'COMMITTEE'::text,
           nullif(i.description, ''),
           i.support_oppose, i.cycle, i.created_at
      from cands k
     cross join lateral (
       (select x.* from public.cf_independent_expenditures x
         where x.target_candidate_id = k.id and x.expenditure_date is not null
         order by x.expenditure_date desc, x.created_at desc, x.id
         limit (select n from need))
       union all
       (select x.* from public.cf_independent_expenditures x
         where x.target_candidate_id = k.id and x.expenditure_date is null
         order by x.created_at desc, x.id
         limit (select n from need))
     ) i
     left join public.cf_ie_committees m on m.filer_ident = i.ie_filer_ident
     where p_kind is null or p_kind = 'outside'
  ) r (kind, id, txn_date, amount, candidate_id, candidate_slug, candidate_name,
       candidate_party, state, office, district, counterparty, counterparty_type,
       detail, support_oppose, cycle, imported_at)
  order by r.txn_date desc nulls last, r.imported_at desc, r.id
  limit (select page from lim) offset (select skip from lim)
$$;

grant execute on function public.cf_money_river_page(text, text, text, text, uuid, int, int)
  to anon, authenticated, service_role;

-- Check, as anon, in a rolled-back transaction. Expect: Append of Index Scans
-- (idx_cf_contributions_candidate_date etc., each with a LIMIT), a few hundred
-- rows into the final Sort, and a few ms. Compare the first page with the old
-- view's:
--   begin; set local role anon;
--   explain (analyze, buffers)
--     select * from public.cf_money_river_page('az', 'governor', null, null, null, 51, 0);
--   -- same 50 rows, same order as:
--   select kind, id from public.cf_money_river
--    where state = 'az' and office = 'governor'
--    order by txn_date desc nulls last, imported_at desc, id limit 50;
--   select kind, id from public.cf_money_river_page('az', 'governor', null, null, null, 50, 0);
--   -- page 3 too:
--   select kind, id from public.cf_money_river_page('az', 'governor', null, null, null, 50, 100);
--   rollback;
