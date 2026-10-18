// Pure helpers for reading the Local Politics Tracker project (LPT): the
// vocabulary differences between its schema and the site's, and the polling
// average the site computes from its per-poll rows. No I/O here — see
// src/integrations/lpt/reads.ts for the queries.

import { getChamber, type RaceConfig, type StateConfig } from "@/states/registry";
import type { PollRow, PollingBundle, RacePollRow } from "@/hooks/usePolling";

/** The id-keyed form of a PollRow entry ("id:<candidate_id>"); see readCandidatePct. */
export function pollIdKey(candidateId: string): string {
  return `id:${candidateId}`;
}

/**
 * Extracts per-candidate pct from a poll row: by candidate id when the row
 * carries id keys (LPT), else by surname (RCP and FiftyPlusOne use last-name
 * keys, e.g. "Porter", "Hilton").
 */
export function readCandidatePct(row: PollRow | null | undefined, fullName: string, candidateId?: string): number | null {
  if (!row) return null;
  const surname = fullName.trim().split(/\s+/).pop() ?? "";
  // An id-aware row (any "id:" key) answers only by id: a namesake the
  // source did not poll gets null, not the other candidate's number.
  const idAware = Object.keys(row).some((k) => k.startsWith("id:"));
  const val = idAware ? (candidateId ? row[pollIdKey(candidateId)] : undefined) : row[surname];
  if (val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/** Whether a per-poll row belongs to a candidate: by id when the row has one, else by surname. */
export function pollRowIsCandidate(row: RacePollRow, candidate: { id?: string; name: string }): boolean {
  if (row.candidate_id && candidate.id) return row.candidate_id === candidate.id;
  const surname = candidate.name.trim().split(/\s+/).pop() ?? "";
  return (row.candidate_name.trim().split(/\s+/).pop() ?? "") === surname;
}

/** Registry office → LPT office. Everything else is spelled the same. */
const TO_LPT_OFFICE: Record<string, string> = { "state-house": "state-representative" };
const FROM_LPT_OFFICE: Record<string, string> = { "state-representative": "state-house" };

export function toLptOffice(office: string): string {
  return TO_LPT_OFFICE[office] ?? office;
}

export function fromLptOffice(office: string): string {
  return FROM_LPT_OFFICE[office] ?? office;
}

/**
 * The `office_num` filter for a race: the district number for a legislative
 * seat, 0 for a statewide race, null for a chamber overview (every district
 * of the chamber — App.tsx gives the overview a district-less pseudo race).
 */
export function lptDistrict(state: Pick<StateConfig, "chambers">, race: Pick<RaceConfig, "office" | "district">): number | null {
  if (race.district) return Number(race.district);
  return getChamber(state as StateConfig, race.office) ? null : 0;
}

/** LPT's race slug: "governor-2026", "state-senate-11-2026", "state-representative-3-2026". */
export function lptRaceSlug(race: Pick<RaceConfig, "office" | "district" | "generalDate">): string {
  const year = race.generalDate.slice(0, 4);
  return `${toLptOffice(race.office)}${race.district ? `-${race.district}` : ""}-${year}`;
}

const SUFFIX_RE = /^(JR|SR|II|III|IV|V)\.?$/i;

/**
 * "JACKSON, RICHARD L." → "RICHARD L. JACKSON"; "Bottoms, Keisha L., Jr." →
 * "Keisha L. Bottoms Jr."; names without a comma pass through. Mirrors
 * hub_flip_name() in supabase/lpt/001_hub_read_layer.sql.
 */
export function flipName(n: string | null | undefined): string {
  if (!n) return "";
  const p = n.split(",").map((s) => s.trim());
  if (p.length === 2 && p[0] && p[1] && !SUFFIX_RE.test(p[1])) return `${p[1]} ${p[0]}`;
  if (p.length === 3 && p[0] && p[2] && SUFFIX_RE.test(p[1])) return `${p[2]} ${p[0]} ${p[1]}`;
  if (p.length === 3 && p[0] && p[1] && SUFFIX_RE.test(p[2])) return `${p[1]} ${p[0]} ${p[2]}`;
  return n.trim();
}

/**
 * A poll label as the site's surname-keyed polling code expects a candidate
 * name: "First Last" with any generational suffix dropped, so that
 * `name.split(/\s+/).pop()` is the surname on both sides of the match.
 */
export function pollCandidateName(label: string): string {
  const parts = flipName(label).split(/\s+/).filter((t) => !SUFFIX_RE.test(t));
  return parts.join(" ");
}

/** Surname the site keys polling by: the last word of the display name. */
export function surnameOf(name: string): string {
  return pollCandidateName(name).split(/\s+/).pop() ?? "";
}

/** LPT spells parties several ways; the site's chips and colours key on the first letter but display the word. */
export function normalizeParty(p: string | null | undefined): string | null {
  if (!p) return null;
  // Fusion nominations arrive as one string ("Libertarian, Republican"):
  // the major party is the one the site colours by.
  const parts = p.split(",").map((x) => x.trim()).filter(Boolean);
  const major = parts.find((x) => /^(democrat|republican)/i.test(x));
  const s = major ?? parts[0] ?? p.trim();
  if (/^democrat/i.test(s)) return "Democrat";
  if (/^republican/i.test(s)) return "Republican";
  if (/^(independent|no party|non-?partisan|unaffiliated|nonpartisan)/i.test(s)) return "Independent";
  return s;
}

/** The number of most recent polls the site's average is taken over. */
export const POLL_AVERAGE_WINDOW = 5;

export type LptPollResult = { label: string; party: string | null; pct: number | string | null; candidate_id: string | null };
export type LptPoll = {
  poll_id: string;
  source: string;
  poll_date: string | null;
  sample_size: number | null;
  sample_type: string | null;
  margin_of_error: number | string | null;
  race_poll_results: LptPollResult[] | null;
};

function isUndecided(label: string): boolean {
  return /^(undecided|other|someone else|none|refused|don'?t know|unsure)/i.test(label.trim());
}

/** Newest first; a poll with no date sorts last. */
export function sortPollsNewestFirst<T extends { poll_date: string | null }>(polls: T[]): T[] {
  return [...polls].sort((a, b) => (b.poll_date ?? "").localeCompare(a.poll_date ?? ""));
}

/**
 * The site's polling average from LPT's per-poll rows: the mean of each
 * candidate's share over the race's POLL_AVERAGE_WINDOW most recent polls,
 * keyed by surname like the FiftyPlusOne bundle the pages were written for.
 * Null when the race has no polls.
 */
export function buildPollingBundle(polls: LptPoll[], race: Pick<RaceConfig, "pollingSourceUrl">, sourceLabel: string): PollingBundle | null {
  const sorted = sortPollsNewestFirst(polls).filter((p) => (p.race_poll_results ?? []).length > 0);
  if (sorted.length === 0) return null;
  const window = sorted.slice(0, POLL_AVERAGE_WINDOW);
  // One entry per candidate (by id when the result names one, else by
  // surname), each also written under its surname for the surname-keyed pages.
  const sums = new Map<string, { total: number; n: number; surname: string; id: string | null }>();
  for (const p of window) {
    for (const r of p.race_poll_results ?? []) {
      if (isUndecided(r.label)) continue;
      const pct = Number(r.pct);
      if (!Number.isFinite(pct)) continue;
      const surname = surnameOf(r.label);
      if (!surname) continue;
      const key = r.candidate_id ? pollIdKey(r.candidate_id) : surname;
      const s = sums.get(key) ?? { total: 0, n: 0, surname, id: r.candidate_id ?? null };
      s.total += pct;
      s.n += 1;
      sums.set(key, s);
    }
  }
  const average: PollRow = { Poll: `${sourceLabel} Average`, Date: window[0].poll_date ?? "", Sample: "", MoE: "" };
  const ranked: [string, number][] = [];
  for (const [key, s] of sums) {
    const avg = Math.round((s.total / s.n) * 10) / 10;
    average[key] = String(avg);
    if (s.id) average[s.surname] = average[s.surname] ?? String(avg);
    ranked.push([s.surname, avg]);
  }
  ranked.sort((a, b) => b[1] - a[1]);
  let spread: string | null = null;
  if (ranked.length >= 2) {
    const diff = Math.round((ranked[0][1] - ranked[1][1]) * 10) / 10;
    spread = diff === 0 ? "Tie" : `${ranked[0][0]} +${diff}`;
  }
  return {
    rcp_url: race.pollingSourceUrl ?? null,
    last_updated: window[0].poll_date,
    spread,
    average,
    polls: [],
  };
}

/** One row per candidate per poll, in the shape the trend charts read. */
export function toRacePollRows(polls: LptPoll[]): RacePollRow[] {
  const rows: RacePollRow[] = [];
  for (const p of sortPollsNewestFirst(polls)) {
    if (!p.poll_date) continue;
    for (const r of p.race_poll_results ?? []) {
      if (isUndecided(r.label)) continue;
      const pct = Number(r.pct);
      if (!Number.isFinite(pct)) continue;
      rows.push({
        candidate_name: pollCandidateName(r.label),
        candidate_party: normalizeParty(r.party),
        candidate_id: r.candidate_id ?? null,
        pct,
        pollster: p.source,
        field_end: p.poll_date,
        sample_size: p.sample_size,
        sample_kind: p.sample_type,
        source_url: null,
        matchup: "general",
      });
    }
  }
  return rows;
}
