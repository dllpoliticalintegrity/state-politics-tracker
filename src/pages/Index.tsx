import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useCandidates, useCandidateTotals } from "@/hooks/useCandidates";
import { useRacePolling } from "@/hooks/usePolling";
import { useRankedField } from "@/hooks/useRankedField";
import PollingChart from "@/components/PollingChart";
import PollingAveragesList from "@/components/PollingAveragesList";
import CandidateCard from "@/components/CandidateCard";
import ContributionsTicker from "@/components/ContributionsTicker";
import IncumbentCard from "@/components/IncumbentCard";
import NoFilingsNote from "@/components/NoFilingsNote";
import { formatCurrency } from "@/lib/finance";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function Index() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const hasPollingSource = !!race.pollingSourceUrl;
  const GENERAL_DATE = new Date(`${race.generalDate}T00:00:00`);
  const { data: candidates } = useCandidates();
  const { data: totalsMap } = useCandidateTotals();
  const { data: polling } = useRacePolling();
  const { ranked, withoutFilings, isLoading } = useRankedField();

  // ---------- Summary strip ----------
  const today = new Date();
  const daysToGeneral = Math.max(
    0,
    Math.ceil((GENERAL_DATE.getTime() - today.getTime()) / DAY_MS),
  );
  // Scope to this race's candidates — totalsMap spans every tracked race. This
  // counts the whole field, not just the ranked cards below: the strip reports
  // what the race has raised, which doesn't change because a candidate is too
  // far back to chart.
  const totalRaised = (candidates ?? []).reduce(
    (sum, c) => sum + (totalsMap?.get(c.id)?.raised ?? 0),
    0,
  );
  const leader = ranked[0] ?? null;

  return (
    <div className="min-h-[80vh]">
      <ContributionsTicker />

      {/* Hero */}
      <section className="container pt-12 md:pt-16 pb-8 max-w-3xl text-center space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`2026 ${stateCfg.name} ${race.title}'s race`}
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {`Who's winning the race for ${stateCfg.name} ${race.title} — and who's paying for it`}
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          {hasPollingSource
            ? `Polling averages, campaign finance, and outside spending, synced from 270toWin and the ${stateCfg.agency?.name}.`
            : `Campaign finance and outside spending, synced from the ${stateCfg.agency?.name}. No public polling is tracked for this race yet.`}
        </p>
      </section>

      {/* Summary strip */}
      <section className="container pb-10">
        <div className="grid grid-cols-3 divide-x rounded-lg border bg-card">
          <SummaryStat
            label="Days to the general"
            value={String(daysToGeneral)}
            sub={GENERAL_DATE.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
          />
          <SummaryStat
            label={hasPollingSource ? "Polling leader" : "Money leader"}
            value={leader ? surnameOf(leader.c.name) : "—"}
            sub={
              hasPollingSource
                ? leader?.stats.pollPct != null
                  ? `${leader.stats.pollPct}% average`
                  : "No average yet"
                : leader
                  ? `${formatCurrency(leader.stats.raised)} raised`
                  : "No filings yet"
            }
          />
          <SummaryStat
            label="Raised this cycle"
            value={formatCurrency(totalRaised)}
            sub="Across all committees"
          />
        </div>
      </section>

      {/* Who holds the office today (Open States) — renders nothing when the
          office isn't covered or the roster hasn't synced. */}
      <section className="container pb-10 empty:hidden">
        <IncumbentCard />
      </section>

      {/* Polling chart (polled races only) */}
      {hasPollingSource && (
      <section className="container pb-10">
        <Card className="p-4 md:p-6">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-display text-xl md:text-2xl font-semibold">Polling average</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {polling?.spread && <span>Leading: {polling.spread}</span>}
              <a
                href={race.pollingSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Source: 270toWin ↗
              </a>
            </div>
          </div>
          {/* Desktop: chart + sidebar list */}
          <div className="hidden md:grid md:grid-cols-3 gap-6">
            <div className="md:col-span-2">
              <PollingChart />
            </div>
            <div className="md:col-span-1 md:border-l md:pl-6">
              <PollingAveragesList />
            </div>
          </div>
          {/* Mobile: tabbed view, list default */}
          <div className="md:hidden">
            <Tabs defaultValue="list" className="w-full">
              <TabsList className="grid grid-cols-2 w-full h-8 text-xs mb-3">
                <TabsTrigger value="list">List</TabsTrigger>
                <TabsTrigger value="chart">Chart</TabsTrigger>
              </TabsList>
              <TabsContent value="list" className="mt-0">
                <PollingAveragesList />
              </TabsContent>
              <TabsContent value="chart" className="mt-0">
                <PollingChart />
              </TabsContent>
            </Tabs>
          </div>
        </Card>
      </section>
      )}

      {/* Field overview */}
      <section className="container pb-16">
        <div className="flex items-baseline justify-between pb-2.5 border-b mb-5">
          <h2 className="font-display text-xl md:text-2xl font-semibold">The field</h2>
          <div className="text-xs text-muted-foreground">
            {hasPollingSource ? "Ranked by current poll average" : "Ranked by total raised"}
          </div>
        </div>
        {isLoading && (
          <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>
        )}
        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          {ranked.map(({ c, stats }, idx) => (
            <CandidateCard key={c.slug} candidate={c} stats={stats} rank={idx + 1} />
          ))}
        </div>
        <NoFilingsNote candidates={withoutFilings} className="mt-6" />
      </section>
    </div>
  );
}

function surnameOf(name: string): string {
  return name.trim().split(/\s+/).pop() ?? name;
}

function SummaryStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="px-4 py-4 md:px-6 text-center md:text-left">
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
        {label}
      </div>
      <div className="font-display text-2xl md:text-3xl font-semibold leading-none mb-1 truncate">
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
