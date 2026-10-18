// Candidate-name search: pure helpers shared by the hook and its tests.
// Searches cf_candidates by name only; committees and donors are never part
// of it.
import { getState, type StateConfig } from "@/states/registry";
import { raceFromSegments, racePath } from "@/states/StateContext";
import { INACTIVE_STATUSES, inactiveLabel } from "@/lib/candidateStatus";

export interface CandidateSearchRow {
  slug: string;
  name: string;
  party: string | null;
  state: string;
  office: string | null;
  district: string | null;
  status: string | null;
}

export interface CandidateSearchResult {
  slug: string;
  name: string;
  party: string | null;
  /** "Michigan · State Senate District 11" on the hub, "State Senate District 11" on a state site. */
  context: string;
  href: string;
  offBallot: boolean;
  /** "Not on ballot", "Withdrawn", … for candidates off the ballot. */
  statusLabel: string | null;
}

/** Minimum characters before a search runs. */
export const MIN_QUERY = 2;

/**
 * The query reduced to letters, digits, spaces, hyphens, apostrophes and
 * periods, collapsed and trimmed. PostgREST wildcards (*, %, _) and filter
 * syntax (commas, parentheses) are dropped, so a query can only ever match
 * names, never reshape the filter.
 */
export function cleanQuery(q: string): string {
  return q
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

const OFF_BALLOT: ReadonlySet<string> = new Set(INACTIVE_STATUSES);

/**
 * Rows → linkable results: drops candidates whose office/district maps to no
 * race on this site, puts candidates still on the ballot first, and caps the
 * list. `showState` adds the state name to each result (the hub).
 */
export function toResults(
  rows: CandidateSearchRow[],
  opts: { showState: boolean; limit?: number },
): CandidateSearchResult[] {
  const out: CandidateSearchResult[] = [];
  for (const r of rows) {
    const state: StateConfig | undefined = getState(r.state);
    if (!state || state.status !== "live") continue;
    const race = raceFromSegments(state, r.office ?? undefined, r.district ?? undefined);
    if (!race) continue;
    out.push({
      slug: r.slug,
      name: r.name,
      party: r.party,
      context: opts.showState ? `${state.name} · ${race.title}` : race.title,
      href: `${racePath(state, race)}/candidates/${r.slug}`,
      offBallot: OFF_BALLOT.has(r.status ?? ""),
      statusLabel: inactiveLabel(r.status),
    });
  }
  out.sort((a, b) => Number(a.offBallot) - Number(b.offBallot) || a.name.localeCompare(b.name));
  return out.slice(0, opts.limit ?? 8);
}
