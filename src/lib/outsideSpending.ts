import type { TxIeByCandidate } from "@/hooks/useCandidates";

/**
 * cf_ie_by_candidate has one row per candidate per cycle (primary-2026,
 * general-2026, runoff-2026, unknown, …). The outside-spending page's "All
 * cycles" view needs one row per candidate: dollars and support/oppose counts
 * add up across cycles. The matview's committee_count is a distinct count
 * within one cycle, so the merged row keeps the largest one — a committee that
 * spent in two cycles must not count twice — which makes it a floor.
 */
export function mergeIeCycles(rows: TxIeByCandidate[]): TxIeByCandidate[] {
  const byCandidate = new Map<string, TxIeByCandidate>();
  for (const r of rows) {
    const m = byCandidate.get(r.candidate_id);
    if (!m) {
      byCandidate.set(r.candidate_id, { ...r, cycle: "all" });
      continue;
    }
    m.total_supporting = Number(m.total_supporting ?? 0) + Number(r.total_supporting ?? 0);
    m.total_opposing = Number(m.total_opposing ?? 0) + Number(r.total_opposing ?? 0);
    m.supporting_count = Number(m.supporting_count ?? 0) + Number(r.supporting_count ?? 0);
    m.opposing_count = Number(m.opposing_count ?? 0) + Number(r.opposing_count ?? 0);
    m.committee_count = Math.max(Number(m.committee_count ?? 0), Number(r.committee_count ?? 0));
    if (r.as_of && (!m.as_of || r.as_of > m.as_of)) m.as_of = r.as_of;
  }
  return [...byCandidate.values()];
}
