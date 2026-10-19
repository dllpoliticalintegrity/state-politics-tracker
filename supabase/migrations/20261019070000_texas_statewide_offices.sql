-- Texas statewide races beyond Governor / Lt. Governor / Attorney General:
-- publish_texas_to_cf() maps TEC's office codes for Comptroller, Land
-- Commissioner, Agriculture Commissioner and Railroad Commissioner to the
-- site's office segments.
--
-- Their candidates are seeded into tx_candidates from the Local Politics
-- Tracker by pipelines/load/roster.py --texas (sync_texas_statewide), with
-- office COMPTROLLER / LANDCOMM / AGRICULTUR / RRCOMM. Without this mapping the
-- publish's `else lower(t.office)` would write "landcomm", "agricultur" and
-- "rrcomm", which match no race on the site.
--
-- The function body is patched in place, like 20261018230000_texas_legislature.sql;
-- guarded so re-running is a no-op.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Management API
-- on 2026-10-18, before 20261019010000_texas_publish_no_self_money and
-- 20261019050000_texas_publish_keeps_admin_curation; both patch the function in
-- place and leave these four cases intact.

do $migration$
declare
  d text := pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure);
begin
  if position('''LANDCOMM''' in d) = 0 then
    d := replace(d,
      $a$when 'STATESEN' then 'state-senate'$a$,
      $a$when 'COMPTROLLER' then 'comptroller'
      when 'LANDCOMM' then 'land-commissioner'
      when 'AGRICULTUR' then 'agriculture-commissioner'
      when 'RRCOMM' then 'railroad-commissioner'
      when 'STATESEN' then 'state-senate'$a$);
    if position('''LANDCOMM''' in d) = 0 then
      raise exception 'publish_texas_to_cf(): office case not found; patch by hand';
    end if;
    execute d;
  end if;
end
$migration$;
