// One statewide race on the state overview: its leading candidates (by
// polling average where the race is polled, else by money raised), the
// race's total raised and a link into the race. Renders inside the race's
// RaceProvider so it reuses (and warms) the race page's own queries.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useCandidates, useCandidateTotals } from "@/hooks/useCandidates";
import { readCandidatePct, useRacePolling } from "@/hooks/usePolling";
import { formatCurrency, partyColor, partyLabel } from "@/lib/finance";
import { onBallot } from "@/lib/candidateStatus";
import { racePath, useRaceConfig, useStateConfig } from "@/states/StateContext";

const SHOWN = 3;

export default function RaceOverviewCard() {
  const state = useStateConfig();
  const race = useRaceConfig();
  const polled = !!race.pollingSourceUrl;
  const { data: candidates, isLoading } = useCandidates();
  const { data: totals } = useCandidateTotals();
  const { data: polling } = useRacePolling();

  const rows = onBallot(candidates ?? []).map((c) => {
    const pct = polled && polling ? readCandidatePct(polling.average, c.name, c.id) : null;
    return {
      c,
      raised: totals?.get(c.id)?.raised ?? 0,
      pct: pct !== null && Number.isFinite(pct) && pct > 0 ? pct : null,
    };
  });
  const anyPoll = rows.some((r) => r.pct !== null);
  rows.sort((a, b) =>
    anyPoll ? (b.pct ?? -1) - (a.pct ?? -1) || b.raised - a.raised : b.raised - a.raised,
  );
  const raceRaised = (candidates ?? []).reduce((s, c) => s + (totals?.get(c.id)?.raised ?? 0), 0);
  const href = racePath(state, race);

  return (
    <Link to={href} className="group block focus:outline-none">
      <Card className="h-full p-5 flex flex-col transition-colors group-hover:border-primary group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-xl font-semibold">{race.title}</h2>
          <span className="text-xs text-muted-foreground">{race.generalDate.slice(0, 4)}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {anyPoll ? "Ranked by polling average" : "Ranked by money raised"}
        </p>

        <ul className="mt-4 space-y-2.5 flex-1">
          {isLoading && <li className="text-sm text-muted-foreground">Loading…</li>}
          {!isLoading && rows.length === 0 && (
            <li className="text-sm text-muted-foreground">No candidates on the ballot yet.</li>
          )}
          {rows.slice(0, SHOWN).map(({ c, raised, pct }, i) => (
            <li key={c.id} className="flex items-center gap-2.5 text-sm">
              <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: partyColor(c.party) }}
                role="img"
                aria-label={partyLabel(c.party)}
              />
              <span className={`min-w-0 flex-1 truncate ${i === 0 ? "font-semibold" : ""}`}>{c.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {anyPoll && pct !== null ? `${pct.toFixed(1)}%` : formatCurrency(raised)}
              </span>
            </li>
          ))}
          {rows.length > SHOWN && (
            <li className="pl-6 text-xs text-muted-foreground">+{rows.length - SHOWN} more</li>
          )}
        </ul>

        <div className="mt-4 flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{formatCurrency(raceRaised)}</span> raised
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            View race <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </Card>
    </Link>
  );
}
