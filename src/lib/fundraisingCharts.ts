// Pure helpers behind the race page's fundraising charts: money raised over
// time (cumulative per candidate, by month) and the mix of donation sizes.
// Rows come from cf_contributions_monthly / cf_contribution_sizes on the
// tracker (migration 20261028120000) or the hub_race_contribution_months /
// hub_race_contribution_sizes functions on the Local Politics Tracker.

/** Size bins, smallest first — the keys the SQL writes. */
export const SIZE_BINS = ["under_200", "200_to_999", "1k_to_9999", "10k_plus"] as const;
export type SizeBin = (typeof SIZE_BINS)[number];

export const SIZE_BIN_LABEL: Record<SizeBin, string> = {
  under_200: "Under $200",
  "200_to_999": "$200 – $999",
  "1k_to_9999": "$1,000 – $9,999",
  "10k_plus": "$10,000 and up",
};

/** The SQL's CASE, mirrored (pinned by the test suite). Negative rows land in the smallest bin. */
export function sizeBinFor(amount: number): SizeBin {
  if (amount < 200) return "under_200";
  if (amount < 1000) return "200_to_999";
  if (amount < 10000) return "1k_to_9999";
  return "10k_plus";
}

/** Ordinal ramp colour for bin `i` (0 = smallest): `--viz-ramp-1` … `--viz-ramp-4`. */
export function rampColor(i: number): string {
  return `var(--viz-ramp-${Math.min(Math.max(i, 0), 3) + 1})`;
}

export type MonthRow = { candidate_id: string; month: string; amount: number };
export type SizeRow = { candidate_id: string; size_bin: string; amount: number; contribution_count: number };

/** "2026-03-01" or "2026-03" → "2026-03". */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** Every month from `start` to `end` inclusive, as "YYYY-MM". */
export function monthRange(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  if (!y || !m || !ey || !em) return out;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break;
  }
  return out;
}

/**
 * The months the timeline spans: from the first month with money, but no
 * earlier than January of the year before the election (a mistyped year
 * is folded into that edge), to the current month.
 */
export function timelineWindow(rows: MonthRow[], generalDate: string, today: string): { start: string; end: string } | null {
  if (rows.length === 0) return null;
  const year = Number(generalDate.slice(0, 4)) || Number(today.slice(0, 4));
  const floor = `${year - 1}-01`;
  const first = rows.map((r) => monthKey(r.month)).sort()[0];
  const end = monthKey(today);
  const start = first > floor ? first : floor;
  return start <= end ? { start, end } : { start: end, end };
}

export type TimelinePoint = { month: string } & Record<string, number | string>;

/**
 * Cumulative dollars per key, one point per month of the window. `keys`
 * maps a series key to the candidate ids it sums (one id, or several for
 * an "all others" line). Months outside the window are folded into its
 * first or last month, so every line ends at the candidate's total.
 */
export function cumulativeByMonth(
  rows: MonthRow[],
  keys: Record<string, string[]>,
  window: { start: string; end: string },
): TimelinePoint[] {
  const months = monthRange(window.start, window.end);
  if (months.length === 0) return [];
  const idToKey = new Map<string, string>();
  for (const [key, ids] of Object.entries(keys)) for (const id of ids) idToKey.set(id, key);
  const perMonth = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = idToKey.get(r.candidate_id);
    if (!key) continue;
    let m = monthKey(r.month);
    if (m < window.start) m = window.start;
    else if (m > window.end) m = window.end;
    let bucket = perMonth.get(m);
    if (!bucket) perMonth.set(m, (bucket = {}));
    bucket[key] = (bucket[key] ?? 0) + Number(r.amount ?? 0);
  }
  const running: Record<string, number> = {};
  for (const key of Object.keys(keys)) running[key] = 0;
  return months.map((m) => {
    const bucket = perMonth.get(m) ?? {};
    const point: TimelinePoint = { month: m };
    for (const key of Object.keys(keys)) {
      running[key] += bucket[key] ?? 0;
      point[key] = Math.round(running[key]);
    }
    return point;
  });
}

export type SizeMixRow = {
  candidate_id: string;
  total: number;
  amounts: Record<SizeBin, number>;
  counts: Record<SizeBin, number>;
  /** Share of the candidate's total per bin, 0–1 (0 when the total is not positive). */
  shares: Record<SizeBin, number>;
};

const emptyBins = (): Record<SizeBin, number> => ({ under_200: 0, "200_to_999": 0, "1k_to_9999": 0, "10k_plus": 0 });

/** Per-candidate size mix from the bin rows; unknown bins are ignored. */
export function sizeMix(rows: SizeRow[]): Map<string, SizeMixRow> {
  const out = new Map<string, SizeMixRow>();
  for (const r of rows) {
    if (!(SIZE_BINS as readonly string[]).includes(r.size_bin)) continue;
    const bin = r.size_bin as SizeBin;
    let row = out.get(r.candidate_id);
    if (!row) {
      row = { candidate_id: r.candidate_id, total: 0, amounts: emptyBins(), counts: emptyBins(), shares: emptyBins() };
      out.set(r.candidate_id, row);
    }
    row.amounts[bin] += Number(r.amount ?? 0);
    row.counts[bin] += Number(r.contribution_count ?? 0);
    row.total += Number(r.amount ?? 0);
  }
  for (const row of out.values()) {
    for (const bin of SIZE_BINS) {
      // Negative bins (net refunds) take no width.
      row.shares[bin] = row.total > 0 ? Math.max(0, row.amounts[bin]) / row.total : 0;
    }
  }
  return out;
}

/** "2026-03" → "Mar '26". */
export function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[mo - 1]} '${String(y).slice(2)}`;
}

/** "2026-03" → "March 2026". */
export function monthLabelLong(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return m;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[mo - 1]} ${y}`;
}
