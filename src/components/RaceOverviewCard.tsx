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
import { overviewOrder } from "@/lib/headToHead";

function initialsOf(name: string): string {
  const w = name.trim().split(/\s+/);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}

function Headshot({ name, party, src }: { name: string; party: string | null; src: string | null | undefined }) {
  const ring = { borderColor: partyColor(party) };
  return src ? (
    <img src={src} alt={name} loading="lazy" className="h-16 w-16 rounded-full border-2 object-cover" style={ring} />
  ) : (
    <div
      className="flex h-16 w-16 items-center justify-center rounded-full border-2 bg-muted font-display text-lg"
      style={ring}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </div>
  );
}

export default function RaceOverviewCard() {
  const state = useStateConfig();
  const race = useRaceConfig();
  const polled = !!race.pollingSourceUrl;
  const { data: candidates, isLoading } = useCandidates();
  const { data: totals } = useCandidateTotals();
  const { data: polling } = useRacePolling();

  const unordered = onBallot(candidates ?? []).map((c) => {
    const pct = polled && polling ? readCandidatePct(polling.average, c.name, c.id) : null;
    return {
      c,
      raised: totals?.get(c.id)?.raised ?? 0,
      pct: pct !== null && Number.isFinite(pct) && pct > 0 ? pct : null,
    };
  });
  const anyPoll = unordered.some((r) => r.pct !== null);
  const rows = overviewOrder(unordered, anyPoll);
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

        {/* The top two, side by side */}
        <div className="mt-4 flex-1">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">No candidates on the ballot yet.</p>
          )}
          {rows.length > 0 && (
            <div className={`grid gap-3 ${rows.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {rows.slice(0, 2).map((r, i) => (
                <div
                  key={r.c.id}
                  className={`relative flex flex-col items-center rounded-md px-2 pb-3 pt-4 text-center ${
                    i === 0 ? "bg-accent/60" : ""
                  }`}
                >
                  {i === 0 && rows.length > 1 && (
                    <span className="absolute left-2 top-2 rounded-sm bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Leads
                    </span>
                  )}
                  <Headshot name={r.c.name} party={r.c.party} src={r.c.photo_url_thumb ?? r.c.photo_url} />
                  <div
                    className="mt-2 font-display text-base font-semibold leading-tight"
                    style={{ color: partyColor(r.c.party) }}
                  >
                    {r.c.name}
                  </div>
                  <div className="text-xs text-muted-foreground">{partyLabel(r.c.party)}</div>
                  <div className="mt-1.5 font-display text-xl font-bold tabular-nums">
                    {anyPoll ? (r.pct !== null ? `${r.pct.toFixed(1)}%` : "—") : formatCurrency(r.raised)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{anyPoll ? "polling average" : "raised"}</div>
                </div>
              ))}
            </div>
          )}
          {rows.length > 2 && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              +{rows.length - 2} more on the ballot
            </p>
          )}
        </div>

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
