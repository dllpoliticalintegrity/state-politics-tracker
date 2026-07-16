import { Link } from "react-router-dom";
import Sparkline from "@/components/Sparkline";
import type { TxCandidate } from "@/hooks/useCandidates";
import { formatCurrency, partyColor, partyLabel } from "@/lib/finance";

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
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

export default function CandidateCard({ candidate: c, stats, rank }: Props) {
  const party = c.party ?? "I";
  const pColor = partyColor(party);
  const delta = stats.pollDelta ?? 0;
  const dSym = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  const dColor =
    delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground";
  const isWithdrawn =
    c.status === "withdrawn" || c.status === "dropped_out" || c.status === "eliminated";
  const inactiveLabel = c.status === "eliminated" ? "Lost primary" : "Withdrawn";

  return (
    <Link to={`/candidates/${c.slug}`} className="block">
      <div
        className={`relative overflow-hidden rounded-lg border bg-card p-5 transition-all hover:-translate-y-0.5 hover:shadow-sm ${
          isWithdrawn ? "opacity-50 grayscale" : ""
        }`}
      >
        {isWithdrawn && (
          <div className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground border z-10">
            {inactiveLabel}
          </div>
        )}
        {/* party-colored left stripe */}
        <div
          className="absolute left-0 top-0 bottom-0 w-[3px]"
          style={{ backgroundColor: pColor }}
        />

        {/* rank */}
        <div className="absolute top-4 right-4 font-display text-lg text-muted-foreground/70">
          {rank}
        </div>

        {/* avatar + name */}
        <div className="flex items-center gap-3 mb-3.5">
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
            <div className="font-display text-lg font-semibold leading-tight truncate">
              {c.name}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {partyLabel(party)} · Governor
            </div>
          </div>
        </div>

        {/* poll row */}
        <div className="flex items-baseline gap-2.5 py-2.5 border-y mb-3">
          <div className="font-display text-3xl font-semibold leading-none">
            {stats.pollPct !== null ? `${stats.pollPct}%` : "—"}
          </div>
          {stats.pollDelta !== null && (
            <div className={`font-mono text-xs font-semibold tabular-nums ${dColor}`}>
              {dSym}
              {Math.abs(delta).toFixed(1)} in 90 days
            </div>
          )}
          <div className="ml-auto text-[11px] text-muted-foreground">Poll average</div>
        </div>

        {/* sparkline */}
        <div className="my-1 mb-3">
          {stats.pollSeries.length >= 2 ? (
            <Sparkline values={stats.pollSeries} color={pColor} />
          ) : (
            <div className="h-9 flex items-center justify-center text-[11px] text-muted-foreground/70">
              Not enough polls to chart
            </div>
          )}
        </div>

        {/* finance */}
        <div className="pt-3 border-t border-dashed">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] text-muted-foreground">Total raised</div>
            <div className="font-mono font-semibold text-sm tabular-nums">
              {stats.raised > 0 ? formatCurrency(stats.raised) : "—"}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
