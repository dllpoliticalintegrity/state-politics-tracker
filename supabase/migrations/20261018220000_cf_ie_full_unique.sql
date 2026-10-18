-- Full unique indexes on (source, source_txn_id) for the outside-spending
-- tables, beside the partial ones (… WHERE source_txn_id IS NOT NULL) the
-- Texas publish infers. PostgREST's on_conflict cannot name a partial index's
-- predicate, so the SLCF loader's upserts (pipelines/load/ie.py) need these.
-- NULL source_txn_id rows are unaffected (NULLs never collide).
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

create unique index if not exists cf_ie_txn_unique_full
  on public.cf_independent_expenditures (source, source_txn_id);
create unique index if not exists cf_ie_contribs_txn_unique_full
  on public.cf_ie_contributions (source, source_txn_id);
