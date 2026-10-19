import { isOffBallot } from "./candidateStatus";
import { partyLabel } from "./finance";

type PartyCandidate = { party?: string | null };
type ComparisonCandidate = PartyCandidate & { id: string; name: string; status: string | null };

export function comparisonTextClass(party: string | null | undefined): string {
  const label = partyLabel(party);
  return label === "Democrat" ? "text-dem" : label === "Republican" ? "text-rep" : label === "Independent" ? "text-ind" : "text-muted-foreground";
}

function partyPosition(candidate: PartyCandidate | undefined): number {
  const label = partyLabel(candidate?.party);
  return label === "Democrat" ? 0 : label === "Republican" ? 2 : 1;
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
  return candidates.filter((candidate) => !isOffBallot(candidate.status)).sort((a, b) =>
    Number(confirmed(b)) - Number(confirmed(a)) ||
    (polling(b) ?? -1) - (polling(a) ?? -1) ||
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