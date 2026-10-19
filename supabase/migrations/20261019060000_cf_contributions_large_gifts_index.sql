-- The "Latest gifts" ticker (src/hooks/useLatestContributions.ts) asks, per
-- candidate, for the 20 newest gifts of $30,000 or more. Run as the site's
-- anon role, Postgres walked the candidate's whole (candidate_id,
-- contribution_date) index and filtered on amount -- 251,838 rows for Greg
-- Abbott -- which took 0.25 s warm and over anon's 3 s statement timeout cold,
-- so the ticker intermittently 500'd. This partial index holds only the large
-- gifts, newest first per candidate: the same query reads 20 index entries
-- (0.09 ms, checked as anon in a rolled-back transaction on 2026-10-19).
-- Legislative-district tickers use a $1,000 floor and keep the existing
-- (candidate_id, amount) index; their candidates have far fewer rows.
--
-- CONCURRENTLY, so the build never blocks the nightly loads; it can't run in
-- a transaction, so paste this one statement on its own into the SQL editor.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase SQL editor.

create index concurrently if not exists cf_contributions_large_by_date
  on public.cf_contributions (candidate_id, contribution_date desc)
  where amount >= 30000 and contribution_date is not null;
