-- Funding sources per candidate, for the race page's "Funding Sources" donut.
--
-- Every cf_contributions row (the table cf_contributions_summary sums, so the
-- categories add up to the page's "Raised" figure) falls into one category:
--   individuals  INDIVIDUAL rows, plus untyped rows (unitemized small-dollar
--                aggregates, which are individuals' money)
--   self         the candidate's own money: an individual gift whose surname
--                matches the candidate's and whose first initial agrees, or an
--                organization named for the candidate (their own committee or
--                an earlier campaign account: "Jesse Gabriel for Assembly 2024")
--   public       public financing grants (Connecticut's Citizens' Election
--                Program, Arizona/Maine clean elections, Florida matching funds)
--   party        party organizations and caucus campaign committees
--   pac          PACs and other political committees
--   other        every other organization (businesses, unions, banks, …)
-- Names are free text from each state's filings, so this is a heuristic on
-- the organization's name, applied the same way in every state.
--
-- A materialised view (the regexes over ~5M rows would be too slow per page
-- view), refreshed with the other cf_* views by refresh_cf_finance_views().
-- Public-record aggregates: anon SELECT, like cf_contributions_summary.
--
-- Created WITH NO DATA (the first build scans every contribution, longer than
-- a migration call should run); populate it once with a plain
-- `refresh materialized view public.cf_funding_sources;` (CONCURRENTLY needs a
-- populated view), after which the nightly refresh keeps it current.
--
-- Also locks down refresh_cf_finance_views() and refresh_tx_finance_views():
-- both were executable by anon and authenticated (Postgres' default PUBLIC
-- grant), so anyone holding the public key could start minutes-long
-- SECURITY DEFINER rebuilds. Every caller uses the service role (the sync
-- workflows, the pilot importer) or runs as postgres (pg_cron).
--
-- Applied to the tracker project (lohxdfrxnxuxjdvvyfjc) via the Supabase MCP.

create or replace function public.cf_funding_category(
  contributor_type text,
  contributor_last_name text,
  contributor_first_name text,
  candidate_name text
) returns text
language plpgsql
immutable
parallel safe
set search_path = public
as $$
declare
  words text[];
  c_first text;
  c_last text;
  org text := lower(coalesce(contributor_last_name, ''));
  esc_first text;
  esc_last text;
begin
  if contributor_type is null then
    return 'individuals';
  end if;

  words := regexp_split_to_array(
    btrim(regexp_replace(lower(coalesce(candidate_name, '')), '[,.]|\s+(jr|sr|ii|iii|iv)$', '', 'g')),
    '\s+');
  c_first := words[1];
  c_last := words[array_length(words, 1)];

  if contributor_type = 'INDIVIDUAL' then
    if c_last <> '' and lower(btrim(coalesce(contributor_last_name, ''))) = c_last
       and left(lower(btrim(coalesce(contributor_first_name, ''))), 1) = left(c_first, 1) then
      return 'self';
    end if;
    return 'individuals';
  end if;

  -- Organizations. Escape regex metacharacters in the candidate's names.
  esc_first := regexp_replace(coalesce(c_first, ''), '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
  esc_last := regexp_replace(coalesce(c_last, ''), '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
  if length(c_last) >= 2 and org ~ ('\m' || esc_last || '\M')
     and (org ~ ('\m' || esc_first || '\M') or org ~ '\m(for|elect|campaign)\M') then
    return 'self';
  end if;
  if org ~ '(public grant|clean elections?|election program|matching funds?|public financ|department of financial services|^state of [a-z ]+$)' then
    return 'public';
  end if;
  if org ~ '\m(party|caucus)\M'
     or (org ~ '\m(democratic|democrats?|republicans?|gop|dem|rep)\M'
         and org ~ '\m(committee|comm|com|senate|senatorial|house|assembly|governors|legislative)\M') then
    return 'party';
  end if;
  if org ~ '\m(pac|political action|committee|comm|cmte|fund|for|campaign|friends of|elect|citizens|victory|majority|leadership|action|alliance|coalition)\M' then
    return 'pac';
  end if;
  return 'other';
end;
$$;

drop materialized view if exists public.cf_funding_sources;
create materialized view public.cf_funding_sources as
select
  x.candidate_id,
  c.state as race_state,
  c.office,
  c.district,
  public.cf_funding_category(x.contributor_type, x.contributor_last_name, x.contributor_first_name, c.name) as category,
  coalesce(sum(x.amount), 0)::numeric as amount,
  count(*)::int as contribution_count
from public.cf_contributions x
join public.cf_candidates c on c.id = x.candidate_id
group by 1, 2, 3, 4, 5
with no data;

-- Unique index required for `refresh ... concurrently`.
create unique index cf_funding_sources_pk on public.cf_funding_sources (candidate_id, category);
create index cf_funding_sources_race_idx on public.cf_funding_sources (race_state, office);

grant select on public.cf_funding_sources to anon, authenticated, service_role;

create or replace function public.refresh_cf_finance_views()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '10min'
as $$
begin
  refresh materialized view concurrently public.cf_contributions_summary;
  refresh materialized view concurrently public.cf_expenditures_summary;
  refresh materialized view concurrently public.cf_top_donors;
  refresh materialized view concurrently public.cf_ie_by_candidate;
  refresh materialized view concurrently public.cf_top_ie_donors;
  refresh materialized view concurrently public.cf_committee_donors;
  refresh materialized view concurrently public.cf_funding_sources;
end;
$$;

-- Lock-downs (see header). The classifier is only needed by the view's
-- owner; the refreshes only by the service role and pg_cron.
revoke execute on function public.cf_funding_category(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.refresh_cf_finance_views() from public, anon, authenticated;
grant execute on function public.refresh_cf_finance_views() to service_role;
revoke execute on function public.refresh_tx_finance_views() from public, anon, authenticated;
grant execute on function public.refresh_tx_finance_views() to service_role;
