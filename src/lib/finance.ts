export type Party = "D" | "R" | "I";

export const PARTY_COLOR: Record<string, string> = {
  D: "hsl(var(--dem))",
  R: "hsl(var(--rep))",
  I: "hsl(var(--ind))",
};

export const PARTY_LABEL: Record<string, string> = {
  D: "Democrat",
  R: "Republican",
  I: "Independent",
};

// Accepts either code ("D") or full name ("Democrat") — tx_candidates stores
// full names.
function partyKey(party: string | null | undefined): string {
  const s = (party ?? "").trim().toUpperCase();
  if (s.startsWith("D")) return "D";
  if (s.startsWith("R")) return "R";
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
