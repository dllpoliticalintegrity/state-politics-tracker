import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import OfficialPhoto from "@/components/OfficialPhoto";
import { useCandidates } from "@/hooks/useCandidates";
import { useIncumbent } from "@/hooks/useOfficials";
import { partyColor, partyLabel } from "@/lib/finance";
import {
  OPENSTATES_URL,
  formatTermEnd,
  isSamePerson,
  officeIsCoveredByOpenStates,
} from "@/lib/openstates";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";

/**
 * "Who holds this office now" — the sitting officeholder beside the 2026 field,
 * from Open States. Renders nothing when Open States doesn't cover the office
 * (Florida's CFO and Agriculture Commissioner) or the roster hasn't synced.
 */
export default function IncumbentCard() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const base = useRaceBase();
  const { data: incumbent } = useIncumbent();
  const { data: candidates } = useCandidates();

  if (!officeIsCoveredByOpenStates(race.office) || !incumbent) return null;

  const color = partyColor(incumbent.party);
  const termEnd = formatTermEnd(incumbent.term_end);
  // The incumbent seeking another term links through to their candidate page;
  // otherwise this is just context for an open seat.
  const asCandidate = (candidates ?? []).find((c) => isSamePerson(incumbent.name, c.name));
  const officialLink = (incumbent.links ?? []).find((l) => !l.note)?.url ?? null;

  return (
    <Card className="p-4 md:p-5">
      <div className="flex items-start gap-4">
        <OfficialPhoto name={incumbent.name} imageUrl={incumbent.image_url} borderColor={color} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Currently in office
          </div>
          <div className="font-display text-lg font-semibold leading-tight mt-0.5">
            {asCandidate ? (
              <Link to={`${base}/candidates/${asCandidate.slug}`} className="hover:underline">
                {incumbent.name}
              </Link>
            ) : (
              incumbent.name
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {partyLabel(incumbent.party)} · {stateCfg.name} {race.title}
            {termEnd ? ` · ${termEnd}` : ""}
          </div>
          <div className="text-xs mt-2">
            {asCandidate ? (
              <Link to={`${base}/candidates/${asCandidate.slug}`} className="text-primary hover:underline">
                On the 2026 ballot for this office — see their filings →
              </Link>
            ) : (
              <span className="text-muted-foreground">
                Not among the 2026 candidates tracked for this race.
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t text-xs">
        {officialLink && (
          <a
            href={officialLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            Official site <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {incumbent.phone && <span className="text-muted-foreground">{incumbent.phone}</span>}
        <a
          href={OPENSTATES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground ml-auto"
        >
          Officeholder data: Open States ↗
        </a>
      </div>
    </Card>
  );
}
