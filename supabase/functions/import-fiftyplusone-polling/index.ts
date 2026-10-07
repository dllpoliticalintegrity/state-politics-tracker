// Edge function: import FiftyPlusOne Texas Governor polls into race_polls
// (source='fiftyplusone'), plus a top-2 aggregate into race_polling.
// (Moved here from tx-politics-tracker in Oct 2026 with the rest of Texas's
// pipelines; deployed to the shared tracker project with verify_jwt = false,
// triggered by .github/workflows/polling-sync.yml. Texas is deliberately not
// in import-towin-polling-multi's race list — see docs/plan.md.)
// Ported from integrityindex's import-fiftyplusone-polls, cut down to the one
// race this site tracks. Replaces the 270toWin scrape (import-towin-polling).
//
// Reads FiftyPlusOne's DOCUMENTED CSV API (https://fiftyplusone.news/api/csv),
// the supported, API-keyed feed described at https://fiftyplusone.news/readme.
//
// NOTE ON FRESHNESS: as of this writing the CSV export regenerates on a slower
// cadence than FiftyPlusOne's live site -- its newest poll can lag the site by
// a few days. That is a known issue on FiftyPlusOne's side (their docs say the
// data is "constantly updating"). The undocumented /api/polls JSON endpoint is
// fresher but unsupported and IP-throttled; this importer intentionally uses
// the supported CSV feed. If freshness regresses, report the stale export to
// FiftyPlusOne rather than switching to the scrape.
//
// RESOLUTION. The race is resolved from the feed's descriptive columns
// (state + office_type + cycle -> the texas-governor-2026 race); each
// candidate is resolved within our tx_candidates roster (cleaned full-name
// match, then unique last-name match). Matching against our filed roster is
// deliberate: it filters out FiftyPlusOne hypothetical ("what if X ran")
// names, which are not candidates in our DB. Unmatched feed names land in
// public.poll_import_unmatched as a triage worklist.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SOURCE = "fiftyplusone";
const RACE_SLUG = "texas-governor-2026";
const FPO_PAGE_URL = "https://fiftyplusone.news/polls/governor/general/texas";
const CSV_BASE = "https://fiftyplusone.news/api/csv";
// The primaries are over (March 3 primary, May 26 runoff), so only the
// general-election file is pulled.
const FILES = ["governor_general"];
const FEED_STATE = "Texas";
const FEED_OFFICE = "Governor";
const FEED_CYCLE = "2026";
const FIELD_CUTOFF_DAYS = 540; // ~full 2026 cycle of polling
const FETCH_TIMEOUT_MS = 60000;

// Read-only data API key. Prefer the FIFTYPLUSONE_API_KEY secret; fall back to
// the known publishable key so the function runs without extra config.
const API_KEY =
  Deno.env.get("FIFTYPLUSONE_API_KEY") || "rRIQeP7129VVXKuzKWjklA";

// FPO `population` -> our `sample_kind` (same labels the 270toWin importer used).
const POP_LABEL: Record<string, string> = { lv: "LV", rv: "RV", a: "All", v: "Voters" };

interface CandMeta {
  party: string | null;
  name: string;
}

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

// Name suffixes and honorific titles, stripped wherever they appear.
const NAME_NOISE = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "mr", "mrs", "ms", "dr", "rev", "phd", "hon", "honorable", "rep", "sen",
]);

// Repair UTF-8-decoded-as-Latin1 mojibake ("LujÃ¡n" -> "Luján") then fold
// accents to ASCII so feed and DB spellings compare equal.
function deAccent(s: string): string {
  let t = s;
  if (/[ÃÂ][\x80-\xBF]/.test(t)) {
    try {
      t = decodeURIComponent(escape(t));
    } catch { /* leave as-is */ }
  }
  return t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
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

// Full normalized name (for exact-ish matching across spelling/format drift).
const cleanFull = (name: string | null | undefined): string => nameTokens(name).join(" ");

// Last (family) name, ignoring trailing suffixes/titles.
const lastName = (name: string | null | undefined): string => {
  const t = nameTokens(name);
  return t.length ? t[t.length - 1] : "";
};

// Primary-style stages, skipped outright — the primaries are over and only
// general matchups feed the site.
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

// Same matchup vocabulary the 270toWin importer wrote and the frontend's
// isGeneralMatchup() expects: general / h2h:a-b.
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

type CsvRow = Record<string, string>;

async function fetchCsv(filename: string): Promise<CsvRow[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${CSV_BASE}?api_key=${encodeURIComponent(API_KEY)}&filename=${filename}`;
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`FPO CSV ${resp.status} for ${filename}`);
    const text = await resp.text();
    const rows = parse(text, { skipFirstRow: true }) as CsvRow[];
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, key);

    const { data: race, error: raceErr } = await supabase
      .from("races")
      .select("race_id")
      .eq("slug", RACE_SLUG)
      .single();
    if (raceErr || !race) throw new Error(`race not found: ${raceErr?.message}`);
    const race_id = race.race_id as string;

    // Roster: every governor candidate we file (any status -- early general
    // polls can include since-eliminated names). Layered matching: cleaned
    // full name first, then a last name that is unique within the roster
    // (ambiguous last names are skipped).
    const { data: cands, error: candErr } = await supabase
      .from("tx_candidates")
      .select("name,party")
      .eq("office", "GOVERNOR");
    if (candErr) throw candErr;
    const byFullName = new Map<string, CandMeta>();
    const byLastName = new Map<string, CandMeta | null>();
    for (const c of (cands ?? []) as Array<{ name: string; party: string | null }>) {
      const meta: CandMeta = {
        name: c.name,
        party: c.party && c.party !== "UNK" ? c.party : null,
      };
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

    // Fetch all CSV files concurrently.
    const files = await Promise.all(FILES.map((f) => fetchCsv(f)));

    let rowsScanned = 0;
    let questionsKept = 0;
    let unmatchedCandidates = 0;
    let newestFieldEnd = "";

    // One row per (pollster, field_end, candidate, matchup) -- the race_polls
    // unique key. A poll that asks the same matchup of several populations
    // (lv + rv) collides here; first question wins.
    const dedup = new Map<string, PollRowOut>();

    // Feed candidates we couldn't tie to one of our filed candidates, with the
    // best poll number they showed. Real people here mean tx_candidates needs
    // a name fix or a new row (hypothetical "what-if" names also land here and
    // are expected).
    const unmatchedReport = new Map<string, { name: string; pct: number }>();

    for (const csvRows of files) {
      rowsScanned += csvRows.length;

      // Group rows by question_id -- each question is one matchup.
      const byQuestion = new Map<string, CsvRow[]>();
      for (const r of csvRows) {
        if ((r.state || "").trim() !== FEED_STATE) continue;
        if ((r.office_type || "").trim() !== FEED_OFFICE) continue;
        if ((r.cycle || "").trim() !== FEED_CYCLE) continue;
        const qid = r.question_id || `${r.poll_id}|${r.stage}`;
        const list = byQuestion.get(qid) || [];
        list.push(r);
        byQuestion.set(qid, list);
      }

      for (const qRows of byQuestion.values()) {
        const head = qRows[0];
        if (isPrimaryStage(head.stage)) continue;
        const fieldEnd = (head.end_date || "").slice(0, 10);
        if (!fieldEnd || fieldEnd < cutoffIso) continue;

        const pollRows = qRows.filter((r) => Number.isFinite(Number(r.pct)));
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
          } else {
            unmatchedCandidates++;
            const pct = Number(r.pct);
            const prev = unmatchedReport.get(feedName);
            if (!prev || pct > prev.pct) unmatchedReport.set(feedName, { name: feedName, pct });
          }
        }
        if (inRace.length === 0) continue;

        const lasts = inRace.map((r) => lastName(r.row.candidate_name || r.row.answer));
        const matchup = classifyMatchup(inRace.length, lasts);

        const pollster = head.display_name || head.pollster || "Unknown";
        const fieldStart = (head.start_date || "").slice(0, 10) || null;
        const pop = (head.population || "").toLowerCase().trim();
        const sampleKind = POP_LABEL[pop] || (pop ? pop.toUpperCase() : null);
        const sampleSize =
          head.sample_size && head.sample_size !== "" ? Number(head.sample_size) : null;
        const sourceUrl = head.url || head.url_article || head.url_topline || null;

        for (const { cand, row } of inRace) {
          const dk = `${pollster}|${fieldEnd}|${cand.name}|${matchup}`;
          if (dedup.has(dk)) continue;
          dedup.set(dk, {
            race_id,
            candidate_name: cand.name,
            candidate_party: cand.party,
            pct: Number(row.pct),
            pollster,
            field_start: fieldStart,
            field_end: fieldEnd,
            sample_size: Number.isFinite(sampleSize as number) ? sampleSize : null,
            sample_kind: sampleKind,
            source: SOURCE,
            source_url: sourceUrl,
            matchup,
          });
        }
        questionsKept++;
        if (fieldEnd > newestFieldEnd) newestFieldEnd = fieldEnd;
      }
    }

    const clean = Array.from(dedup.values());

    // Idempotent replace (one race, one source -- same as the 270toWin importer).
    await supabase.from("race_polls").delete().eq("race_id", race_id).eq("source", SOURCE);
    if (clean.length) {
      const CHUNK = 500;
      for (let i = 0; i < clean.length; i += CHUNK) {
        const { error } = await supabase.from("race_polls").insert(clean.slice(i, i + CHUNK));
        if (error) throw error;
      }
    }

    const failures: string[] = [];
    const agg = buildAggregate(race_id, clean);
    if (agg) {
      const { error: aggErr } = await supabase
        .from("race_polling")
        .upsert(agg, { onConflict: "race_id,source" });
      if (aggErr) failures.push(`race_polling upsert: ${aggErr.message}`);
    }

    // Worklist of unmatched feed candidates, highest-polling first. Notable
    // ones (>=10%) that are real candidates indicate a name to fix or add in
    // tx_candidates; the rest are mostly minor-party names and FiftyPlusOne
    // "what-if" hypotheticals, which are expected to stay unmatched. Persisted
    // in public.poll_import_unmatched (edge logs only last ~24h and the cron
    // caller discards the response).
    const unmatched = Array.from(unmatchedReport.values()).sort((a, b) => b.pct - a.pct);
    const unmatchedNotable = unmatched.filter((u) => u.pct >= 10);
    const { error: umErr } = await supabase.rpc("replace_poll_import_unmatched", {
      p_source: SOURCE,
      p_rows: unmatched.map((u) => ({ rk: "texas|governor", name: u.name, pct: u.pct })),
    });
    if (umErr) failures.push(`poll_import_unmatched: ${umErr.message}`);

    if (unmatchedNotable.length > 0) {
      console.log(
        `[import-fiftyplusone] ${unmatchedNotable.length} notable unmatched candidates:\n` +
          unmatchedNotable.map((u) => `  ${u.pct.toFixed(0)}%  ${u.name}`).join("\n"),
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        race_id,
        rowsScanned,
        questionsKept,
        inserted: clean.length,
        newestFieldEnd,
        spread: agg?.spread ?? null,
        summary: agg?.raw_data?.all_candidates ?? [],
        unmatchedCandidates,
        unmatchedNotable,
        failureCount: failures.length,
        failures,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// Top-2 aggregate over GENERAL-election polls (general + h2h matchups -- the
// same scope the frontend's isGeneralMatchup uses), averaged over the last 60
// days of polling, with the full ranking in raw_data.all_candidates.
// deno-lint-ignore no-explicit-any
function buildAggregate(raceId: string, rows: PollRowOut[]): Record<string, any> | null {
  let scoped = rows.filter((r) => r.matchup === "general" || r.matchup.startsWith("h2h"));
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const recent = scoped.filter((r) => r.field_end >= cutoff);
  if (recent.length > 0) scoped = recent;
  if (scoped.length === 0) return null;

  const byCand = new Map<string, { name: string; party: string | null; pcts: number[] }>();
  for (const r of scoped) {
    let e = byCand.get(r.candidate_name);
    if (!e) { e = { name: r.candidate_name, party: r.candidate_party, pcts: [] }; byCand.set(r.candidate_name, e); }
    e.pcts.push(r.pct);
    if (!e.party && r.candidate_party) e.party = r.candidate_party;
  }
  const summary = Array.from(byCand.values())
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
  const spread =
    diff >= 0
      ? `${a.name.split(/\s+/).pop()} +${diff}`
      : `${b.name.split(/\s+/).pop()} +${Math.abs(diff)}`;
  const distinct = new Set(scoped.map((r) => `${r.pollster}|${r.field_end}`));
  const asOf = scoped.map((r) => r.field_end).sort().pop()!;
  const lastUrl =
    scoped.slice().sort((x, y) => (x.field_end < y.field_end ? 1 : -1))[0]?.source_url ??
    FPO_PAGE_URL;

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
    source_url: lastUrl,
    rcp_url: lastUrl, // legacy NOT-NULL safety; harmless duplicate
    raw_data: { all_candidates: summary },
    last_updated: new Date().toISOString(),
  };
}
