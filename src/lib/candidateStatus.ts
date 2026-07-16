// Active statuses for race displays (allowlist approach, matching vote-integrity)
export const RACE_ACTIVE_STATUSES = [
  "running",    // Internal: actively running
  "candidate",  // Internal: declared candidate
  "C",          // FEC: Statutory candidate (current active)
  "F",          // FEC: Statutory candidate for future election
  "N",          // FEC: Not yet a statutory candidate (allow if fundraising qualifies)
  "lost_primary", // Lost primary but still shown with tag
] as const;

export function isCandidateActiveForRace(status: string | null): boolean {
  if (!status) return false;
  return (RACE_ACTIVE_STATUSES as readonly string[]).includes(status);
}
