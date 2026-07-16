import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PollRow = {
  Poll: string;
  Date: string;
  Sample: string;
  MoE: string;
  Spread?: string;
  [candidateLastName: string]: string | undefined;
};

export type PollingBundle = {
  rcp_url: string | null;
  last_updated: string | null;
  spread: string | null;
  average: PollRow | null; // row where Poll === "RCP Average"
  polls: PollRow[]; // everything except the average, sorted by Date desc
};

const GOV_RACE_SLUG = "texas-governor-2026";

async function fetchRacePolling(slug: string): Promise<PollingBundle | null> {
  const { data: race, error: raceErr } = await (supabase as any)
    .from("races")
    .select("race_id")
    .eq("slug", slug)
    .maybeSingle();
  if (raceErr) throw raceErr;
  if (!race) return null;

  // Only use 270toWin data; RCP has been deprecated.
  const { data: rows, error } = await (supabase as any)
    .from("race_polling")
    .select("source,rcp_url,source_url,last_updated,spread,raw_data")
    .eq("race_id", race.race_id)
    .eq("source", "270towin");
  if (error) throw error;
  if (!rows || rows.length === 0) return null;

  const pick = rows[0];

  // 270toWin aggregator stores { all_candidates: [...] }; RCP stores an array
  // of poll rows with an "RCP Average" entry. Normalize both to PollRow[].
  const raw = pick.raw_data;
  let average: PollRow | null = null;
  let polls: PollRow[] = [];

  if (Array.isArray(raw)) {
    average = raw.find((r: PollRow) => r.Poll === "RCP Average") ?? null;
    polls = raw
      .filter((r: PollRow) => r.Poll !== "RCP Average")
      .sort((a: PollRow, b: PollRow) =>
        parsePollDate(b.Date).localeCompare(parsePollDate(a.Date)),
      );
  } else if (raw && Array.isArray(raw.all_candidates)) {
    // Synthesize a single "average" row keyed by surname → pct so the
    // existing readCandidatePct helper continues to work.
    const avgRow: PollRow = { Poll: "270toWin Average", Date: "", Sample: "", MoE: "" };
    for (const c of raw.all_candidates as Array<{ name: string; avg_pct: number }>) {
      const surname = c.name.trim().split(/\s+/).pop() ?? "";
      avgRow[surname] = String(c.avg_pct);
    }
    average = avgRow;
    polls = []; // trend chart will read from race_polls separately
  }

  return {
    rcp_url: pick.rcp_url ?? pick.source_url ?? null,
    last_updated: pick.last_updated,
    spread: pick.spread,
    average,
    polls,
  };
}

/**
 * Normalize RCP's date strings into a sortable ISO-ish string.
 * Handles: "4/15", "3/9 - 4/15", "April 15", "4/15/2026".
 * Defaults year to 2026. Returns the *end* of the range.
 */
export function parsePollDate(d: string | undefined | null): string {
  if (!d) return "0000-00-00";
  const raw = d.trim();
  const rangeEnd = raw.includes("-") ? raw.split("-").pop()!.trim() : raw;
  const mdY = rangeEnd.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (mdY) {
    const mm = mdY[1].padStart(2, "0");
    const dd = mdY[2].padStart(2, "0");
    const yy = mdY[3] ? (mdY[3].length === 2 ? `20${mdY[3]}` : mdY[3]) : "2026";
    return `${yy}-${mm}-${dd}`;
  }
  return rangeEnd;
}

export function useTxGovPolling() {
  return useQuery({
    queryKey: ["race_polling", GOV_RACE_SLUG],
    queryFn: () => fetchRacePolling(GOV_RACE_SLUG),
  });
}

/**
 * Per-poll rows from the 270toWin importer (one row per candidate per poll).
 * Used by the trend chart so we don't depend on RCP's "raw_data" array.
 */
export type RacePollRow = {
  candidate_name: string;
  candidate_party: string | null;
  pct: number;
  pollster: string;
  field_end: string;
  sample_size: number | null;
  sample_kind: string | null;
  source_url: string | null;
  matchup: string | null;
};

/** General-election rows only — primary-matchup polls would contaminate the
 * head-to-head trend series and 90-day deltas. */
export function isGeneralMatchup(m: string | null | undefined): boolean {
  const s = (m ?? "general").toLowerCase();
  return s === "general" || s.startsWith("h2h");
}

export function useTxGovRacePolls() {
  return useQuery({
    queryKey: ["race_polls", GOV_RACE_SLUG],
    queryFn: async (): Promise<RacePollRow[]> => {
      const { data: race } = await (supabase as any)
        .from("races")
        .select("race_id")
        .eq("slug", GOV_RACE_SLUG)
        .maybeSingle();
      if (!race) return [];
      const { data, error } = await (supabase as any)
        .from("race_polls")
        .select(
          "candidate_name,candidate_party,pct,pollster,field_end,sample_size,sample_kind,source_url,matchup",
        )
        .eq("race_id", race.race_id)
        .eq("source", "270towin")
        .order("field_end", { ascending: false });
      if (error) throw error;
      return (data ?? []) as RacePollRow[];
    },
  });
}

/**
 * Extracts per-candidate pct from a poll row by matching on the candidate's surname.
 * RCP uses last-name-only keys (e.g. "Porter", "Hilton").
 */
export function readCandidatePct(row: PollRow | null | undefined, fullName: string): number | null {
  if (!row) return null;
  const surname = fullName.trim().split(/\s+/).pop() ?? "";
  const val = row[surname];
  if (val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
