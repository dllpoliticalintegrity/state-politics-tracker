import { useCandidates, useCandidateTotals, type TxCandidate } from "@/hooks/useCandidates";
import { isGeneralMatchup, useRacePolling, useRacePolls } from "@/hooks/usePolling";
import { useRaceConfig } from "@/states/StateContext";
import { partitionField, type FieldEntry } from "@/lib/field";
import type { CandidateCardStats } from "@/components/CandidateCard";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RankedCandidate = FieldEntry & { c: TxCandidate; stats: CandidateCardStats };

export type RankedField = {
  /** The field to render, already filtered and ranked. */
  ranked: RankedCandidate[];
  /**
   * Curated candidates dropped *only* because no campaign-finance filings are
   * on record — surfaced so a page can say who it isn't showing rather than
   * silently erasing them.
   */
  withoutFilings: TxCandidate[];
  isLoading: boolean;
  error: unknown;
};

/**
 * The ranked field for the active race, shared by the race home page and the
 * candidates page so both apply the same rules:
 *
 *  - Only candidates with money on record. A curated candidate with no filings
 *    is either a data gap (no committee registration found yet) or someone who
 *    hasn't raised anything — either way we can't say anything about their
 *    money, which is what this site is for.
 *  - Polled races rank by polling average and need one; unpolled races rank by
 *    total raised and keep every active candidate.
 */
export function useRankedField(): RankedField {
  const race = useRaceConfig();
  const hasPollingSource = !!race.pollingSourceUrl;
  const { data: candidates, isLoading, error } = useCandidates();
  const { data: totalsMap, isLoading: totalsLoading } = useCandidateTotals();
  const { data: polling } = useRacePolling();
  const { data: racePollsAll } = useRacePolls();
  const racePolls = (racePollsAll ?? []).filter((r) => isGeneralMatchup(r.matchup));

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);

  const withStats: RankedCandidate[] = (candidates ?? []).map((c) => {
    const surname = c.name.trim().split(/\s+/).pop() ?? "";
    // Per-poll rows for this candidate from the 270toWin backfill.
    const rawSeries = racePolls
      .filter((r) => (r.candidate_name.trim().split(/\s+/).pop() ?? "") === surname)
      .map((r) => {
        const iso = (r.field_end ?? "").slice(0, 10);
        const n = Number(r.pct);
        if (!iso || iso > todayIso || !Number.isFinite(n)) return null;
        return { iso, pct: n };
      })
      .filter((x): x is { iso: string; pct: number } => x !== null)
      .sort((a, b) => a.iso.localeCompare(b.iso));

    const avgRaw = polling?.average?.[surname];
    const avgPct = avgRaw !== undefined && avgRaw !== "" ? Number(avgRaw) : null;
    const validAvg = avgPct !== null && Number.isFinite(avgPct) && avgPct > 0 ? avgPct : null;

    // 90-day delta: current average minus the mean of polls from ≥90 days ago.
    let pollDelta: number | null = null;
    if (validAvg !== null && rawSeries.length >= 2) {
      const earlier = rawSeries.filter((r) => r.iso <= ninetyDaysAgo);
      if (earlier.length > 0) {
        pollDelta =
          Math.round((validAvg - earlier.reduce((s, r) => s + r.pct, 0) / earlier.length) * 10) / 10;
      }
    }

    const raised = totalsMap?.get(c.id)?.raised ?? 0;
    return {
      // Flattened for partitionField…
      id: c.id,
      name: c.name,
      status: c.status,
      raised,
      pollPct: validAvg,
      // …and kept whole for the cards.
      c,
      stats: { pollPct: validAvg, pollDelta, pollSeries: rawSeries.map((r) => r.pct), raised },
    };
  });

  const { shown, withoutFilings } = partitionField(withStats, {
    polled: hasPollingSource,
    financeReady: !totalsLoading,
  });

  return {
    ranked: shown,
    withoutFilings: withoutFilings.map((x) => x.c),
    isLoading: isLoading || totalsLoading,
    error,
  };
}
