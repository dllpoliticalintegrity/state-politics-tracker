import { isOffBallot } from "./candidateStatus";
import { partyLabel } from "./finance";

type PartyCandidate = { party?: string | null };
type ComparisonCandidate = PartyCandidate & { id: string; name: string; status: string | null };

export function comparisonTextClass(party: string | null | undefined): string {
  const label = partyLabel(party);
  return label === "Democrat" ? "text-dem" : label === "Republican" ? "text-rep" : label === "Independent" ? "text-ind" : label === "Green" ? "text-grn" : "text-muted-foreground";
}

function partyPosition(candidate: PartyCandidate | undefined): number {
  const label = partyLabel(candidate?.party);
  return label === "Democrat" ? 0 : label === "Republican" ? 2 : 1;
}

/** Democrats and Republicans; third parties and independents are not. */
export function isMajorParty(candidate: PartyCandidate | undefined): boolean {
  return partyPosition(candidate) !== 1;
}

/**
 * The state overview card's order: by polling where the race is polled,
 * else by money — but, as in comparisonDefaults, Democrats and Republicans
 * before third parties when polling doesn't separate them, so the card's top
 * two in Arizona's unpolled Secretary of State race are the two major-party
 * nominees rather than the Green nominee's public financing (2026-10-19).
 * The top two are then ranked between themselves by the same measure, so
 * "Leads" still goes to the one ahead in polling or money.
 */
export function overviewOrder<T extends { c: PartyCandidate; raised: number; pct: number | null }>(
  rows: T[], polled: boolean,
): T[] {
  const measure = (a: T, b: T) =>
    polled ? (b.pct ?? -1) - (a.pct ?? -1) || b.raised - a.raised : b.raised - a.raised;
  const sorted = [...rows].sort((a, b) =>
    (polled ? (b.pct ?? -1) - (a.pct ?? -1) : 0) ||
    Number(isMajorParty(b.c)) - Number(isMajorParty(a.c)) ||
    measure(a, b));
  return [...sorted.slice(0, 2).sort(measure), ...sorted.slice(2)];
}

function orderPair<T extends PartyCandidate>(left: T | undefined, right: T | undefined): [T | undefined, T | undefined] {
  return partyPosition(left) > partyPosition(right) ? [right, left] : [left, right];
}

export function comparisonDefaults<T extends ComparisonCandidate>(
  candidates: T[],
  raised: (candidate: T) => number,
  polling: (candidate: T) => number | null,
): T[] {
  const confirmed = (candidate: T) => candidate.status === "nominee" || candidate.status === "won_primary";
  // After polling, the Democratic and Republican nominees come before third
  // parties: in an unpolled race, money alone put Arizona's Green nominee for
  // Secretary of State ($739K, nearly all public financing) in the pair and
  // left out the Republican nominee (2026-10-19). A third party that polls
  // still makes the pair on its polling.
  return candidates.filter((candidate) => !isOffBallot(candidate.status)).sort((a, b) =>
    Number(confirmed(b)) - Number(confirmed(a)) ||
    (polling(b) ?? -1) - (polling(a) ?? -1) ||
    Number(isMajorParty(b)) - Number(isMajorParty(a)) ||
    raised(b) - raised(a) || a.name.localeCompare(b.name),
  ).slice(0, 2).sort((a, b) => partyPosition(a) - partyPosition(b));
}

export function comparisonPair<T extends PartyCandidate & { slug: string }>(
  candidates: T[], defaults: T[], leftSlug: string | null, rightSlug: string | null,
): [T | undefined, T | undefined] {
  const left = candidates.find((c) => c.slug === leftSlug) ?? defaults[0];
  const requestedRight = candidates.find((c) => c.slug === rightSlug && c.slug !== left?.slug);
  const right = requestedRight ?? defaults.find((c) => c.slug !== left?.slug);
  return orderPair(left, right);
}