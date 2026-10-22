-- The "Top employers" panel (useTopIndustries in src/hooks/useCandidates.ts)
-- asks, per candidate, for the 5,000 largest gifts that carry an employer:
--
--   where candidate_id = $1 and employer is not null
--   order by amount desc limit 5000
--
-- idx_cf_contributions_candidate_amount (candidate_id, amount desc) gives the
-- order, but not the employer filter, so Postgres walks the candidate's gifts
-- largest first and fetches every row from the table to test employer. When
-- most of a candidate's rows have no employer (entity gifts, California's
-- unitemized lines, ...) it reads most of the candidate: hundreds of
-- thousands of rows for a statewide candidate, which runs past the site's
-- anon statement timeout (3 s) on a cold cache. Seen in the Postgres logs
-- on 2026-10-20 (sql state 57014).
--
-- This partial index holds only gifts that have an employer, largest first
-- per candidate, and carries employer in the index (INCLUDE), so the same
-- query reads the first 5,000 entries and can skip the table. PostgREST sends
-- `NOT employer IS NULL`, which Postgres treats as `employer IS NOT NULL`,
-- the index's predicate.
--
-- CONCURRENTLY, so the build never blocks the nightly loads; it can't run in
-- a transaction, so paste this one statement on its own into the SQL editor.
-- It is a one-time build over the table's rows that have an employer.
--
-- Check afterwards, as anon, in a rolled-back transaction (use a big
-- candidate's id; Index Only Scan on this index is what you want to see):
--   begin; set local role anon;
--   explain (analyze, buffers)
--     select employer, amount from public.cf_contributions
--      where candidate_id = '<candidate id>' and employer is not null
--      order by amount desc limit 5000;
--   rollback;
--
-- Not yet applied.

create index concurrently if not exists cf_contributions_employer_by_amount
  on public.cf_contributions (candidate_id, amount desc)
  include (employer)
  where employer is not null;
