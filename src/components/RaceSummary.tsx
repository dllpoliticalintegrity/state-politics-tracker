// The race page's summary: the polling (or money) leader, raised & spent,
// funding sources and money by party, all scoped to the race's candidates.
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { partyColor, partyLabel } from "@/lib/finance";
import {
  fundingSlices,
  partySlices,
  runningCounts,
  type CandidateLite,
  type FundingRow,
  type Slice,
} from "@/lib/raceSummary";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number) => (n > 0 && n < 0.05 ? "<0.1%" : `${n.toFixed(1)}%`);

export interface RaceLeader {
  name: string;
  party: string | null;
  /** "49.4% average" or "$1.2M raised". */
  detail: string;
}

export default function RaceSummary({
  leaderLabel,
  leader,
  candidates,
  totals,
  funding,
}: {
  leaderLabel: string;
  leader: RaceLeader | null;
  candidates: CandidateLite[];
  totals: Map<string, { raised: number; spent: number }> | undefined;
  /** null when the state has no funding breakdown (Local Politics Tracker). */
  funding: FundingRow[] | null | undefined;
}) {
  const ids = new Set(candidates.map((c) => c.id));
  const raisedById = new Map(candidates.map((c) => [c.id, totals?.get(c.id)?.raised ?? 0]));
  const raised = candidates.reduce((s, c) => s + (totals?.get(c.id)?.raised ?? 0), 0);
  const spent = candidates.reduce((s, c) => s + (totals?.get(c.id)?.spent ?? 0), 0);
  const { running, out } = runningCounts(candidates);
  const party = partySlices(candidates, raisedById);
  const sources = funding ? fundingSlices(funding, ids) : null;
  const loading = totals === undefined;
  const leaderColor = leader ? partyColor(leader.party) : undefined;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1.25fr)]">
      {/* Leader, coloured by party */}
      <Card className="p-5 flex flex-col justify-between overflow-hidden relative">
        <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: leaderColor ?? "hsl(var(--border))" }} />
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{leaderLabel}</div>
        <div className="mt-3">
          <div
            className="font-display text-3xl font-bold leading-tight break-words"
            style={leaderColor ? { color: leaderColor } : undefined}
          >
            {leader ? leader.name : "—"}
          </div>
          {leader && (
            <div className="mt-1 text-sm text-muted-foreground">
              {partyLabel(leader.party)} · {leader.detail}
            </div>
          )}
          {!leader && <div className="mt-1 text-sm text-muted-foreground">No data yet</div>}
        </div>
      </Card>

      {/* Raised & spent */}
      <Card className="p-5 flex flex-col">
        <h3 className="font-semibold">Raised &amp; Spent</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          This cycle. Spent can be higher than raised, for example when a campaign spends money left over from
          earlier years.
        </p>
        <dl className="mt-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Raised</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{loading ? "…" : usd(raised)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Spent</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{loading ? "…" : usd(spent)}</dd>
          </div>
        </dl>
        {candidates.length > 0 && (
          <p className="mt-auto pt-4 text-xs text-muted-foreground">
            Candidates: {running} running{out > 0 ? ` (+${out} no longer running)` : ""}
          </p>
        )}
      </Card>

      {/* Funding sources */}
      <DonutCard
        title="Funding Sources"
        slices={sources}
        empty={
          funding === undefined || loading
            ? "Loading…"
            : funding === null
              ? "Not available for this state yet."
              : "No contributions filed yet."
        }
      />

      {/* Money by party */}
      <DonutCard
        title="Money by Party"
        note={party.slices.some((s) => s.key === "Other") ? "“Other” means no party was listed in the state's filings." : undefined}
        slices={party.slices}
        empty={loading ? "Loading…" : "No contributions filed yet."}
        footer={party.counts.length ? `Candidates: ${party.counts.map((c) => `${c.count} ${c.label}`).join(" · ")}` : undefined}
      />
    </div>
  );
}

function DonutCard({
  title,
  note,
  slices,
  empty,
  footer,
}: {
  title: string;
  note?: string;
  slices: Slice[] | null;
  empty: string;
  footer?: string;
}) {
  const total = (slices ?? []).reduce((s, x) => s + x.amount, 0);
  return (
    <Card className="p-5 flex flex-col">
      <h3 className="font-semibold">{title}</h3>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      {!slices || total <= 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 flex items-center gap-4">
          <div className="h-24 w-24 shrink-0" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices.filter((s) => s.amount > 0)}
                  dataKey="amount"
                  nameKey="label"
                  innerRadius="62%"
                  outerRadius="100%"
                  stroke="none"
                  isAnimationActive={false}
                >
                  {slices
                    .filter((s) => s.amount > 0)
                    .map((s) => (
                      <Cell key={s.key} fill={s.color} />
                    ))}
                </Pie>
                <Tooltip formatter={(v: number, n: string) => [usd(v), n]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="min-w-0 flex-1 space-y-2 text-sm">
            {slices.map((s) => (
              <li key={s.key} className="flex gap-2">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
                <span className="min-w-0 leading-tight">
                  <span className="block text-muted-foreground">{s.label}</span>
                  <span className="block font-semibold tabular-nums">
                    {usd(s.amount)} <span className="font-normal text-xs text-muted-foreground">· {pct(s.pct)}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {footer && <p className="mt-auto pt-4 text-xs text-muted-foreground">{footer}</p>}
    </Card>
  );
}
