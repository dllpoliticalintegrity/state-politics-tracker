import { useMemo } from "react";
import {
  useLatestContributions,
  formatContributionAmount,
  donorDisplayName,
  donorContext,
  candidateShort,
  contributionVerb,
} from "@/hooks/useLatestContributions";
import { partyColor } from "@/lib/finance";

/**
 * Slim marquee of the latest large contributions in the race. The one piece
 * of the site that genuinely updates between visits, so it gets the one
 * live indicator.
 */
export default function ContributionsTicker() {
  const { data: contribs } = useLatestContributions(20);

  // Doubled for a seamless marquee loop.
  const items = useMemo(() => {
    if (!contribs || contribs.length === 0) return null;
    return [...contribs, ...contribs];
  }, [contribs]);

  if (!items) return null;

  return (
    <div
      className="border-b bg-card overflow-hidden"
      aria-label="Latest contributions"
    >
      <div className="flex items-stretch">
        <div className="flex items-center gap-1.5 shrink-0 px-3 md:px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground border-r bg-muted/50 whitespace-nowrap">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
          </span>
          Latest gifts
        </div>
        <div className="relative flex-1 overflow-hidden">
          <div className="flex items-center gap-8 whitespace-nowrap py-1.5 pl-4 w-max motion-safe:animate-ticker motion-reduce:overflow-x-auto">
            {items.map((c, i) => {
              const ctx = donorContext(c);
              const kind = contributionVerb(c);
              return (
                <span key={`${c.id}-${i}`} className="inline-flex items-baseline gap-1.5 text-xs">
                  <span className="text-[10px] font-semibold text-muted-foreground border rounded-sm px-1">
                    {kind.label}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">
                    {formatContributionAmount(c.amount)}
                  </span>
                  <span className="font-medium">{donorDisplayName(c)}</span>
                  {ctx && <span className="text-muted-foreground">({ctx.toLowerCase()})</span>}
                  <span className="text-muted-foreground">→</span>
                  <span
                    className="font-semibold"
                    style={{ color: partyColor(c.candidate_party) }}
                  >
                    {candidateShort(c.candidate_name)}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
