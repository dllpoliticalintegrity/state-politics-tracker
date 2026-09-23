// Active statuses for race displays (allowlist approach, matching vote-integrity)
export const RACE_ACTIVE_STATUSES = [
  "running",    // Internal: actively running
  "candidate",  // Internal: declared candidate
  "C",          // FEC: Statutory candidate (current active)
  "F",          // FEC: Statutory candidate for future election
  "N",          // FEC: Not yet a statutory candidate (allow if fundraising qualifies)
  "lost_primary", // Lost primary but still shown with tag
  // Ballot statuses set from the state's certified candidate listings
  // (Michigan: import_pilot_finance.py sync_michigan_ballot_status).
  "active",       // No listing has settled this candidate yet
  "won_primary",  // On the general-election listing after a primary
  "nominee",      // On the general-election listing without a primary (convention / independent)
] as const;

/** Statuses that mean the candidate is off the ballot (greyed out with a tag). */
export const INACTIVE_STATUSES = ["withdrawn", "dropped_out", "eliminated", "lost_primary", "disqualified", "not_on_ballot"] as const;

export function inactiveLabel(status: string | null): string | null {
  switch (status) {
    case "eliminated":
    case "lost_primary":
      return "Lost primary";
    case "disqualified":
      return "Disqualified";
    case "not_on_ballot":
      return "Not on ballot";
    case "withdrawn":
    case "dropped_out":
      return "Withdrawn";
    default:
      return null;
  }
}

/** A positive ballot tag for candidates confirmed for November. */
export function ballotLabel(status: string | null): string | null {
  if (status === "won_primary") return "Won primary";
  if (status === "nominee") return "Nominee";
  return null;
}

/**
 * Off the ballot for November (lost a primary, withdrawn, disqualified, never
 * filed). Race pages keep these candidates but grey them out and rank them
 * last; pages shared across candidates — the chamber overview and its map,
 * the contributions ticker, the outside-spending leaderboard — hide them.
 */
export function isOffBallot(status: string | null | undefined): boolean {
  return (INACTIVE_STATUSES as readonly string[]).includes(status ?? "");
}

/** Keep only candidates still in the race. */
export function onBallot<T extends { status: string | null }>(list: T[] | undefined | null): T[] {
  return (list ?? []).filter((c) => !isOffBallot(c.status));
}

/** Sort comparator fragment: candidates still in the race before those who are out. */
export function offBallotLast(a: { status: string | null }, b: { status: string | null }): number {
  return Number(isOffBallot(a.status)) - Number(isOffBallot(b.status));
}

export function isCandidateActiveForRace(status: string | null): boolean {
  if (!status) return false;
  return (RACE_ACTIVE_STATUSES as readonly string[]).includes(status);
}
