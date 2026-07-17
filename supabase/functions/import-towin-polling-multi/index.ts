// Edge function: scrape 2026 governor polls from 270toWin for every live
// race and upsert them into race_polls + race_polling (source='270towin').
// Multi-state generalization of the TX repo's import-towin-polling function:
// the race list lives in RACES below, and the candidate roster comes from
// cf_candidates (state, office) instead of tx_candidates.
//
// POST body {} imports every race; { "slugs": ["florida-governor-2026"] }
// restricts to a subset. Response reports per-race results.
// build-tag: 270towin-multi-v1

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DOMParser, Element } from "https://deno.land/x/deno_dom@v0.1.46/deno-dom-wasm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SOURCE = "270towin";
const UA =
  "Mozilla/5.0 (compatible; statepoliticstracker-importer/1.0; +https://github.com/dllpoliticalintegrity/state-politics-tracker)";

// Live races. Promote a state in src/states/registry.ts AND here.
const RACES = [
  { slug: "florida-governor-2026",  url: "https://www.270towin.com/2026-governor-polls/florida",  state: "fl", office: "governor" },
  { slug: "michigan-governor-2026", url: "https://www.270towin.com/2026-governor-polls/michigan", state: "mi", office: "governor" },
  { slug: "georgia-governor-2026",  url: "https://www.270towin.com/2026-governor-polls/georgia",  state: "ga", office: "governor" },
];

const GENERIC_CHOICE = new Set([
  "other","someone else","undecided","neither","none","nobody",
  "dem","democrat","democratic","rep","republican","gop",
  "ind","independent",
]);
const POPULATION_LABEL: Record<string, string> = { lv: "LV", rv: "RV", a: "All", v: "Voters" };

function parseDate(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  let yy = m[3];
  if (yy.length === 2) yy = (Number(yy) > 50 ? "19" : "20") + yy;
  const iso = `${yy}-${mm}-${dd}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function parseSample(raw: string): { size: number | null; kind: string | null } {
  if (!raw) return { size: null, kind: null };
  const m = raw.replace(/ /g, " ").trim().match(/^([\d,]+)\s*([A-Za-z]+)?(?:\s*±[\d.]+%?)?$/);
  if (!m) return { size: null, kind: null };
  const size = parseInt(m[1].replace(/,/g, ""), 10);
  const k = (m[2] ?? "").toLowerCase().trim();
  const kind = POPULATION_LABEL[k] ?? (k ? k.toUpperCase() : null);
  return { size: Number.isFinite(size) ? size : null, kind };
}

function parsePct(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function classifyMatchup(heading: string, candidateLabels: string[]): string {
  const h = (heading || "").toLowerCase();
  if (h.includes("democratic primary") || h.includes("dem primary")) return "dem_primary";
  if (h.includes("republican primary") || h.includes("gop primary") || h.includes("rep primary")) return "rep_primary";
  if (h.includes(" vs")) {
    const names = candidateLabels
      .filter(c => c && !GENERIC_CHOICE.has(c.toLowerCase()))
      .map(c => c.split(/\s+/).pop()!.toLowerCase().replace(/,$/, ""))
      .sort();
    if (names.length >= 2) return "h2h:" + names.slice(0, 2).join("-");
  }
  return "general";
}

function txt(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function findPrevHeading(table: Element): string {
  let node: Element | null = table;
  while (node) {
    let prev = node.previousElementSibling as Element | null;
    while (prev) {
      if (/^H[1-5]$/.test(prev.tagName)) return txt(prev);
      const inner = prev.querySelector?.("h1,h2,h3,h4,h5") as Element | null;
      if (inner) return txt(inner);
      prev = prev.previousElementSibling as Element | null;
    }
    node = node.parentElement as Element | null;
  }
  return "";
}

type RawRow = {
  candidate_label: string;
  pct: number;
  pollster: string;
  field_end: string;
  sample_size: number | null;
  sample_kind: string | null;
  source_url: string | null;
  matchup: string;
};

function parsePolls(html: string): RawRow[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];
  const rows: RawRow[] = [];
  const tables = Array.from(doc.querySelectorAll("table")) as Element[];

  for (const table of tables) {
    const trs = Array.from(table.querySelectorAll("tr")) as Element[];
    if (trs.length === 0) continue;
    const headCells = Array.from(trs[0].querySelectorAll("th,td")).map(c => txt(c as Element));
    if (headCells.length < 5 || headCells[0].toLowerCase() !== "source") continue;

    const candidateLabels = headCells.slice(3).map(c => c.replace(/\*/g, "").trim());
    const heading = findPrevHeading(table);
    const matchup = classifyMatchup(heading, candidateLabels);

    for (let i = 1; i < trs.length; i++) {
      const tr = trs[i];
      const tds = Array.from(tr.querySelectorAll("td")) as Element[];
      if (tds.length < 4) continue;

      const firstText = txt(tds[0]);
      if (firstText.toLowerCase().startsWith("average of")) continue;

      let offset = 0;
      if (firstText === "" && tds.length > headCells.length) offset = 1;

      const sourceCell = tds[0 + offset];
      const dateCell = tds[1 + offset];
      const sampleCell = tds[2 + offset];
      const pctCells = tds.slice(3 + offset);

      const link = sourceCell.querySelector("a") as Element | null;
      const pollster = (link ? txt(link) : txt(sourceCell)).trim();
      const sourceUrl = link?.getAttribute("href") ?? null;
      const fieldEnd = parseDate(txt(dateCell));
      const { size, kind } = parseSample(txt(sampleCell));
      if (!pollster || !fieldEnd) continue;

      for (let j = 0; j < candidateLabels.length; j++) {
        if (j >= pctCells.length) break;
        const cand = candidateLabels[j];
        if (!cand || GENERIC_CHOICE.has(cand.toLowerCase())) continue;
        const pct = parsePct(txt(pctCells[j]));
        if (pct == null) continue;
        rows.push({
          candidate_label: cand,
          pct,
          pollster,
          field_end: fieldEnd,
          sample_size: size,
          sample_kind: kind,
          source_url: sourceUrl,
          matchup,
        });
      }
    }
  }
  return rows;
}

function isGeneralMatchup(m: string): boolean {
  return m === "general" || m.startsWith("h2h");
}

// deno-lint-ignore no-explicit-any
async function importRace(supabase: any, race: typeof RACES[number]) {
  const { data: raceRow, error: raceErr } = await supabase
    .from("races")
    .select("race_id")
    .eq("slug", race.slug)
    .single();
  if (raceErr || !raceRow) throw new Error(`race not found: ${race.slug} ${raceErr?.message ?? ""}`);
  const race_id = raceRow.race_id as string;

  const html = await fetch(race.url, {
    headers: { "User-Agent": UA, "Accept": "text/html" },
  }).then((r) => {
    if (!r.ok) throw new Error(`fetch ${race.url} -> ${r.status}`);
    return r.text();
  });

  const raw = parsePolls(html);

  // Roster: surname -> {name, party} from cf_candidates for this race.
  const { data: cands, error: candErr } = await supabase
    .from("cf_candidates")
    .select("name,party")
    .eq("state", race.state)
    .eq("office", race.office);
  if (candErr) throw candErr;
  const PARTY_ABBR: Record<string, string> = { Republican: "R", Democrat: "D", Independent: "I" };
  const roster = new Map<string, { name: string; party: string | null }>();
  for (const c of (cands ?? []) as Array<{ name: string; party: string | null }>) {
    const last = (c.name ?? "").trim().split(/\s+/).pop()?.toLowerCase().replace(/,$/, "") ?? "";
    if (!last || roster.has(last)) continue;
    roster.set(last, { name: c.name, party: c.party ? (PARTY_ABBR[c.party] ?? c.party) : null });
  }

  type Clean = {
    race_id: string; candidate_name: string; candidate_party: string | null;
    pct: number; pollster: string; field_start: null; field_end: string;
    sample_size: number | null; sample_kind: string | null; source: string;
    source_url: string | null; matchup: string;
  };
  const dedup = new Map<string, Clean & { _n: number; _sum: number }>();
  const unresolved = new Set<string>();
  for (const r of raw) {
    const last = r.candidate_label.split(/\s+/).pop()?.toLowerCase().replace(/,$/, "") ?? "";
    const match = roster.get(last);
    if (!match) { unresolved.add(r.candidate_label); continue; }
    const key = `${r.pollster}|${r.field_end}|${match.name}|${r.matchup}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, {
        race_id, candidate_name: match.name, candidate_party: match.party,
        pct: r.pct, pollster: r.pollster, field_start: null, field_end: r.field_end,
        sample_size: r.sample_size, sample_kind: r.sample_kind, source: SOURCE,
        source_url: r.source_url, matchup: r.matchup, _n: 1, _sum: r.pct,
      });
    } else {
      existing._n += 1;
      existing._sum += r.pct;
      existing.pct = Math.round((existing._sum / existing._n) * 100) / 100;
    }
  }
  const clean: Clean[] = Array.from(dedup.values()).map(({ _n, _sum, ...rest }) => rest);

  // Idempotent replace.
  await supabase.from("race_polls").delete().eq("race_id", race_id).eq("source", SOURCE);
  if (clean.length) {
    const CHUNK = 500;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const { error } = await supabase.from("race_polls").insert(clean.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }

  // Aggregate over general/head-to-head rows only (matches the frontend's
  // isGeneralMatchup filter — primary polls would contaminate the average),
  // last 60 days, falling back to all general rows if the window is empty.
  const general = clean.filter(r => isGeneralMatchup(r.matchup));
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  let recent = general.filter(r => r.field_end >= cutoff);
  if (recent.length === 0) recent = general;

  const byCand = new Map<string, Clean[]>();
  for (const r of recent) {
    const arr = byCand.get(r.candidate_name) ?? [];
    arr.push(r); byCand.set(r.candidate_name, arr);
  }
  const summary = Array.from(byCand.entries()).map(([name, rs]) => {
    const avg = rs.reduce((a, x) => a + x.pct, 0) / rs.length;
    const party = rs.find(x => x.candidate_party)?.candidate_party ?? null;
    return { name, party, avg_pct: Math.round(avg * 100) / 100, polls: rs.length };
  }).sort((a, b) => b.avg_pct - a.avg_pct);

  let aggregateSpread: string | null = null;
  if (summary.length >= 2) {
    const a = summary[0], b = summary[1];
    const diff = Math.round((a.avg_pct - b.avg_pct) * 10) / 10;
    aggregateSpread = diff >= 0
      ? `${a.name.split(/\s+/).pop()} +${diff}`
      : `${b.name.split(/\s+/).pop()} +${Math.abs(diff)}`;
    const distinct = new Set(recent.map(r => `${r.pollster}|${r.field_end}`));
    const asOf = recent.map(r => r.field_end).sort().pop()!;
    const lastUrl = clean.slice().sort((x, y) => (x.field_end < y.field_end ? 1 : -1))[0]?.source_url ?? race.url;
    const { error } = await supabase
      .from("race_polling")
      .upsert({
        race_id,
        source: SOURCE,
        candidate_a_name: a.name, candidate_a_party: a.party, candidate_a_pct: a.avg_pct,
        candidate_b_name: b.name, candidate_b_party: b.party, candidate_b_pct: b.avg_pct,
        spread: aggregateSpread,
        poll_count: distinct.size,
        as_of: asOf,
        source_url: race.url,
        rcp_url: lastUrl,
        raw_data: { all_candidates: summary },
        last_updated: new Date().toISOString(),
      }, { onConflict: "race_id,source" });
    if (error) throw error;
  }

  return {
    slug: race.slug,
    parsed_rows: raw.length,
    inserted: clean.length,
    unresolved: Array.from(unresolved).sort(),
    spread: aggregateSpread,
    summary,
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
    } catch { /* empty body — import everything */ }

    const targets = RACES.filter(r => !slugs || slugs.includes(r.slug));
    const results = [];
    const errors: Record<string, string> = {};
    for (const race of targets) {
      try {
        results.push(await importRace(supabase, race));
      } catch (e) {
        errors[race.slug] = e instanceof Error ? e.message : String(e);
      }
    }

    const ok = Object.keys(errors).length === 0;
    return new Response(
      JSON.stringify({ ok, results, errors }),
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
