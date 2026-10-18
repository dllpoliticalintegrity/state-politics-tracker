-- Texas legislature: tx_candidates gains a district, and publish_texas_to_cf()
-- maps TEC's legislative office codes and the district into cf_candidates.
--
-- Legislative candidates are seeded into tx_candidates from the Local
-- Politics Tracker by pipelines/load/roster.py --texas (tx-finance-sync.yml,
-- before the TEC import), with office STATESEN / STATEREP. The importer then
-- loads their money like any seeded filer, and the nightly publish copies
-- them to cf_* with office state-senate / state-house and their district.
--
-- The function body is patched in place rather than restated (it is ~14 KB,
-- defined in 20261007150000_texas_into_cf.sql): four textual edits, each
-- guarded so re-running this migration is a no-op.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

alter table public.tx_candidates add column if not exists district text;

do $migration$
declare
  d text := pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure);
begin
  if position('''STATESEN''' in d) = 0 then
    d := replace(d,
      $a$else lower(t.office)$a$,
      $a$when 'STATESEN' then 'state-senate'
      when 'STATEREP' then 'state-house'
      else lower(t.office)$a$);
  end if;
  d := replace(d, 'null, t.slug, t.name, t.party,', 't.district, t.slug, t.name, t.party,');
  if position('district = excluded.district' in d) = 0 then
    d := replace(d, 'office = excluded.office,', 'office = excluded.office, district = excluded.district,');
  end if;
  d := replace(d, 'and (k.office, k.slug,', 'and (k.office, k.district, k.slug,');
  d := replace(d, '(excluded.office, excluded.slug', '(excluded.office, excluded.district, excluded.slug');
  execute d;
end
$migration$;
