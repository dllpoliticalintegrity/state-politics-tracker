export type Party = "D" | "R" | "I" | "G";

export const PARTY_COLOR: Record<string, string> = {
  D: "hsl(var(--dem))",
  R: "hsl(var(--rep))",
  I: "hsl(var(--ind))",
  G: "hsl(var(--grn))",
};

export const PARTY_LABEL: Record<string, string> = {
  D: "Democrat",
  R: "Republican",
  I: "Independent",
  G: "Green",
};

// Accepts either code ("D") or full name ("Democrat") — tx_candidates stores
// full names. A party's name can also come with its state in front: Florida's
// legislators are filed as "Florida Democratic Party" (187 of them, gray as
// "Other" until 2026-10-19), so Democrat / Republican also match as a word
// anywhere. Green matches the word anywhere ("Green Party", "Florida Green
// Party", "Arizona Greens") or the code "G" (the LPT money river's
// partyCode), never a bare leading G, so "GOP" is not Green.
export function partyKey(party: string | null | undefined): string {
  const s = (party ?? "").trim().toUpperCase();
  if (s.startsWith("D") || /\bDEMOCRAT/.test(s)) return "D";
  if (s.startsWith("R") || /\bREPUBLICAN/.test(s)) return "R";
  if (s === "G" || /\bGREENS?\b/.test(s)) return "G";
  if (s.startsWith("I")) return "I";
  return "";
}

export function partyColor(party: string | null | undefined): string {
  return PARTY_COLOR[partyKey(party)] ?? "hsl(var(--muted-foreground))";
}

export const OFFICE_LABEL: Record<string, string> = {
  GOVERNOR: "Governor",
  LTGOVERNOR: "Lt. Governor",
  ATTYGEN: "Attorney General",
};

export function officeLabel(office: string | null | undefined): string {
  return OFFICE_LABEL[office ?? ""] ?? (office ?? "");
}

export function partyLabel(party: string | null | undefined): string {
  return PARTY_LABEL[partyKey(party)] ?? "Other";
}

export function formatCurrency(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export function formatCurrencyFull(n: number | null | undefined): string {
  const v = n ?? 0;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * Whether an organisation donor is a party committee, by name -- the party
 * rule of the tracker's cf_funding_category() (supabase/migrations/
 * 20261019000000_cf_funding_sources.sql), so both read a donor the same way:
 * "party" or "caucus" as a word, or Democratic / Republican with a committee
 * word ("Jackson County Democratic Central Committee"). For states read from
 * the Local Politics Tracker, which only types donors as individual or
 * organisation: the Democratic Party of Oregon was counted with PACs and
 * firms on Oregon candidates' pages (2026-10-21).
 */
export function isPartyCommittee(name: string | null | undefined): boolean {
  const org = (name ?? "").toLowerCase();
  if (/\b(party|caucus)\b/.test(org)) return true;
  return (
    /\b(democratic|democrats?|republicans?|gop|dem|rep)\b/.test(org) &&
    /\b(committee|comm|com|senate|senatorial|house|assembly|governors|legislative)\b/.test(org)
  );
}

export function contributorTypeLabel(code: string | null | undefined): string {
  // TEC receipt-level codes: INDIVIDUAL vs ENTITY (businesses, PACs, firms).
  switch ((code ?? "").toUpperCase()) {
    case "INDIVIDUAL":
      return "Individual";
    case "ENTITY":
      return "Entity / PAC";
    default:
      return "Unknown";
  }
}
