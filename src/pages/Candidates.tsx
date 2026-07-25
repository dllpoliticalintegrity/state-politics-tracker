import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { useRankedField } from "@/hooks/useRankedField";
import CandidateCard from "@/components/CandidateCard";
import NoFilingsNote from "@/components/NoFilingsNote";

export default function Candidates() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const { ranked, withoutFilings, isLoading, error } = useRankedField();
  const hasPollingSource = !!race.pollingSourceUrl;

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`2026 ${stateCfg.name} ${race.title}'s race`}
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          The candidates
        </h1>
        <p className="text-base text-muted-foreground">
          {hasPollingSource
            ? "Ranked by polling average, then by total raised."
            : "Ranked by total raised."}
        </p>
      </section>

      <section className="container pb-16">
        {isLoading && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            Loading candidates…
          </div>
        )}
        {error && (
          <div className="text-sm text-destructive py-10 text-center">
            Something went wrong loading candidates. Try refreshing.
          </div>
        )}
        {!isLoading && !error && ranked.length === 0 && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            No candidates yet.
          </div>
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
