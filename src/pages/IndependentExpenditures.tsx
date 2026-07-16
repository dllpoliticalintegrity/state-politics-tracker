import { Link } from "react-router-dom";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import MoneyTabs from "@/components/MoneyTabs";
import { useCandidates, useIEByCandidate, useTopIECommittees } from "@/hooks/useCandidates";
import { formatCurrency, formatCurrencyFull, partyColor } from "@/lib/finance";

const CYCLE_OPTIONS = [
  { value: "all", label: "All cycles" },
  { value: "primary-2026", label: "2026 primary" },
  { value: "general-2026", label: "2026 general" },
];

export default function IndependentExpenditures() {
  const { data: candidates } = useCandidates();
  const { data: ieByCand, isLoading: ieLoading, error: ieError } = useIEByCandidate();
  const { data: topCommittees } = useTopIECommittees(20);
  const [cycleFilter, setCycleFilter] = useState<string>("all");

  const candidateById = new Map((candidates ?? []).map((c) => [c.id, c]));

  const perCandidate = (ieByCand ?? [])
    .filter((r) => cycleFilter === "all" || r.cycle === cycleFilter)
    .map((r) => {
      const cand = candidateById.get(r.candidate_id);
      return {
        ...r,
        name: cand?.name ?? r.name,
        party: cand?.party ?? null,
        slug: cand?.slug ?? r.slug,
        net: Number(r.total_supporting ?? 0) - Number(r.total_opposing ?? 0),
        total: Number(r.total_supporting ?? 0) + Number(r.total_opposing ?? 0),
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const grandTotalSupporting = perCandidate.reduce(
    (s, r) => s + Number(r.total_supporting ?? 0),
    0,
  );
  const grandTotalOpposing = perCandidate.reduce(
    (s, r) => s + Number(r.total_opposing ?? 0),
    0,
  );

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Money in the 2026 Texas Governor's race
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          Outside spending
        </h1>
        <p className="text-base text-muted-foreground max-w-2xl">
          Independent expenditures by PACs and committees supporting or opposing gubernatorial
          candidates, from Texas Ethics Commission direct-campaign-expenditure filings.
        </p>
      </section>

      <section className="container pb-6">
        <MoneyTabs />
      </section>

      <section className="container pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Cycle</span>
          {CYCLE_OPTIONS.map((c) => (
            <button
              key={c.value}
              onClick={() => setCycleFilter(c.value)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                cycleFilter === c.value
                  ? "border-primary text-primary bg-primary/10 font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      <section className="container pb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x rounded-lg border bg-card">
          <div className="px-4 py-4 md:px-6">
            <div className="font-mono font-semibold text-xl tabular-nums text-success">
              {formatCurrency(grandTotalSupporting)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Spent supporting candidates</div>
          </div>
          <div className="px-4 py-4 md:px-6">
            <div className="font-mono font-semibold text-xl tabular-nums text-destructive">
              {formatCurrency(grandTotalOpposing)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Spent opposing candidates</div>
          </div>
          <div className="px-4 py-4 md:px-6">
            <div className="font-mono font-semibold text-xl tabular-nums">
              {(topCommittees ?? []).length}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Active committees</div>
          </div>
        </div>
      </section>

      <section className="container pb-10 space-y-3">
        <h2 className="font-display text-xl font-semibold">By candidate</h2>
        {ieLoading && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            Loading outside spending…
          </div>
        )}
        {ieError && (
          <div className="text-sm text-destructive py-6 text-center">
            Something went wrong loading this data. Try refreshing.
          </div>
        )}
        {!ieLoading && !ieError && perCandidate.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No outside-spending activity for this cycle yet.
          </div>
        )}
        <div className="space-y-2">
          {perCandidate.map((r) => (
            <Link key={r.candidate_id} to={`/candidates/${r.slug}`}>
              <Card className="p-4 hover:border-primary/40 transition-colors group">
                <div className="flex items-center gap-4">
                  <span
                    className="text-[11px] font-semibold px-1.5 py-0.5 rounded-sm shrink-0"
                    style={{ backgroundColor: partyColor(r.party), color: "white" }}
                  >
                    {r.party ?? "—"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                      {r.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {(r.supporting_count ?? 0)} support · {(r.opposing_count ?? 0)} oppose ·{" "}
                      {r.committee_count ?? 0} committees
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-mono text-xs tabular-nums">
                    <div className="text-success">
                      +{formatCurrency(Number(r.total_supporting ?? 0))}
                    </div>
                    <div className="text-destructive">
                      −{formatCurrency(Number(r.total_opposing ?? 0))}
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="container pb-16 space-y-3">
        <h2 className="font-display text-xl font-semibold">Top committees</h2>
        <div className="space-y-2">
          {(topCommittees ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No committees to list yet.
            </div>
          )}
          {(topCommittees ?? []).map((c, i) => (
            <Card key={c.filer_id} className="p-4">
              <div className="flex items-center gap-4">
                <div className="text-xs text-muted-foreground tabular-nums w-8">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.transaction_count} transactions · TEC filer {c.filer_id}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono font-semibold text-sm tabular-nums">
                    {formatCurrencyFull(c.total_amount)}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground tabular-nums">
                    +{formatCurrency(c.supporting)} / −{formatCurrency(c.opposing)}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-2">
          Updated nightly from Texas Ethics Commission filings.
        </p>
      </section>
    </div>
  );
}
