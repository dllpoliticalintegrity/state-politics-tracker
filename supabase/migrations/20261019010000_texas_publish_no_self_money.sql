-- publish_texas_to_cf() stops publishing two kinds of a candidate's own money
-- as if it came from someone else:
--
--  1. Transfers between a candidate's own two TEC filers. Greg Abbott's
--     candidate filer (19652) received $4.75M from his committee "Texans for
--     Greg Abbott" (51153), whose own receipts are already counted; Dan
--     Patrick's 57897 received $300K from "Texans for Dan Patrick" (64090).
--     Both filers are in the candidate's filer_refs, so the same dollars
--     were counted twice in "Raised". TEC records no contributor filer id,
--     so a transfer is recognised by the contributor name matching the
--     candidate's own committee name.
--  2. Direct campaign expenditures where the spender is the target's own
--     filer (167 rows, $79K in Oct 2026): a candidate's own spending, not
--     outside spending.
--
-- Both filters go in the delete and the insert, so the next nightly publish
-- removes the rows already in cf_*. Patched in place like
-- 20261018230000_texas_legislature.sql; each edit is guarded so re-running
-- is a no-op.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

do $migration$
declare
  d text := pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure);
  own_transfer text := $f$
          and not exists (
            select 1 from public.tx_candidates oc
             where oc.id = t.candidate_id and oc.committee_name <> ''
               and coalesce(t.contributor_type, '') <> 'INDIVIDUAL'
               and lower(regexp_replace(t.contributor_last_name, '[^a-zA-Z0-9]', '', 'g'))
                 = lower(regexp_replace(oc.committee_name, '[^a-zA-Z0-9]', '', 'g')))$f$;
  self_ie text := $f$
          and not exists (
            select 1 from public.tx_candidates oc
             where oc.id = t.target_candidate_id
               and t.ie_filer_ident in (oc.filer_ident, oc.committee_filer_ident))$f$;
begin
  if position('oc.committee_name' in d) = 0 then
    d := replace(d, $a$public.tx_contributions t
        where not t.rereported$a$, $a$public.tx_contributions t
        where not t.rereported$a$ || own_transfer);
    d := replace(d, $a$public.tx_contributions t
  where not t.rereported$a$, $a$public.tx_contributions t
  where not t.rereported$a$ || own_transfer);
  end if;
  if position('oc.committee_filer_ident' in d) = 0 then
    d := replace(d, $a$public.tx_independent_expenditures t
        where not t.rereported$a$, $a$public.tx_independent_expenditures t
        where not t.rereported$a$ || self_ie);
    d := replace(d, $a$public.tx_independent_expenditures t
  where not t.rereported$a$, $a$public.tx_independent_expenditures t
  where not t.rereported$a$ || self_ie);
  end if;
  execute d;
  -- All four edits must have landed.
  d := pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure);
  if (length(d) - length(replace(d, 'oc.committee_name <>', ''))) / length('oc.committee_name <>') <> 2
     or (length(d) - length(replace(d, 'oc.committee_filer_ident)', ''))) / length('oc.committee_filer_ident)') <> 2 then
    raise exception 'publish_texas_to_cf patch did not apply cleanly';
  end if;
end
$migration$;
