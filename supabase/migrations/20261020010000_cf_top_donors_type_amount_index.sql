-- The candidate page's "Top PAC & committee donors" list asks cf_top_donors
-- for one candidate's ENTITY rows by total, up to 501 (useTopDonors, kind
-- "pac"). Postgres takes the (candidate_id, total_amount desc) index and
-- filters on contributor_type, so for a candidate with few organisation
-- donors among many individuals it reads every row the candidate has before
-- it runs out: Amy Acton has ~539k donor rows and only a few hundred ENTITY ones, and the
-- query passed anon's 3 s statement timeout, so her PAC list showed "No PAC
-- contributions yet" (2026-10-20). With contributor_type in the index ahead
-- of the amount, the same query reads only the candidate's ENTITY rows, in
-- order. The existing (candidate_id, contributor_type) index is a prefix of
-- this one and could be dropped later.
--
-- CONCURRENTLY, so the build never blocks reads or the nightly refresh (a
-- materialized view's indexes survive REFRESH ... CONCURRENTLY); it can't run
-- in a transaction, so paste this one statement on its own into the SQL editor.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase SQL editor.

create index concurrently if not exists cf_top_donors_candidate_type_amount_idx
  on public.cf_top_donors (candidate_id, contributor_type, total_amount desc);
