import type { TxCandidate } from "@/hooks/useCandidates";
import { cn } from "@/lib/utils";

/**
 * Names the curated candidates a field is leaving out for having no campaign
 * finance on record. The site ranks people by their money, so someone with no
 * filings can't be ranked — but they're often a real candidate whose committee
 * we haven't matched yet, so say so instead of quietly dropping them.
 */
export default function NoFilingsNote({
  candidates,
  className,
}: {
  candidates: TxCandidate[];
  className?: string;
}) {
  if (!candidates.length) return null;
  const names = candidates.map((c) => c.name).join(", ");

  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      Not shown: {names} — {candidates.length === 1 ? "no campaign-finance filing is" : "no campaign-finance filings are"}{" "}
      on record for {candidates.length === 1 ? "this candidate" : "these candidates"} yet.
    </p>
  );
}
