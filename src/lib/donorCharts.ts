// Pure helpers behind the donor charts: the pie on a race's Top Donors page
// and the treemap of a state's top 100 donors on its home page. Both read
// the same aggregated donor rows the Top Donors list shows.
//
// Colours are the `--viz-*` custom properties in src/index.css: six
// categorical hues in a fixed order (a donor keeps its hue however the
// list is filtered) plus a neutral for "Other" / unknown. The hues were
// validated for colour-vision deficiency and contrast on the site's light
// and dark card surfaces; light mode needs visible labels beside the
// marks, which the legend and the list view provide.

/** Hue slots available to a categorical chart (`--viz-1` … `--viz-6`). */
export const VIZ_SERIES = 6;

/** CSS colour for categorical slot `i` (0-based); null = the neutral. */
export function vizColor(i: number | null): string {
  return i === null ? "var(--viz-neutral)" : `var(--viz-${(i % VIZ_SERIES) + 1})`;
}

export type DonorLike = {
  key: string;
  display_name: string;
  contributor_type: string | null;
  contribution_count: number;
  total_amount: number;
};

export type PieSlice = {
  key: string;
  name: string;
  amount: number;
  /** Share of the charted total, 0–1. */
  pct: number;
  /** Categorical slot, or null for the folded "Other" slice. */
  series: number | null;
  /** How many donors the slice stands for (1, or the fold count). */
  donors: number;
};

/**
 * The top `max` donors as pie slices, the rest folded into one "Other"
 * slice so the chart stays readable: past six or so segments a pie is a
 * guess, and the list view already has every row. Donors with no money
 * given are left out.
 */
export function pieSlices(donors: DonorLike[], max = VIZ_SERIES): PieSlice[] {
  const ranked = donors.filter((d) => d.total_amount > 0).sort((a, b) => b.total_amount - a.total_amount);
  const total = ranked.reduce((s, d) => s + d.total_amount, 0);
  if (total <= 0) return [];
  const head = ranked.slice(0, Math.min(max, VIZ_SERIES));
  const tail = ranked.slice(head.length);
  const slices: PieSlice[] = head.map((d, i) => ({
    key: d.key,
    name: d.display_name,
    amount: d.total_amount,
    pct: d.total_amount / total,
    series: i,
    donors: 1,
  }));
  if (tail.length) {
    const amount = tail.reduce((s, d) => s + d.total_amount, 0);
    slices.push({
      key: "__other",
      name: `Other (${tail.length} donor${tail.length === 1 ? "" : "s"})`,
      amount,
      pct: amount / total,
      series: null,
      donors: tail.length,
    });
  }
  return slices;
}

export type DonorKindClass = "individual" | "entity" | "unknown";

/** Individual vs. entity/PAC vs. unknown, from the importers' contributor_type. */
export function donorKindClass(contributorType: string | null | undefined): DonorKindClass {
  switch ((contributorType ?? "").toUpperCase()) {
    case "INDIVIDUAL":
      return "individual";
    case "":
      return "unknown";
    default:
      // ENTITY and every other institutional code the importers write.
      return "entity";
  }
}

export const DONOR_KIND_LABEL: Record<DonorKindClass, string> = {
  individual: "Individuals",
  entity: "Entities & PACs",
  unknown: "Unknown type",
};

/** Colour slot per donor kind: blue / orange / neutral. */
export const DONOR_KIND_SERIES: Record<DonorKindClass, number | null> = {
  individual: 0,
  entity: 1,
  unknown: null,
};

export type TreemapCell = {
  key: string;
  name: string;
  /** recharts' size key. */
  value: number;
  kind: DonorKindClass;
  gifts: number;
  rank: number;
};

/** The top `limit` donors as treemap cells, largest first. */
export function treemapCells(donors: DonorLike[], limit = 100): TreemapCell[] {
  return donors
    .filter((d) => d.total_amount > 0)
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, limit)
    .map((d, i) => ({
      key: d.key,
      name: d.display_name,
      value: d.total_amount,
      kind: donorKindClass(d.contributor_type),
      gifts: d.contribution_count,
      rank: i + 1,
    }));
}

/**
 * Whether a treemap cell is big enough to carry a label, and how many
 * lines of it: name only, or name + amount.
 */
export function cellLabelLines(width: number, height: number): 0 | 1 | 2 {
  if (width < 44 || height < 18) return 0;
  if (height < 34 || width < 64) return 1;
  return 2;
}

/**
 * Cut a label to what fits a cell of `width` px. 7 px per character is
 * the 11 px bold label's upper-case average (donor names are mostly
 * upper case); the cell also clips, so a wide glyph run never spills.
 */
export function fitLabel(name: string, width: number, pxPerChar = 7): string {
  const max = Math.max(0, Math.floor((width - 10) / pxPerChar));
  if (name.length <= max) return name;
  if (max < 4) return "";
  return `${name.slice(0, max - 1).trimEnd()}…`;
}
