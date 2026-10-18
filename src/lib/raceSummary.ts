// Pure aggregation behind the race page's summary cards: raised/spent,
// funding sources and money by party, scoped to one race's candidates.
import { INACTIVE_STATUSES } from "@/lib/candidateStatus";

export type FundingCategory = "individuals" | "self" | "party" | "pac" | "public" | "other";

/** Display order, labels and colours for the Funding Sources donut. */
export const FUNDING_CATEGORIES: { key: FundingCategory; label: string; color: string }[] = [
  { key: "individuals", label: "Individuals", color: "hsl(213 75% 56%)" },
  { key: "self", label: "Self-funding", color: "hsl(40 85% 47%)" },
  { key: "party", label: "Party", color: "hsl(158 64% 40%)" },
  { key: "pac", label: "PACs & committees", color: "hsl(16 75% 52%)" },
  { key: "public", label: "Public financing", color: "hsl(265 50% 60%)" },
  { key: "other", label: "Other organizations", color: "hsl(335 65% 58%)" },
];

export interface FundingRow {
  candidate_id: string;
  category: string;
  amount: number | string | null;
}

export interface Slice {
  key: string;
  label: string;
  color: string;
  amount: number;
  /** Share of the total, 0–100. */
  pct: number;
}

function withShares(slices: Omit<Slice, "pct">[]): Slice[] {
  const total = slices.reduce((s, x) => s + x.amount, 0);
  return slices.map((s) => ({ ...s, pct: total > 0 ? (s.amount / total) * 100 : 0 }));
}

/** Funding-source slices for the race's candidates (empty categories dropped, except the three core ones). */
export function fundingSlices(rows: FundingRow[], candidateIds: Set<string>): Slice[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (!candidateIds.has(r.candidate_id)) continue;
    sums.set(r.category, (sums.get(r.category) ?? 0) + Number(r.amount ?? 0));
  }
  return withShares(
    FUNDING_CATEGORIES.filter(
      (c) => (sums.get(c.key) ?? 0) > 0 || c.key === "individuals" || c.key === "pac" || c.key === "self",
    ).map((c) => ({ key: c.key, label: c.label, color: c.color, amount: sums.get(c.key) ?? 0 })),
  );
}

/** A filing's party, folded to the labels the Money by Party donut uses. */
export function partyBucket(party: string | null | undefined): string {
  const p = (party ?? "").trim().toLowerCase();
  if (!p) return "Other";
  if (p === "d" || p.startsWith("dem")) return "Democrat";
  if (p === "r" || p.startsWith("rep")) return "Republican";
  if (p === "l" || p.startsWith("lib")) return "Libertarian";
  if (p === "g" || p.startsWith("green")) return "Green";
  if (p === "i" || p.startsWith("ind") || p.includes("no party")) return "Independent";
  return "Other";
}

const PARTY_ORDER = ["Democrat", "Republican", "Libertarian", "Green", "Independent", "Other"];
export const PARTY_SLICE_COLOR: Record<string, string> = {
  Democrat: "hsl(var(--dem))",
  Republican: "hsl(var(--rep))",
  Libertarian: "hsl(48 90% 50%)",
  Green: "hsl(130 45% 42%)",
  Independent: "hsl(var(--ind))",
  Other: "hsl(335 65% 58%)",
};

export interface CandidateLite {
  id: string;
  party: string | null;
  status?: string | null;
}

/** Money raised by party, and candidate counts by party. */
export function partySlices(
  candidates: CandidateLite[],
  raisedById: Map<string, number>,
): { slices: Slice[]; counts: { label: string; count: number }[] } {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const b = partyBucket(c.party);
    sums.set(b, (sums.get(b) ?? 0) + (raisedById.get(c.id) ?? 0));
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const present = PARTY_ORDER.filter((p) => counts.has(p));
  return {
    slices: withShares(present.map((p) => ({ key: p, label: p, color: PARTY_SLICE_COLOR[p], amount: sums.get(p) ?? 0 }))),
    counts: present.map((p) => ({ label: p, count: counts.get(p) ?? 0 })),
  };
}

const INACTIVE: ReadonlySet<string> = new Set(INACTIVE_STATUSES);

/** Candidates still running vs no longer running. */
export function runningCounts(candidates: CandidateLite[]): { running: number; out: number } {
  let out = 0;
  for (const c of candidates) if (INACTIVE.has(c.status ?? "")) out += 1;
  return { running: candidates.length - out, out };
}
