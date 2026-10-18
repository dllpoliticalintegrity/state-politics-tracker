// Edge function: import FiftyPlusOne governor polls for every live race into
// race_polls (source='fiftyplusone'), plus a top-2 general-election aggregate
// per race into race_polling. The site's only polling importer since Oct 2026:
// it replaced the 270toWin scrape (import-towin-polling-multi) for every state
// and Texas's single-race import-fiftyplusone-polling. polling-sync.yml calls
// it every 6 hours.
//
// Reads FiftyPlusOne's DOCUMENTED CSV API (https://fiftyplusone.news/api/csv),
// the supported, API-keyed feed described at https://fiftyplusone.news/readme.
// Two files cover every state: governor_general (the general-election
// matchups that feed the charts and the average) and governor_primary (kept
// for the Polling page's poll list, tagged dem_primary / rep_primary, or
// primary for California's top-two and Alaska's top-four). Each is fetched
// once per run and split by the feed's own state / office_type / cycle columns.
//
// NOTE ON FRESHNESS: the CSV export regenerates on a slower cadence than
// FiftyPlusOne's live site -- its newest poll can lag the site by a few days.
// That is a known issue on FiftyPlusOne's side. The undocumented /api/polls
// JSON endpoint is fresher but unsupported and IP-throttled; this importer
// intentionally uses the supported CSV feed.
//
// RESOLUTION: each feed candidate is resolved within the race's cf_candidates
// roster (cleaned full-name match, then unique last-name match). Matching
// against our filed roster is deliberate: it drops FiftyPlusOne's hypothetical
// ("what if X ran") names, which are not candidates in our DB. Unresolved
// general-election names are reported per race and persisted to
// public.poll_import_unmatched under source 'fiftyplusone' (primary polls name
// many minor candidates we don't file; they are not reported).
//
// POST body {} imports every race; { "slugs": ["florida-governor-2026"] }
// restricts to a subset. Response reports per-race results and returns 500
// if any race failed.
// build-tag: fiftyplusone-multi-v4

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SOURCE = "fiftyplusone";
const UNMATCHED_SOURCE = "fiftyplusone";
const CSV_BASE = "https://fiftyplusone.news/api/csv";
const GENERAL_FILE = "governor_general";
const PRIMARY_FILE = "governor_primary";
const PAGE_BASE = "https://fiftyplusone.news/polls/governor/general";
const FEED_OFFICE = "Governor";
const FIELD_CUTOFF_DAYS = 540; // ~full 2026 cycle of polling
const FETCH_TIMEOUT_MS = 60000;

// Read-only data API key. Prefer the FIFTYPLUSONE_API_KEY secret; fall back to
// the known publishable key so the function runs without extra config.
const API_KEY = Deno.env.get("FIFTYPLUSONE_API_KEY") || "rRIQeP7129VVXKuzKWjklA";

type Race = {
  slug: string;
  state: string;
  office: string;
  feedState: string;
  cycle: string;
  pageUrl: string;
};

function gov(state: string, feedState: string, cycle = "2026"): Race {
  const key = feedState.toLowerCase().replace(/ /g, "-");
  return {
    slug: `${key}-governor-${cycle}`,
    state,
    office: "governor",
    feedState,
    cycle,
    pageUrl: `${PAGE_BASE}/${key}`,
  };
}

// Every live governor race. The site shows a race's polling once
// src/states/registry.ts gives it a pollingSourceUrl (the FiftyPlusOne page);
// races the feed has no general-election polls for yet (CO, HI, KY as of Oct
// 2026) are imported anyway, so their rows are ready when polls appear.
const RACES: Race[] = [
  gov("fl", "Florida"),
  gov("mi", "Michigan"),
  gov("ga", "Georgia"),
  gov("az", "Arizona"),
  gov("me", "Maine"),
  gov("pa", "Pennsylvania"),
  gov("ma", "Massachusetts"),
  gov("mn", "Minnesota"),
  gov("ia", "Iowa"),
  gov("oh", "Ohio"),
  gov("wi", "Wisconsin"),
  gov("nv", "Nevada"),
  gov("al", "Alabama"),
  gov("ak", "Alaska"),
  gov("ct", "Connecticut"),
  gov("tx", "Texas"),
  gov("ca", "California"),
  gov("md", "Maryland"),
  gov("ar", "Arkansas"),
  gov("id", "Idaho"),
  gov("il", "Illinois"),
  gov("ks", "Kansas"),
  gov("co", "Colorado"),
  gov("hi", "Hawaii"),
  gov("ky", "Kentucky", "2027"),
];

// Roster party (cf_candidates stores full names) -> the short codes the
// frontend badges show; anything else passes through unchanged.
const PARTY_ABBR: Record<string, string> = { Republican: "R", Democrat: "D", Independent: "I" };
// Feed party codes, used only when the roster has no party for a candidate.
const FEED_PARTY: Record<string, string> = { REP: "R", DEM: "D", IND: "I" };

// FPO `population` -> our `sample_kind` (same labels as before).
const POP_LABEL: Record<string, string> = { lv: "LV", rv: "RV", a: "All", v: "Voters" };

interface CandMeta {
  name: string;
  party: string | null;
  active: boolean;
}

// cf_candidates statuses that mean the candidate is out of the race. Their
// poll rows are kept (history for the charts), but any poll question that
// includes one of them is left out of the headline average -- those matchups
// can no longer happen, and FiftyPlusOne keeps polling hypotheticals against
// primary losers long after the primary. Mirrors INACTIVE_STATUSES in
// src/lib/candidateStatus.ts (which greys those candidates out on the site),
// plus "inactive".
const INACTIVE_STATUSES = new Set([
  "withdrawn", "dropped_out", "eliminated", "lost_primary", "disqualified", "not_on_ballot",
  "inactive",
]);

interface PollRowOut {
  race_id: string;
  candidate_name: string;
  candidate_party: string | null;
  pct: number;
  pollster: string;
  field_start: string | null;
  field_end: string;
  sample_size: number | null;
  sample_kind: string | null;
  source: string;
  source_url: string | null;
  matchup: string;
}

type CsvRow = Record<string, string>;

type Summary = { name: string; party: string | null; avg_pct: number; polls: number };

type Aggregate = {
  race_id: string;
  source: string;
  candidate_a_name: string;
  candidate_a_party: string | null;
  candidate_a_pct: number;
  candidate_b_name: string;
  candidate_b_party: string | null;
  candidate_b_pct: number;
  spread: string;
  poll_count: number;
  as_of: string;
  source_url: string;
  rcp_url: string;
  raw_data: { all_candidates: Summary[] };
  last_updated: string;
};

// Name suffixes and honorific titles, stripped wherever they appear.
const NAME_NOISE = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "mr", "mrs", "ms", "dr", "rev", "phd", "hon", "honorable", "rep", "sen",
]);

// Repair UTF-8-decoded-as-Latin1 mojibake (an accented letter read back as two
// Latin-1 characters) then fold accents to ASCII so feed and DB spellings
// compare equal.
function deAccent(s: string): string {
  let t = s;
  if (/[\u00c3\u00c2][\x80-\xBF]/.test(t)) {
    try {
      t = decodeURIComponent(escape(t));
    } catch { /* leave as-is */ }
  }
  return t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

// Tokenize a name to lowercase alpha-ish tokens, dropping suffixes/titles.
function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return deAccent(name)
    .toLowerCase()
    .replace(/[.,"'()]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_NOISE.has(t));
}

const cleanFull = (name: string | null | undefined): string => nameTokens(name).join(" ");

const lastName = (name: string | null | undefined): string => {
  const t = nameTokens(name);
  return t.length ? t[t.length - 1] : "";
};

// Primary-style stages: every question in governor_primary, none in
// governor_general. Their polls are kept for the Polling page's list only --
// the charts and the average read general matchups.
function isPrimaryStage(stage: string | null): boolean {
  const s = (stage || "").toLowerCase().trim();
  return (
    s.startsWith("primary") ||
    s === "caucus" ||
    s === "jungle primary" ||
    s === "top two primary" ||
    s === "top four primary"
  );
}

// Same matchup vocabulary the frontend's isGeneralMatchup() expects:
// general / h2h:a-b.
function classifyMatchup(candidateCount: number, candidateLasts: string[]): string {
  if (candidateCount === 2) {
    const names = candidateLasts
      .filter((n) => n)
      .map((n) => n.toLowerCase().replace(/[,.]/g, "").trim())
      .sort();
    return "h2h:" + names.join("-");
  }
  return "general";
}

// A primary question's matchup tag, which the Polling page labels: a party's
// own primary (or its runoff) -> dem_primary / rep_primary; an all-party
// primary (California's top-two, Alaska's top-four) or any other party's ->
// primary.
function primaryMatchup(stage: string | null, feedParties: string[]): string {
  const s = (stage || "").toLowerCase();
  if (/top (two|four)|jungle/.test(s)) return "primary";
  const parties = new Set(feedParties.map((p) => p.toUpperCase().trim()).filter(Boolean));
  if (parties.size === 1) {
    if (parties.has("DEM")) return "dem_primary";
    if (parties.has("REP")) return "rep_primary";
  }
  return "primary";
}

async function fetchCsv(filename: string): Promise<CsvRow[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${CSV_BASE}?api_key=${encodeURIComponent(API_KEY)}&filename=${filename}`;
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`FPO CSV ${resp.status} for ${filename}`);
    const text = await resp.text();
    return parse(text, { skipFirstRow: true }) as CsvRow[];
  } finally {
    clearTimeout(timer);
  }
}

type Unmatched = { rk: string; name: string; pct: number };

async function importRace(supabase: SupabaseClient, race: Race, feedRows: CsvRow[], unmatchedOut: Unmatched[]) {
  const { data: raceRow, error: raceErr } = await supabase
    .from("races")
    .select("race_id")
    .eq("slug", race.slug)
    .single();
  if (raceErr || !raceRow) throw new Error(`race not found: ${race.slug} ${raceErr?.message ?? ""}`);
  const race_id = raceRow.race_id as string;

  // Roster: every candidate we file for this race (any status -- early
  // general polls include since-eliminated names). Layered matching: cleaned
  // full name first, then a last name that is unique within the roster.
  const { data: cands, error: candErr } = await supabase
    .from("cf_candidates")
    .select("name,party,status")
    .eq("state", race.state)
    .eq("office", race.office);
  if (candErr) throw candErr;
  const byFullName = new Map<string, CandMeta>();
  const byLastName = new Map<string, CandMeta | null>();
  const activeNames = new Set<string>();
  for (const c of (cands ?? []) as Array<{ name: string; party: string | null; status: string | null }>) {
    const meta: CandMeta = {
      name: c.name,
      party: c.party ? (PARTY_ABBR[c.party] ?? c.party) : null,
      active: !INACTIVE_STATUSES.has((c.status ?? "").toLowerCase()),
    };
    if (meta.active) activeNames.add(c.name);
    const cf = cleanFull(c.name);
    if (cf && !byFullName.has(cf)) byFullName.set(cf, meta);
    const ln = lastName(c.name);
    if (!ln) continue;
    // First occurrence -> candidate; any later collision -> null (ambiguous).
    byLastName.set(ln, byLastName.has(ln) ? null : meta);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - FIELD_CUTOFF_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Group rows by question_id -- each question is one matchup.
  const byQuestion = new Map<string, CsvRow[]>();
  for (const r of feedRows) {
    const qid = `${r.question_id || r.poll_id}|${r.stage}`;
    const list = byQuestion.get(qid) || [];
    list.push(r);
    byQuestion.set(qid, list);
  }

  // One row per (pollster, field_end, candidate, matchup) -- the race_polls
  // unique key. A poll that asks the same matchup of several populations
  // (lv + rv) collides here; first question wins.
  const dedup = new Map<string, PollRowOut>();
  // Poll questions FiftyPlusOne flags as hypothetical (a matchup that is not
  // the actual nominee pairing), keyed like the aggregate's question key.
  const hypoQuestions = new Set<string>();
  const unresolved = new Map<string, number>();
  let questionsKept = 0;
  let newestFieldEnd = "";

  for (const qRows of byQuestion.values()) {
    const head = qRows[0];
    const isPrimary = isPrimaryStage(head.stage);
    const fieldEnd = (head.end_date || "").slice(0, 10);
    if (!fieldEnd || fieldEnd < cutoffIso) continue;

    const pollRows = qRows.filter((r) => Number.isFinite(Number(r.pct)) && r.pct !== "");
    if (pollRows.length === 0) continue;

    const inRace: Array<{ cand: CandMeta; row: CsvRow }> = [];
    for (const r of pollRows) {
      const feedName = r.candidate_name || r.answer;
      let cand = byFullName.get(cleanFull(feedName));
      if (!cand) {
        const ln = lastName(feedName);
        const byName = ln ? byLastName.get(ln) : undefined;
        if (byName) cand = byName; // null (ambiguous) or undefined -> skip
      }
      if (cand) {
        inRace.push({ cand, row: r });
      } else if (!isPrimary) {
        const pct = Number(r.pct);
        unresolved.set(feedName, Math.max(unresolved.get(feedName) ?? 0, pct));
      }
    }
    if (inRace.length === 0) continue;

    const lasts = inRace.map((r) => lastName(r.row.candidate_name || r.row.answer));
    const matchup = isPrimary
      ? primaryMatchup(head.stage, pollRows.map((r) => r.party || ""))
      : classifyMatchup(inRace.length, lasts);

    const pollster = head.display_name || head.pollster || "Unknown";
    const fieldStart = (head.start_date || "").slice(0, 10) || null;
    const pop = (head.population || "").toLowerCase().trim();
    const sampleKind = POP_LABEL[pop] || (pop ? pop.toUpperCase() : null);
    const sampleSize = head.sample_size ? Number(head.sample_size) : NaN;
    const sourceUrl = head.url || head.url_article || head.url_topline || null;
    if (!isPrimary && (head.hypothetical || "").toLowerCase() === "true") {
      hypoQuestions.add(`${pollster}|${fieldEnd}|${matchup}`);
    }

    for (const { cand, row } of inRace) {
      const dk = `${pollster}|${fieldEnd}|${cand.name}|${matchup}`;
      if (dedup.has(dk)) continue;
      const feedParty = (row.party || "").toUpperCase().trim();
      dedup.set(dk, {
        race_id,
        candidate_name: cand.name,
        candidate_party: cand.party ?? (feedParty ? (FEED_PARTY[feedParty] ?? feedParty) : null),
        pct: Number(row.pct),
        pollster,
        field_start: fieldStart,
        field_end: fieldEnd,
        sample_size: Number.isFinite(sampleSize) ? sampleSize : null,
        sample_kind: sampleKind,
        source: SOURCE,
        source_url: sourceUrl,
        matchup,
      });
    }
    questionsKept++;
    if (fieldEnd > newestFieldEnd) newestFieldEnd = fieldEnd;
  }

  const clean = Array.from(dedup.values());

  // Idempotent replace (one race, one source -- same as the old importer).
  const { error: delErr } = await supabase
    .from("race_polls").delete().eq("race_id", race_id).eq("source", SOURCE);
  if (delErr) throw delErr;
  if (clean.length) {
    const CHUNK = 500;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const { error } = await supabase.from("race_polls").insert(clean.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }

  const agg = buildAggregate(race, race_id, clean, activeNames, hypoQuestions);
  if (agg) {
    const { error } = await supabase
      .from("race_polling")
      .upsert(agg, { onConflict: "race_id,source" });
    if (error) throw error;
  }

  const rk = `${race.feedState.toLowerCase()}|governor`;
  for (const [name, pct] of unresolved) unmatchedOut.push({ rk, name, pct });

  return {
    slug: race.slug,
    questions_seen: byQuestion.size,
    questions_kept: questionsKept,
    inserted: clean.length,
    newest_field_end: newestFieldEnd || null,
    unresolved: Array.from(unresolved.keys()).sort(),
    spread: agg?.spread ?? null,
    summary: agg?.raw_data?.all_candidates ?? [],
  };
}

// Top-2 aggregate over general-election rows (general + h2h matchups -- the
// same scope the frontend's isGeneralMatchup uses), averaged over the last 60
// days of polling and falling back to all general rows when the window is
// empty, with the full ranking in raw_data.all_candidates.
//
// Scope, in order: drop poll questions that include a candidate who has left
// the race (our roster status); then, if FiftyPlusOne marks any remaining
// question as a real (non-hypothetical) matchup, use only those -- post-
// primary that is the nominee pairing, while pre-primary every question is
// hypothetical and all of them count, as before.
function buildAggregate(
  race: Race,
  raceId: string,
  rows: PollRowOut[],
  activeNames: Set<string>,
  hypoQuestions: Set<string>,
): Aggregate | null {
  const general = rows.filter((r) => r.matchup === "general" || r.matchup.startsWith("h2h"));
  const byQuestion = new Map<string, PollRowOut[]>();
  for (const r of general) {
    const k = `${r.pollster}|${r.field_end}|${r.matchup}`;
    const list = byQuestion.get(k) || [];
    list.push(r);
    byQuestion.set(k, list);
  }
  const eligibleQ: PollRowOut[][] = [];
  for (const q of byQuestion.values()) {
    if (q.every((r) => activeNames.has(r.candidate_name))) eligibleQ.push(q);
  }
  const realQ = eligibleQ.filter((q) => {
    const r = q[0];
    return !hypoQuestions.has(`${r.pollster}|${r.field_end}|${r.matchup}`);
  });
  let eligible = (realQ.length > 0 ? realQ : eligibleQ).flat();
  if (eligible.length === 0) eligible = general; // no live matchup polled yet
  let scoped = eligible;
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const recent = scoped.filter((r) => r.field_end >= cutoff);
  if (recent.length > 0) scoped = recent;
  if (scoped.length === 0) return null;

  const byCand = new Map<string, { name: string; party: string | null; pcts: number[] }>();
  for (const r of scoped) {
    let e = byCand.get(r.candidate_name);
    if (!e) {
      e = { name: r.candidate_name, party: r.candidate_party, pcts: [] };
      byCand.set(r.candidate_name, e);
    }
    e.pcts.push(r.pct);
    if (!e.party && r.candidate_party) e.party = r.candidate_party;
  }
  const summary: Summary[] = Array.from(byCand.values())
    .map((c) => ({
      name: c.name,
      party: c.party,
      avg_pct: Math.round((c.pcts.reduce((a, b) => a + b, 0) / c.pcts.length) * 100) / 100,
      polls: c.pcts.length,
    }))
    .sort((a, b) => b.avg_pct - a.avg_pct);
  if (summary.length < 2) return null;

  const a = summary[0], b = summary[1];
  const diff = Math.round((a.avg_pct - b.avg_pct) * 10) / 10;
  const spread = diff >= 0
    ? `${a.name.split(/\s+/).pop()} +${diff}`
    : `${b.name.split(/\s+/).pop()} +${Math.abs(diff)}`;
  const distinct = new Set(scoped.map((r) => `${r.pollster}|${r.field_end}`));
  const asOf = scoped.map((r) => r.field_end).sort().pop()!;
  const lastUrl =
    general.slice().sort((x, y) => (x.field_end < y.field_end ? 1 : -1))[0]?.source_url ?? race.pageUrl;

  return {
    race_id: raceId,
    source: SOURCE,
    candidate_a_name: a.name,
    candidate_a_party: a.party,
    candidate_a_pct: a.avg_pct,
    candidate_b_name: b.name,
    candidate_b_party: b.party,
    candidate_b_pct: b.avg_pct,
    spread,
    poll_count: distinct.size,
    as_of: asOf,
    source_url: race.pageUrl,
    rcp_url: lastUrl, // legacy NOT-NULL column: link to the latest poll
    raw_data: { all_candidates: summary },
    last_updated: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, key);

    let slugs: string[] | null = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.slugs)) slugs = body.slugs;
    } catch { /* empty body -- import everything */ }

    const targets = RACES.filter((r) => !slugs || slugs.includes(r.slug));

    // One fetch per feed file for every race. An empty export is treated as
    // a feed outage, not "no polls anywhere": bail before touching the DB
    // (each race's rows are replaced wholesale, so a missing primary file
    // would erase its primary polls).
    const [generalRows, primaryRows] = await Promise.all([
      fetchCsv(GENERAL_FILE),
      fetchCsv(PRIMARY_FILE),
    ]);
    if (generalRows.length === 0) throw new Error(`FPO CSV ${GENERAL_FILE} came back empty`);
    if (primaryRows.length === 0) throw new Error(`FPO CSV ${PRIMARY_FILE} came back empty`);
    // Split by "<state>|<cycle>": Kentucky's race is 2027, the rest 2026.
    const byState = new Map<string, CsvRow[]>();
    for (const r of [...generalRows, ...primaryRows]) {
      if ((r.office_type || "").trim() !== FEED_OFFICE) continue;
      const k = `${(r.state || "").trim()}|${(r.cycle || "").trim()}`;
      const list = byState.get(k) || [];
      list.push(r);
      byState.set(k, list);
    }

    const results = [];
    const errors: Record<string, string> = {};
    const unmatched: Unmatched[] = [];
    for (const race of targets) {
      try {
        const rows = byState.get(`${race.feedState}|${race.cycle}`) ?? [];
        results.push(await importRace(supabase, race, rows, unmatched));
      } catch (e) {
        errors[race.slug] = e instanceof Error ? e.message : String(e);
      }
    }

    // Durable worklist of unresolved feed names (edge logs only last ~24h).
    // Only meaningful for a full run -- a slug-filtered run would erase the
    // other races' entries.
    const failures: string[] = [];
    if (!slugs) {
      unmatched.sort((a, b) => b.pct - a.pct);
      const { error: umErr } = await supabase.rpc("replace_poll_import_unmatched", {
        p_source: UNMATCHED_SOURCE,
        p_rows: unmatched,
      });
      if (umErr) failures.push(`poll_import_unmatched: ${umErr.message}`);
    }

    const ok = Object.keys(errors).length === 0;
    return new Response(
      JSON.stringify({
        ok,
        feed_rows: { general: generalRows.length, primary: primaryRows.length },
        results,
        errors,
        failures,
      }),
      { status: ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
