import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  useCandidates,
  useCandidateTotals,
} from "@/hooks/useCandidates";
import { isGeneralMatchup, useTxGovPolling, useTxGovRacePolls } from "@/hooks/usePolling";
import PollingChart from "@/components/PollingChart";
import PollingAveragesList from "@/components/PollingAveragesList";
import CandidateCard, { type CandidateCardStats } from "@/components/CandidateCard";
import ContributionsTicker from "@/components/ContributionsTicker";
import { formatCurrency } from "@/lib/finance";

const GENERAL_DATE = new Date("2026-11-03T00:00:00");
const DAY_MS = 24 * 60 * 60 * 1000;

export default function Index() {
  const { data: candidates, isLoading } = useCandidates();
  const { data: totalsMap } = useCandidateTotals();
  const { data: polling } = useTxGovPolling();
  const { data: racePollsAll } = useTxGovRacePolls();
  const racePolls = (racePollsAll ?? []).filter((r) => isGeneralMatchup(r.matchup));

  // ---------- Per-candidate polling stats ----------
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);

  const statsBySlug = new Map<string, CandidateCardStats>();
  if (polling && candidates) {
    for (const c of candidates) {
      const surname = c.name.trim().split(/\s+/).pop() ?? "";
      // Collect all per-poll rows for this candidate from the 270toWin backfill.
      const rawSeries = (racePolls ?? [])
        .filter((r) => (r.candidate_name.trim().split(/\s+/).pop() ?? "") === surname)
        .map((r) => {
          const iso = (r.field_end ?? "").slice(0, 10);
          const n = Number(r.pct);
          if (!iso || iso > todayIso || !Number.isFinite(n)) return null;
          return { iso, pct: n };
        })
        .filter((x): x is { iso: string; pct: number } => x !== null)
        .sort((a, b) => a.iso.localeCompare(b.iso));

      const pollSeries = rawSeries.map((r) => r.pct);
      const avgPct =
        polling.average && polling.average[surname] !== undefined
          ? Number(polling.average[surname])
          : null;
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

  // Rank candidates: by poll % desc, then by total raised.
  // Hide candidates who aren't carried in the RCP polling averages — the hero
  // grid is labelled "ranked by polling," so minor candidates with no poll
  // data would be rank-ordered arbitrarily and confuse the reader.
  const ranked = (candidates ?? [])
    .map((c) => ({ c, stats: statsBySlug.get(c.slug)! }))
    .filter((x) => x.stats?.pollPct !== null && x.stats?.pollPct !== undefined)
    .sort(
      (a, b) =>
        (b.stats?.pollPct ?? -1) - (a.stats?.pollPct ?? -1) ||
        (b.stats?.raised ?? 0) - (a.stats?.raised ?? 0),
    );

  // ---------- Summary strip ----------
  const daysToGeneral = Math.max(
    0,
    Math.ceil((GENERAL_DATE.getTime() - today.getTime()) / DAY_MS),
  );
  const totalRaised = [...(totalsMap?.values() ?? [])].reduce(
    (s, t) => s + t.raised,
    0,
  );
  const leader = ranked[0] ?? null;

  return (
    <div className="min-h-[80vh]">
      <ContributionsTicker />

      {/* Hero */}
      <section className="container pt-12 md:pt-16 pb-8 max-w-3xl text-center space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          2026 Texas Governor's race
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          Who's winning the race for Texas Governor — and who's paying for it
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          Polling averages, campaign finance, and outside spending, synced nightly from
          270toWin and the Texas Ethics Commission.
        </p>
      </section>

      {/* Summary strip */}
      <section className="container pb-10">
        <div className="grid grid-cols-3 divide-x rounded-lg border bg-card">
          <SummaryStat
            label="Days to the general"
            value={String(daysToGeneral)}
            sub="Tuesday, Nov 3, 2026"
          />
          <SummaryStat
            label="Polling leader"
            value={leader ? surnameOf(leader.c.name) : "—"}
            sub={leader?.stats.pollPct != null ? `${leader.stats.pollPct}% average` : "No average yet"}
          />
          <SummaryStat
            label="Raised this cycle"
            value={formatCurrency(totalRaised)}
            sub="Across all committees"
          />
        </div>
      </section>

      {/* Polling chart */}
      <section className="container pb-10">
        <Card className="p-4 md:p-6">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-display text-xl md:text-2xl font-semibold">Polling average</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {polling?.spread && <span>Leading: {polling.spread}</span>}
              <a
                href="https://www.270towin.com/2026-governor-polls/texas"
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

      {/* Field overview */}
      <section className="container pb-16">
        <div className="flex items-baseline justify-between pb-2.5 border-b mb-5">
          <h2 className="font-display text-xl md:text-2xl font-semibold">The field</h2>
          <div className="text-xs text-muted-foreground">Ranked by current poll average</div>
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
