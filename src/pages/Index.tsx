import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  useCandidates,
  useCandidateTotals,
} from "@/hooks/useCandidates";
import { isGeneralMatchup, pollRowIsCandidate, readCandidatePct, useRacePolling, useRacePolls } from "@/hooks/usePolling";
import PollingChart from "@/components/PollingChart";
import PollingAveragesList from "@/components/PollingAveragesList";
import type { CandidateCardStats } from "@/components/CandidateCard";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { pollingSourceLabel } from "@/states/registry";
import HeadToHead from "@/pages/HeadToHead";
import FundraisingCharts from "@/components/FundraisingCharts";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function Index() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const hasPollingSource = !!race.pollingSourceUrl;
  const { data: candidates } = useCandidates();
  const { data: totalsMap } = useCandidateTotals();
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

  return (
    <div className="min-h-[80vh]">

      {/* Hero */}
      <section className="container pt-3 md:pt-4 pb-8 max-w-3xl text-center space-y-4">
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {race.district ? `${stateCfg.name} ${race.title}` : `${stateCfg.name} ${race.title}'s Race`}
        </h1>
      </section>

      <HeadToHead statsBySlug={statsBySlug} />


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

      <FundraisingCharts />

    </div>
  );
}

