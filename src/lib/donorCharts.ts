// Pure helpers behind the donor charts: the pie and treemap on a race's Top
// Donors page and the treemap of a state's top 100 donors on its home page.
// All read the same aggregated donor rows the Top Donors list shows.
//
// A donor's party is designated the way the site designates a candidate's:
// from the `party` field of the candidates the donor gave to (partyKey in
// src/lib/finance.ts). One party → that party; money to more than one →
// "mixed". Only when no recipient is known (donors to outside committees)
// does the organisation's own name decide, and only for a name that says
// Democratic / Republican / GOP.
//
// Colours are the `--viz-*` custom properties in src/index.css: six
// categorical hues in a fixed order (a donor keeps its hue however the
// list is filtered) plus a neutral for "Other" / unknown. None of the six
// is blue or red: those mean Democratic and Republican everywhere on the
// site (`--dem` / `--rep`), and a donor or candidate of a party is drawn
// in its colour. The hues were validated for colour-vision deficiency and
// contrast on the site's light and dark card surfaces; light mode needs
// visible labels beside the marks, which the legend and the list view
// provide.

import { contributorTypeLabel, partyColor, partyKey } from "@/lib/finance";

/** Hue slots available to a categorical chart (`--viz-1` … `--viz-6`). */
export const VIZ_SERIES = 6;

/** CSS colour for categorical slot `i` (0-based); null = the neutral. */
export function vizColor(i: number | null): string {
  return i === null ? "var(--viz-neutral)" : `var(--viz-${(i % VIZ_SERIES) + 1})`;
}

/** A party key as partyKey() gives it, "mixed" for money to more than one party, "" for none known. */
export type DonorParty = "D" | "R" | "I" | "G" | "mixed" | "";

export type DonorLike = {
  key: string;
  display_name: string;
  contributor_type: string | null;
  contribution_count: number;
  total_amount: number;
  /** The party of the candidates the donor gave to (recipientParty), when the page knows them. */
  party?: DonorParty;
};

/**
 * A donor's party from the candidates they gave to, each read with the
 * site's own partyKey(): one party → that party, several → "mixed", none
 * known → "". Gifts of nothing (refund-only splits) carry no party.
 */
export function recipientParty(
  splits: { candidate_id: string; total_amount: number }[],
  partyOf: (candidateId: string) => string | null | undefined,
): DonorParty {
  const seen = new Set<string>();
  for (const sp of splits) {
    if (sp.total_amount <= 0) continue;
    const k = partyKey(partyOf(sp.candidate_id));
    if (k) seen.add(k);
  }
  if (seen.size === 0) return "";
  if (seen.size > 1) return "mixed";
  return [...seen][0] as DonorParty;
}

/**
 * The fallback for a donor with no known recipients: an organisation whose
 * name says Democratic / Democrats ("D") or Republican / Republicans / GOP
 * ("R"). A person's name is never read as a party.
 */
export function donorPartyKey(name: string | null | undefined, contributorType?: string | null): "D" | "R" | "" {
  if ((contributorType ?? "").toUpperCase() === "INDIVIDUAL") return "";
  const org = (name ?? "").toLowerCase();
  const dem = /\b(democratic|democrats?)\b/.test(org);
  const rep = /\b(republicans?|gop)\b/.test(org);
  if (dem && !rep) return "D";
  if (rep && !dem) return "R";
  return "";
}

/** The donor's party: from their recipients when the page knows them, else from their name. */
export function donorParty(d: DonorLike): DonorParty {
  return d.party || donorPartyKey(d.display_name, d.contributor_type);
}

const isParty = (p: DonorParty): p is "D" | "R" | "I" | "G" => p === "D" || p === "R" || p === "I" || p === "G";

/**
 * A party's colour (the site's partyColor), stepped for the nth mark of
 * that party on one chart: the base hue first, then a lighter and a darker
 * step, then the lightest — so the party reads at a glance and the legend
 * tells the marks apart.
 */
export function partyShade(party: string | null | undefined, nth = 0): string {
  const base = partyColor(party);
  if (nth === 0) return base;
  if (nth === 1) return `color-mix(in oklab, ${base} 55%, white)`;
  if (nth === 2) return `color-mix(in oklab, ${base} 65%, black)`;
  return `color-mix(in oklab, ${base} 35%, white)`;
}

export type PieSlice = {
  key: string;
  name: string;
  amount: number;
  /** Share of the charted total, 0–1. */
  pct: number;
  /** Categorical slot, or null for the folded "Other" slice. */
  series: number | null;
  /** The donor's party: drawn in that colour (stepped per party) instead of the slot's. */
  party: DonorParty;
  /** Which slice of that party this is, for the shade step. */
  partyNth: number;
  /** How many donors the slice stands for (1, or the fold count). */
  donors: number;
};

/** A slice's fill: its party's colour when it has one, else its slot's (mixed and unknown alike). */
export function sliceColor(s: Pick<PieSlice, "series" | "party" | "partyNth">): string {
  return isParty(s.party) ? partyShade(s.party, s.partyNth) : vizColor(s.series);
}

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
  const nthOf = new Map<string, number>();
  const slices: PieSlice[] = head.map((d, i) => {
    const party = donorParty(d);
    const partyNth = nthOf.get(party) ?? 0;
    nthOf.set(party, partyNth + 1);
    return {
      key: d.key,
      name: d.display_name,
      amount: d.total_amount,
      pct: d.total_amount / total,
      series: i,
      party,
      partyNth,
      donors: 1,
    };
  });
  if (tail.length) {
    const amount = tail.reduce((s, d) => s + d.total_amount, 0);
    slices.push({
      key: "__other",
      name: `Other (${tail.length} donor${tail.length === 1 ? "" : "s"})`,
      amount,
      pct: amount / total,
      series: null,
      party: "",
      partyNth: 0,
      donors: tail.length,
    });
  }
  return slices;
}

export type DonorKindClass = "democratic" | "republican" | "other_party" | "both" | "unknown";

/** A donor's class for the treemap, from their party. */
export function donorKindClass(party: DonorParty): DonorKindClass {
  switch (party) {
    case "D":
      return "democratic";
    case "R":
      return "republican";
    case "I":
    case "G":
      return "other_party";
    case "mixed":
      return "both";
    default:
      return "unknown";
  }
}

/** Legend order. */
export const DONOR_KINDS: DonorKindClass[] = ["democratic", "republican", "other_party", "both", "unknown"];

export const DONOR_KIND_LABEL: Record<DonorKindClass, string> = {
  democratic: "Gives to Democrats",
  republican: "Gives to Republicans",
  other_party: "Gives to other parties",
  both: "Gives to both parties",
  unknown: "No party known",
};

/**
 * Fill per class: the site's party colours (Democratic blue, Republican
 * red, the independent tone for other parties), the neutral for donors to
 * both parties and a muted tone for donors whose recipients are unknown.
 */
export const DONOR_KIND_COLOR: Record<DonorKindClass, string> = {
  democratic: "hsl(var(--dem))",
  republican: "hsl(var(--rep))",
  other_party: "hsl(var(--ind))",
  both: "var(--viz-neutral)",
  unknown: "var(--viz-entity)",
};

export type TreemapCell = {
  key: string;
  name: string;
  /** recharts' size key. */
  value: number;
  kind: DonorKindClass;
  /** "Individual" / "Entity / PAC", for the tooltip. */
  typeLabel: string;
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
      kind: donorKindClass(donorParty(d)),
      typeLabel: contributorTypeLabel(d.contributor_type),
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
