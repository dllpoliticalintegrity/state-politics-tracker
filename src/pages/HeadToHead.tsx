import { Link, useSearchParams } from "react-router-dom";
import { useCandidates, useCandidateTotals, useFundingSources } from "@/hooks/useCandidates";
import { readCandidatePct, useRacePolling } from "@/hooks/usePolling";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";
import { pollingSourceLabel } from "@/states/registry";
import { comparisonDefaults, comparisonPair } from "@/lib/headToHead";
import CandidateCard, { type CandidateCardStats } from "@/components/CandidateCard";
import { CandidateSummary } from "@/components/RaceSummary";
import { fundingSlices } from "@/lib/raceSummary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function HeadToHead({ statsBySlug }: { statsBySlug: Map<string, CandidateCardStats> }) {
  const state = useStateConfig();
  const race = useRaceConfig();
  const candidatesQuery = useCandidates();
  const totalsQuery = useCandidateTotals();
  const pollingQuery = useRacePolling();
  const { data: funding } = useFundingSources();
  const base = useRaceBase();
  const candidates = candidatesQuery.data ?? [];
  const [params] = useSearchParams();
  const poll = (c: typeof candidates[number]) => {
    const pct = readCandidatePct(pollingQuery.data?.average, c.name, c.id);
    return pct !== null && Number.isFinite(pct) && pct > 0 ? pct : null;
  };
  const defaults = comparisonDefaults(candidates, (c) => totalsQuery.data?.get(c.id)?.raised ?? 0, poll);
  const [left, right] = comparisonPair(candidates, defaults, params.get("left"), params.get("right"));

  const sharedCategories = new Set(
    funding ? fundingSlices(funding, new Set([left?.id, right?.id].filter(Boolean) as string[])).map((s) => s.key) : [],
  );

  return (
    <section id="head-to-head" aria-label="Head to head" className="container pb-10 scroll-mt-24">

      {candidatesQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-4" aria-label="Loading candidates" aria-busy="true">
          <Skeleton className="h-64" /><Skeleton className="h-64" />
        </div>
      ) : candidatesQuery.error ? (
        <div role="alert" className="space-y-3 py-8">
          <p className="text-destructive">Candidates couldn’t be loaded.</p>
          <Button variant="outline" onClick={() => candidatesQuery.refetch()}>Try again</Button>
        </div>
      ) : !left && !right ? (
        <p className="py-8 text-muted-foreground">No candidates currently listed for this election.</p>
      ) : (
        <>
          <section aria-label="Candidate matchup" className="grid grid-cols-2 gap-3 sm:gap-4 pb-8 items-stretch">
            {[left, right].map((candidate, side) => candidate ? (
              <CandidateCard key={candidate.id} candidate={candidate}
                stats={statsBySlug.get(candidate.slug) ?? { pollPct: poll(candidate), pollDelta: null, pollSeries: [], raised: totalsQuery.data?.get(candidate.id)?.raised ?? 0 }}
                rank={side + 1} comparison />
            ) : <div key={side} className="min-w-0 rounded-lg border bg-card p-5 text-sm text-muted-foreground">No opposing candidate listed.</div>)}
          </section>
          <section aria-label="Candidate stats" className="grid grid-cols-2 gap-3 sm:gap-4 items-stretch [&>*]:min-w-0">
            {[left, right].map((candidate, side) => candidate ? (
              <Link key={candidate.id} to={`${base}/candidates/${candidate.slug}`} aria-label={`${candidate.name} profile`}
                className="block h-full min-w-0 rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <CandidateSummary candidateId={candidate.id}
                totals={totalsQuery.isLoading ? undefined : totalsQuery.data?.get(candidate.id) ?? { raised: 0, spent: 0 }}
                funding={funding} categories={sharedCategories} pollPct={poll(candidate)} showPolling={!!race.pollingSourceUrl} />
              </Link>
            ) : <div key={side} />)}
          </section>
          <p className="text-xs text-muted-foreground mt-3">Cash remaining is estimated from total raised minus total spent, with a minimum of zero.</p>
          {totalsQuery.error && <p role="alert" className="text-sm text-destructive mt-3">Campaign finance is temporarily unavailable.</p>}
          <footer className="border-t mt-8 pt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {state.agency && <a href={state.agency.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Finance: {state.agency.name} ↗</a>}
            {race.pollingSourceUrl && <a href={race.pollingSourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Polling: {pollingSourceLabel(race)} ↗</a>}
          </footer>
        </>
      )}
    </section>
  );
}