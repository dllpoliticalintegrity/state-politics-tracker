import { chamberHeadline } from "@/states/nicknames";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { ArrowRight } from "lucide-react";
import DistrictMap from "@/components/DistrictMap";
import { useCandidateTotals, useChamberCandidates, type TxCandidate } from "@/hooks/useCandidates";
import { formatCurrency, partyLabel } from "@/lib/finance";
import { comparisonDefaults, comparisonPair, comparisonTextClass } from "@/lib/headToHead";
import { chamberDistricts, chamberScope, type ChamberConfig } from "@/states/registry";
import { useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";
import { onBallot } from "@/lib/candidateStatus";

/**
 * A legislative chamber's overview: one row per district, listing the
 * candidates with a committee on file and what each has raised, linking to
 * the district's head-to-head comparison. Finance only — no polling exists for
 * these seats.
 */
export default function Chamber({ chamber }: { chamber: ChamberConfig }) {
  const stateCfg = useStateConfig();
  const { data: allCandidates, isLoading, error } = useChamberCandidates(chamber.office);
  // Shared overview: only candidates still on the ballot. Those who lost a
  // primary or withdrew remain reachable from their district's race page.
  const candidates = onBallot(allCandidates);
  const { data: totalsMap } = useCandidateTotals();
  const base = `${statePath(stateCfg.code)}/${chamber.office}`;
  const year = chamber.generalDate.slice(0, 4);

  const raised = (c: TxCandidate) => totalsMap?.get(c.id)?.raised ?? 0;
  const byDistrict = new Map<string, TxCandidate[]>();
  for (const c of candidates) {
    if (!c.district) continue;
    byDistrict.set(c.district, [...(byDistrict.get(c.district) ?? []), c]);
  }
  const rows = chamberDistricts(chamber).map((d) => {
    const cands = (byDistrict.get(d) ?? []).sort((a, b) => raised(b) - raised(a));
    return { district: d, cands, total: cands.reduce((s, c) => s + raised(c), 0) };
  });
  const candidateCount = candidates.length;
  const totalRaised = rows.reduce((s, r) => s + r.total, 0);
  const contested = rows.filter((r) => r.cands.length > 0).length;

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 md:pt-16 pb-8 max-w-3xl text-center space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`${year} ${stateCfg.name} ${chamber.title} races`}
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {chamberHeadline(stateCfg.name, chamber.title)}
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          {`Campaign finance for ${chamberScope(chamber)}, synced nightly from the ${stateCfg.agency?.name ?? "state disclosure agency"}. Pick a district to see its candidates, donors and spending.`}
        </p>
      </section>

      <section className="container pb-10">
        <div className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-y-0 sm:divide-x rounded-lg border bg-card">
          <Stat label="Districts with candidates" value={`${contested} / ${rows.length}`} />
          <Stat label="Candidates with committees" value={String(candidateCount)} />
          <Stat label="Raised this cycle" value={formatCurrency(totalRaised)} sub="Across all committees" />
        </div>
      </section>

      {chamber.map && (
        <section className="container pb-10">
          <Card className="p-4 md:p-6">
            <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
              <h2 className="font-display text-xl md:text-2xl font-semibold">Money by district</h2>
              <span className="text-xs text-muted-foreground">
                Coloured by the party of each district&apos;s top fundraiser · click a district to open it
              </span>
            </div>
            <div className="mx-auto max-w-2xl">
              <DistrictMap
                geoUrl={chamber.map}
                title={`${stateCfg.name} ${chamber.title}`}
                rows={rows}
                raised={raised}
                base={base}
                upDistricts={chamber.seatsUp ? new Set(rows.map((r) => r.district)) : undefined}
              />
            </div>
          </Card>
        </section>
      )}

      <section className="container pb-16">
        {isLoading && (
          <div className="text-sm text-muted-foreground py-10 text-center">Loading districts…</div>
        )}
        {error && (
          <div className="text-sm text-destructive py-10 text-center">
            Something went wrong loading candidates. Try refreshing.
          </div>
        )}
        {!isLoading && !error && candidateCount === 0 && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            No candidate committees imported yet — the nightly sync fills this in.
          </div>
        )}
        {candidateCount > 0 && (
          <div className="divide-y border-y">
            <div className="grid grid-cols-[3rem_minmax(0,1fr)_1rem] sm:grid-cols-[5rem_minmax(0,1fr)_7rem_1rem] gap-2 sm:gap-4 px-2 sm:px-4 py-2.5 bg-muted/50 text-xs font-semibold uppercase text-muted-foreground">
              <span>District</span>
              <span className="text-center">Candidates</span>
              <span className="hidden sm:block text-right">Raised</span>
              <span aria-hidden="true" />
            </div>
            {rows.map(({ district, cands, total }) => {
              const defaults = comparisonDefaults(cands, raised, () => null);
              const pair = comparisonPair(cands, defaults, null, null);
              const selections = new URLSearchParams();
              if (pair[0]) selections.set("left", pair[0].slug);
              if (pair[1]) selections.set("right", pair[1].slug);
              const query = selections.toString();
              return (
                <Link key={district}
                  to={`${base}/${district}${query ? `?${query}` : ""}`}
                  aria-label={`District ${district} head to head${defaults.length ? `: ${pair.filter((c) => c !== undefined).map((c) => c.name).join(" versus ")}` : ""}`}
                  className="group grid grid-cols-[3rem_minmax(0,1fr)_1rem] sm:grid-cols-[5rem_minmax(0,1fr)_7rem_1rem] gap-2 sm:gap-4 items-center px-2 sm:px-4 py-3 hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <h2 className="font-display text-base font-semibold text-primary">{district}</h2>
                  <div className="min-w-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)] gap-1 sm:gap-3 items-center">
                    {[0, 1].map((side) => {
                      const candidate = pair[side];
                      return (
                        <div key={side} className={`min-w-0 text-center ${side === 1 ? "col-start-3 row-start-1" : "col-start-1 row-start-1"}`}>
                          {candidate ? <>
                            <h3 className="break-words text-xs sm:text-sm font-semibold text-foreground">{candidate.name}</h3>
                            <p className="flex flex-wrap justify-center gap-x-1.5 text-[11px] sm:text-xs text-muted-foreground mt-1">
                              <span className={comparisonTextClass(candidate.party)}>{partyLabel(candidate.party)}</span>
                              <span className="font-mono tabular-nums">{formatCurrency(raised(candidate))}</span>
                            </p>
                          </> : <p className="text-xs text-muted-foreground">{defaults.length ? "No opponent listed" : "No committee on file"}</p>}
                        </div>
                      );
                    })}
                    <span className="col-start-2 row-start-1 text-center text-xs font-semibold uppercase text-muted-foreground" aria-hidden="true">vs</span>
                  </div>
                  {cands.length > 2 && <p className="mt-1 text-center text-xs text-muted-foreground">+{cands.length - 2} other {cands.length === 3 ? "candidate" : "candidates"}</p>}
                  </div>
                  <span className="hidden sm:block text-right font-mono text-sm tabular-nums">{formatCurrency(total)}</span>
                  <ArrowRight className="h-4 w-4 text-primary" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className="font-display text-2xl md:text-3xl font-semibold mt-1 leading-none">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1.5">{sub}</div>}
    </div>
  );
}
