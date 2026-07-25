import { isCandidateActiveForRace } from "@/lib/candidateStatus";

/** The facts about a candidate that decide whether, and where, they appear. */
export type FieldEntry = {
  id: string;
  name: string;
  status: string | null;
  raised: number;
  pollPct: number | null;
};

/**
 * Split a race's candidates into the field to render and the ones held back
 * for having no campaign finance on record.
 *
 * Two rules, applied in order:
 *
 *  1. **Is this a candidate the race shows at all?** Polled races rank by
 *     polling average, so a candidate without one has no place on the grid;
 *     unpolled races rank by money and keep everyone still running.
 *  2. **Is there money on record?** This site exists to report what a campaign
 *     raised and from whom. With no filings there's nothing to report, so the
 *     candidate is held back and named separately rather than shown at $0 —
 *     which reads as "raised nothing" when it usually means "we haven't matched
 *     their committee yet".
 *
 * Order matters: someone failing rule 1 never reaches rule 2, so the
 * "no filings" note never names a candidate the race wasn't going to show.
 */
export function partitionField<T extends FieldEntry>(
  entries: T[],
  { polled, financeReady }: { polled: boolean; financeReady: boolean },
): { shown: T[]; withoutFilings: T[] } {
  const eligible = entries.filter((e) =>
    polled ? e.pollPct !== null : isCandidateActiveForRace(e.status) || e.status === "active",
  );

  const byRank = (a: T, b: T) =>
    polled
      ? (b.pollPct ?? -1) - (a.pollPct ?? -1) || b.raised - a.raised
      : b.raised - a.raised;

  // Candidate rows load before finance totals do; filtering on money before
  // the totals arrive would blank the grid on every page load.
  if (!financeReady) {
    return { shown: [...eligible].sort(byRank), withoutFilings: [] };
  }

  return {
    shown: eligible.filter((e) => e.raised > 0).sort(byRank),
    withoutFilings: eligible.filter((e) => e.raised <= 0),
  };
}
