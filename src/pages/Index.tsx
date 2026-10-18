import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  useCandidates,
  useCandidateTotals,
  useFundingSources,
} from "@/hooks/useCandidates";
import { isGeneralMatchup, pollRowIsCandidate, readCandidatePct, useRacePolling, useRacePolls } from "@/hooks/usePolling";
import PollingChart from "@/components/PollingChart";
import PollingAveragesList from "@/components/PollingAveragesList";
import CandidateCard, { type CandidateCardStats } from "@/components/CandidateCard";
import ContributionsTicker from "@/components/ContributionsTicker";
import RaceSubnav from "@/components/RaceSubnav";
import RaceSummary from "@/components/RaceSummary";
import { formatCurrency } from "@/lib/finance";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { pollingSourceLabel } from "@/states/registry";
import { offBallotLast } from "@/lib/candidateStatus";
import PoweredBy from "@/components/PoweredBy";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function Index() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const hasPollingSource = !!race.pollingSourceUrl;
  const { data: candidates, isLoading } = useCandidates();
  const { data: totalsMap } = useCandidateTotals();
  const { data: funding } = useFundingSources();
  const { data: polling } = useRacePolling();
  const { data: racePollsAll } = useRacePolls();
  const racePolls = (racePollsAll ?? []).filter((r) => isGeneralMatchup(r.matchup));

  // ---------- Per-candidate polling stats ----------
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);

  const statsBySlug = new Map<string, CandidateCardStats>();
  if (polling && candidates) {
    for (const c of candidates) {
      // Collect all per-poll rows for this candidate from the FiftyPlusOne import.
      const rawSeries = (racePolls ?? [])
        .filter((r) => pollRowIsCandidate(r, c))
        .map((r) => {
          const iso = (r.field_end ?? "").slice(0, 10);
          const n = Number(r.pct);
          if (!iso || iso > todayIso || !Number.isFinite(n)) return null;
          return { iso, pct: n };
        })
        .filter((x): x is { iso: string; pct: number } => x !== null)
        .sort((a, b) => a.iso.localeCompare(b.iso));

      const pollSeries = rawSeries.map((r) => r.pct);
      const avgPct = readCandidatePct(polling.average, c.name, c.id);
      const validAvg = avgPct !== null && Number.isFinite(avgPct) && avgPct > 0 ? avgPct : null;

      // 90-day delta: current avg minus mean of polls from ≥90 days ago
      let pollDelta: number | null = null;
      if (validAvg !== null && rawSeries.length >= 2) {
        const earlier = rawSeries.filter((r) => r.iso <= ninetyDaysAgo);
        if (earlier.length > 0) {
          const earlyMean =
            earlier.reduce((s, r) => s + r.pct, 0) / earlier.length;
          pollDelta = Math.round((validAvg - earlyMean) * 10) / 10;
        }
      }

      const totals = totalsMap?.get(c.id) ?? { raised: 0, spent: 0, cash: 0 };
      statsBySlug.set(c.slug, {
        pollPct: validAvg,
        pollDelta,
        pollSeries,
        raised: totals.raised,
      });
    }
  } else if (candidates) {
    // Polling not loaded yet — render with finance only
    for (const c of candidates) {
      const totals = totalsMap?.get(c.id) ?? { raised: 0, spent: 0, cash: 0 };
      statsBySlug.set(c.slug, {
        pollPct: null,
        pollDelta: null,
        pollSeries: [],
        raised: totals.raised,
      });
    }
  }

  // Rank candidates. Polled races: by poll % desc (candidates without an
  // average are hidden — the grid is labelled "ranked by polling"). Unpolled
  // races: everyone, ranked by total raised. Candidates who are off the
  // ballot (lost primary, withdrawn, …) stay on this race page but drop to
  // the end, greyed out by CandidateCard.
  const ranked = (candidates ?? [])
    .map((c) => ({ c, stats: statsBySlug.get(c.slug)! }))
    .filter((x) =>
      hasPollingSource ? x.stats?.pollPct !== null && x.stats?.pollPct !== undefined : true,
    )
    .sort(
      (a, b) =>
        offBallotLast(a.c, b.c) ||
        (hasPollingSource
          ? (b.stats?.pollPct ?? -1) - (a.stats?.pollPct ?? -1) ||
            (b.stats?.raised ?? 0) - (a.stats?.raised ?? 0)
          : (b.stats?.raised ?? 0) - (a.stats?.raised ?? 0)),
    );

  const leader = ranked[0] ?? null;

  return (
    <div className="min-h-[80vh]">
      <ContributionsTicker />
      <RaceSubnav />

      {/* Hero */}
      <section className="container pt-12 md:pt-16 pb-8 max-w-3xl text-center space-y-4">
        <PoweredBy />
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`${race.generalDate.slice(0, 4)} ${stateCfg.name} ${race.title}'s race`}
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {`Who's winning the race for ${stateCfg.name} ${race.title} — and who's paying for it`}
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          {hasPollingSource
            ? `Polling averages, campaign finance, and outside spending, synced from ${pollingSourceLabel(race)} and the ${stateCfg.agency?.name}.`
            : `Campaign finance and outside spending, synced from the ${stateCfg.agency?.name}. No public polling is tracked for this race yet.`}
        </p>
      </section>

      {/* Summary: leader, raised & spent, funding sources, money by party */}
      <section className="container pb-10">
        <RaceSummary
          leaderLabel={hasPollingSource ? "Polling leader" : "Money leader"}
          leader={
            leader
              ? {
                  name: leader.c.name,
                  party: leader.c.party,
                  detail: hasPollingSource
                    ? leader.stats.pollPct != null
                      ? `${leader.stats.pollPct}% average`
                      : "No average yet"
                    : `${formatCurrency(leader.stats.raised)} raised`,
                }
              : null
          }
          candidates={candidates ?? []}
          totals={totalsMap}
          funding={funding}
        />
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
                Source: {pollingSourceLabel(race)} ↗
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
      </section>
    </div>
  );
}

