import { Link } from "react-router-dom";
import Sparkline from "@/components/Sparkline";
import type { TxCandidate } from "@/hooks/useCandidates";
import { formatCurrency, partyColor, partyLabel } from "@/lib/finance";
import { useRaceBase, useRaceConfig } from "@/states/StateContext";
import { ballotLabel, inactiveLabel as inactiveLabelFor, isOffBallot } from "@/lib/candidateStatus";
import { comparisonTextClass } from "@/lib/headToHead";

export type CandidateCardStats = {
  pollPct: number | null;
  pollDelta: number | null; // 90d change in pp
  pollSeries: number[]; // ascending by date, for sparkline
  raised: number;
};

type Props = {
  candidate: TxCandidate;
  stats: CandidateCardStats;
  rank: number;
  comparison?: boolean;
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

export default function CandidateCard({ candidate: c, stats, rank, comparison = false }: Props) {
  const base = useRaceBase();
  const race = useRaceConfig();
  const unpolled = stats.pollPct === null && stats.pollSeries.length === 0;
  const party = c.party ?? "I";
  const pColor = partyColor(party);
  const delta = stats.pollDelta ?? 0;
  const dSym = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  const dColor =
    delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground";
  const isWithdrawn = isOffBallot(c.status);
  const inactiveLabel = inactiveLabelFor(c.status) ?? "Withdrawn";
  const ballot = ballotLabel(c.status);

  return (
    <Link to={`${base}/candidates/${c.slug}`} className="block min-w-0 h-full">
      <div
        className={`relative overflow-hidden rounded-lg border bg-card h-full ${comparison ? "p-3 sm:p-5" : "p-5"} transition-all hover:-translate-y-0.5 hover:shadow-sm ${
          isWithdrawn ? "opacity-50 grayscale" : ""
        }`}
      >
        {/* ballot status chip — in the flow, so it never sits over the avatar */}
        {(isWithdrawn || ballot || c.is_incumbent) && (
          <div className="mb-3 -mt-1 pr-8 flex flex-wrap gap-1.5">
            {(isWithdrawn || ballot) && (
              <span
                className={`inline-block text-[10px] px-1.5 py-0.5 rounded-sm border leading-tight ${
                  ballot
                    ? "bg-primary/10 text-primary border-primary/30 font-semibold"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {ballot ?? inactiveLabel}
              </span>
            )}
            {c.is_incumbent && (
              <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-sm border leading-tight bg-accent text-accent-foreground border-border font-semibold">
                Incumbent
              </span>
            )}
          </div>
        )}
        {/* party-colored left stripe */}
        <div
          className="absolute left-0 top-0 bottom-0 w-[3px]"
          style={{ backgroundColor: pColor }}
        />

        {/* rank */}
        {!comparison && <div className="absolute top-4 right-4 font-display text-lg text-muted-foreground/70">
          {rank}
        </div>}

        {/* avatar + name */}
        <div className={`flex gap-3 mb-3.5 ${comparison ? "flex-col sm:flex-row sm:items-center" : "items-center"}`}>
          {c.photo_url ? (
            <img
              src={c.photo_url_thumb ?? c.photo_url}
              alt={c.name}
              className="w-12 h-12 rounded-full object-cover shrink-0 border-2"
              style={{ borderColor: pColor }}
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center font-display text-sm shrink-0 border-2 bg-muted"
              style={{ borderColor: pColor }}
            >
              {initialsOf(c.name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="font-display text-lg font-semibold leading-tight text-foreground break-words">
              {c.name}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              <span className={comparison ? comparisonTextClass(party) : undefined}>{partyLabel(party)}</span>{!comparison && ` · ${race.title}`}
            </div>
          </div>
        </div>

        {comparison && !unpolled ? (
          <div className="py-2.5 border-y mb-3">
            <div className="flex items-center gap-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-muted-foreground">Poll average</div>
                <div className="h-1 mt-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, stats.pollPct ?? 0)}%`, backgroundColor: pColor }}
                  />
                </div>
              </div>
              <span className="font-sans text-sm font-semibold tabular-nums">
                {stats.pollPct !== null ? stats.pollPct.toFixed(1) : "—"}
              </span>
            </div>
          </div>
        ) : (
        <>
        {/* headline stat: poll average, or money in unpolled races */}
        <div className="flex flex-wrap items-baseline gap-2.5 py-2.5 border-y mb-3">
          <div className={`font-semibold leading-none ${comparison ? "font-sans text-xl sm:text-3xl" : "font-display text-3xl"}`}>
            {unpolled
              ? stats.raised > 0
                ? formatCurrency(stats.raised)
                : "—"
              : stats.pollPct !== null
                ? `${stats.pollPct}%`
                : "—"}
          </div>
          {!unpolled && stats.pollDelta !== null && (
            <div className={`${comparison ? "font-sans" : "font-mono"} text-xs font-semibold tabular-nums ${dColor}`}>
              {dSym}
              {Math.abs(delta).toFixed(1)} in 90 days
            </div>
          )}
          <div className="ml-auto text-[11px] text-muted-foreground">
            {unpolled ? "Total raised" : "Poll average"}
          </div>
        </div>

        {/* sparkline (polled races only) */}
        {!unpolled && (
          <div className="my-1 mb-3">
            {stats.pollSeries.length >= 2 ? (
              <Sparkline values={stats.pollSeries} color={pColor} />
            ) : (
              <div className="h-9 flex items-center justify-center text-[11px] text-muted-foreground/70">
                Not enough polls to chart
              </div>
            )}
          </div>
        )}

        </>
        )}

        {/* finance (redundant with the headline stat in unpolled races) */}
        {!unpolled && (
        <div className="pt-3 border-t border-dashed">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <div className="text-[11px] text-muted-foreground">Total raised</div>
            <div className={`${comparison ? "font-sans" : "font-mono"} font-semibold text-sm tabular-nums`}>
              {stats.raised > 0 ? formatCurrency(stats.raised) : "—"}
            </div>
          </div>
        </div>
        )}
      </div>
    </Link>
  );
}
