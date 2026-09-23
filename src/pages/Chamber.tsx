import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import DistrictMap from "@/components/DistrictMap";
import { useCandidateTotals, useChamberCandidates, type TxCandidate } from "@/hooks/useCandidates";
import { formatCurrency, partyColor } from "@/lib/finance";
import { chamberDistricts, type ChamberConfig } from "@/states/registry";
import { useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";
import { onBallot } from "@/lib/candidateStatus";

/**
 * A legislative chamber's overview: one row per district, listing the
 * candidates with a committee on file and what each has raised, linking to
 * the district's race dashboard. Finance only — no polling exists for
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
          {`Who's paying for the ${stateCfg.name} ${chamber.title}`}
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          {`Campaign finance for all ${chamber.districts} ${chamber.title} districts, synced nightly from the ${stateCfg.agency?.name ?? "state disclosure agency"}. Pick a district to see its candidates, donors and spending.`}
        </p>
      </section>

      <section className="container pb-10">
        <div className="grid grid-cols-3 divide-x rounded-lg border bg-card">
          <Stat label="Districts with candidates" value={`${contested} / ${chamber.districts}`} />
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
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-semibold w-24">District</th>
                  <th className="px-4 py-2.5 font-semibold">Candidates</th>
                  <th className="px-4 py-2.5 font-semibold text-right w-36">Raised</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(({ district, cands, total }) => (
                  <tr key={district} className="hover:bg-accent/50 align-top">
                    <td className="px-4 py-3">
                      <Link to={`${base}/${district}`} className="font-display font-semibold text-primary hover:underline">
                        {district}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {cands.length === 0 ? (
                        <span className="text-muted-foreground">No committee on file</span>
                      ) : (
                        <ul className="flex flex-wrap gap-x-4 gap-y-1">
                          {cands.map((c) => (
                            <li key={c.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                              <span
                                className="inline-block h-2 w-2 rounded-full shrink-0"
                                style={{ backgroundColor: partyColor(c.party) }}
                                aria-hidden
                              />
                              <Link to={`${base}/${district}/candidates/${c.slug}`} className="hover:underline">
                                {c.name}
                              </Link>
                              <span className="text-muted-foreground text-xs">{formatCurrency(raised(c))}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {total > 0 ? formatCurrency(total) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
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
