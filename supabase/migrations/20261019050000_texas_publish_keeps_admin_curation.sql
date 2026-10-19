-- publish_texas_to_cf(): stop overwriting what the admin console curates on
-- Texas candidates.
--
-- Texas candidates are edited in the admin console's State Politics Tracker
-- page, which writes cf_candidates directly (spt-tracker-admin; the old
-- /tx-politics-tracker page redirects there). The nightly publish then copied
-- every tx_candidates column over cf_candidates, so a headshot, bio or link
-- added in the admin was erased at 14:30 UTC the same day (tx_candidates held
-- only 10 photos).
--
-- Presentation fields now keep the cf_candidates value and take
-- tx_candidates' only to fill a blank: title, bio, photo_url and its sizes,
-- website, the social handles, and featured (featured is never null, so the
-- admin's value always stands). Roster and finance fields (office, district,
-- slug, name, party, filer_refs, committee_name, election_year, status) still
-- publish from tx_candidates as before. Inserts of new candidates are
-- unchanged.
--
-- Patched in place like 20261018230000_texas_legislature.sql; guarded so
-- re-running is a no-op.
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase SQL editor.

do $migration$
declare
  d text := pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure);
  head text := 'on conflict (id) do update set';
  tail text := 'get diagnostics n_cand = row_count;';
  i int;
  j int;
  new_block text := $b$on conflict (id) do update set
    -- curated in the admin console: cf_candidates wins, tx only fills blanks
    office = excluded.office, district = excluded.district, slug = excluded.slug, name = excluded.name,
    party = excluded.party, filer_refs = excluded.filer_refs,
    committee_name = excluded.committee_name,
    election_year = excluded.election_year, status = excluded.status,
    title = coalesce(k.title, excluded.title),
    bio = coalesce(k.bio, excluded.bio),
    photo_url = coalesce(k.photo_url, excluded.photo_url),
    photo_url_large = coalesce(k.photo_url_large, excluded.photo_url_large),
    photo_url_medium = coalesce(k.photo_url_medium, excluded.photo_url_medium),
    photo_url_thumb = coalesce(k.photo_url_thumb, excluded.photo_url_thumb),
    website = coalesce(k.website, excluded.website),
    twitter_user = coalesce(k.twitter_user, excluded.twitter_user),
    instagram_user = coalesce(k.instagram_user, excluded.instagram_user),
    facebook_user = coalesce(k.facebook_user, excluded.facebook_user),
    youtube_user = coalesce(k.youtube_user, excluded.youtube_user),
    featured = k.featured,
    updated_at = now()
  where k.state = 'tx'
    and ((k.office, k.district, k.slug, k.name, k.party, k.filer_refs, k.committee_name,
          k.election_year, k.status)
         is distinct from
         (excluded.office, excluded.district, excluded.slug, excluded.name, excluded.party,
          excluded.filer_refs, excluded.committee_name, excluded.election_year, excluded.status)
      or (k.title, k.bio, k.photo_url, k.photo_url_large, k.photo_url_medium, k.photo_url_thumb,
          k.website, k.twitter_user, k.instagram_user, k.facebook_user, k.youtube_user)
         is distinct from
         (coalesce(k.title, excluded.title), coalesce(k.bio, excluded.bio),
          coalesce(k.photo_url, excluded.photo_url), coalesce(k.photo_url_large, excluded.photo_url_large),
          coalesce(k.photo_url_medium, excluded.photo_url_medium), coalesce(k.photo_url_thumb, excluded.photo_url_thumb),
          coalesce(k.website, excluded.website), coalesce(k.twitter_user, excluded.twitter_user),
          coalesce(k.instagram_user, excluded.instagram_user), coalesce(k.facebook_user, excluded.facebook_user),
          coalesce(k.youtube_user, excluded.youtube_user)));
  $b$;
begin
  if position('curated in the admin console' in d) > 0 then
    return;  -- already patched
  end if;
  i := position(head in d);
  j := position(tail in d);
  if i = 0 or j = 0 or j < i then
    raise exception 'publish_texas_to_cf: candidate upsert block not found';
  end if;
  d := substring(d from 1 for i - 1) || new_block || substring(d from j);
  execute d;
  if position('curated in the admin console' in pg_get_functiondef('public.publish_texas_to_cf()'::regprocedure)) = 0 then
    raise exception 'publish_texas_to_cf patch did not apply';
  end if;
end
$migration$;
