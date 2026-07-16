// Central registry of every state the tracker knows about. This module is
// the single source of truth for routing, the header switcher, the landing
// grid, and (later) per-state SEO and data-sync workflows — see docs/plan.md.

export type StateStatus =
  // Dashboard published on this site.
  | "live"
  // SLCF pipeline implemented upstream; data importable, dashboard not yet curated.
  | "ready"
  // No data pipeline yet.
  | "planned"
  // Tracked on a separate Political Integrity Project site; tiles link out.
  | "external";

export interface StateConfig {
  code: string; // lowercase two-letter code, used as the URL segment
  name: string;
  status: StateStatus;
  /** e.g. "2026 Michigan Governor's race" — required once status is "live". */
  raceTitle?: string;
  /** ISO date of the general election. */
  generalDate?: string;
  /** The state's campaign-finance disclosure agency. */
  agency?: { name: string; url: string };
  /** 270toWin page for the tracked race. */
  pollingSourceUrl?: string;
  /** Required when status is "external". */
  externalUrl?: string;
}

// States with a complete pipeline in hderyke/state-level-campaign-finance.
// (California is also implemented there, but stays "external" while
// ca-gov-polling remains the CA home.)
const SLCF_READY = new Set([
  "al", "ak", "az", "ar", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "pa",
]);

const EXTERNAL: Record<string, string> = {
  tx: "https://texaspoliticstracker.com",
  // TODO: swap for the CA site's production domain once confirmed.
  ca: "https://github.com/dllpoliticalintegrity/ca-gov-polling",
};

const ALL_STATES: Array<[string, string]> = [
  ["al", "Alabama"], ["ak", "Alaska"], ["az", "Arizona"], ["ar", "Arkansas"],
  ["ca", "California"], ["co", "Colorado"], ["ct", "Connecticut"],
  ["de", "Delaware"], ["fl", "Florida"], ["ga", "Georgia"], ["hi", "Hawaii"],
  ["id", "Idaho"], ["il", "Illinois"], ["in", "Indiana"], ["ia", "Iowa"],
  ["ks", "Kansas"], ["ky", "Kentucky"], ["la", "Louisiana"], ["me", "Maine"],
  ["md", "Maryland"], ["ma", "Massachusetts"], ["mi", "Michigan"],
  ["mn", "Minnesota"], ["ms", "Mississippi"], ["mo", "Missouri"],
  ["mt", "Montana"], ["ne", "Nebraska"], ["nv", "Nevada"],
  ["nh", "New Hampshire"], ["nj", "New Jersey"], ["nm", "New Mexico"],
  ["ny", "New York"], ["nc", "North Carolina"], ["nd", "North Dakota"],
  ["oh", "Ohio"], ["ok", "Oklahoma"], ["or", "Oregon"],
  ["pa", "Pennsylvania"], ["ri", "Rhode Island"], ["sc", "South Carolina"],
  ["sd", "South Dakota"], ["tn", "Tennessee"], ["tx", "Texas"],
  ["ut", "Utah"], ["vt", "Vermont"], ["va", "Virginia"],
  ["wa", "Washington"], ["wv", "West Virginia"], ["wi", "Wisconsin"],
  ["wy", "Wyoming"],
];

// Phase 2 promotes pilot states to "live" here, filling in raceTitle,
// generalDate, agency, and pollingSourceUrl (suggested pilots: FL, MI, GA).
export const STATES: StateConfig[] = ALL_STATES.map(([code, name]) => ({
  code,
  name,
  status: EXTERNAL[code] ? "external" : SLCF_READY.has(code) ? "ready" : "planned",
  externalUrl: EXTERNAL[code],
}));

const byCode = new Map(STATES.map((s) => [s.code, s]));

export function getState(code: string | undefined): StateConfig | undefined {
  return code ? byCode.get(code.toLowerCase()) : undefined;
}

export const liveStates = () => STATES.filter((s) => s.status === "live");
