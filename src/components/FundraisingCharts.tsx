// The race page's "Fundraising" card: money raised over time (cumulative
// per candidate, by month) beside the mix of donation sizes per candidate.
// Pure maths in src/lib/fundraisingCharts.ts; rows from
// useRaceContributionMonths / useRaceContributionSizes.
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import {
  useCandidates,
  useCandidateTotals,
  useRaceContributionMonths,
  useRaceContributionSizes,
  type TxCandidate,
} from "@/hooks/useCandidates";
import { useRaceConfig } from "@/states/StateContext";
import { isOffBallot } from "@/lib/candidateStatus";
import { formatCurrency, formatCurrencyFull, partyColor } from "@/lib/finance";
import { vizColor } from "@/lib/donorCharts";
import {
  SIZE_BINS,
  SIZE_BIN_LABEL,
  cumulativeByMonth,
  monthLabel,
  monthLabelLong,
  rampColor,
  sizeMix,
  timelineWindow,
  type MonthRow,
  type SizeRow,
} from "@/lib/fundraisingCharts";

/** Lines the timeline draws by name; everyone else is one "All others" line. */
const MAX_LINES = 6;
const OTHERS = "__others";
const SIZE_ROWS_SHOWN = 8;

type Ranked = { cand: TxCandidate; raised: number };

const lastName = (name: string) => name.trim().split(/\s+/).pop() ?? name;

export default function FundraisingCharts() {
  const { data: candidates } = useCandidates();
  const { data: totals } = useCandidateTotals();
  const months = useRaceContributionMonths();
  const sizes = useRaceContributionSizes();

  // Every candidate with money, biggest first: the colour slot a candidate
  // gets is their rank here, so it never changes with what is shown.
  const ranked: Ranked[] = useMemo(
    () =>
      (candidates ?? [])
        .map((c) => ({ cand: c, raised: totals?.get(c.id)?.raised ?? 0 }))
        .filter((x) => x.raised > 0)
        .sort((a, b) => b.raised - a.raised),
    [candidates, totals],
  );

  const hasMonths = (months.data?.length ?? 0) > 0;
  const hasSizes = (sizes.data?.length ?? 0) > 0;
  if (ranked.length === 0 || (!hasMonths && !hasSizes)) return null;

  return (
    <section className="container pb-10">
      <Card className="p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl md:text-2xl font-semibold">Fundraising</h2>
          <span className="text-xs text-muted-foreground">Contributions to each campaign, from the state's filings</span>
        </div>
        <div className="grid gap-8 lg:grid-cols-5">
          {hasMonths && (
            <div className="min-w-0 lg:col-span-3">
              <h3 className="text-sm font-semibold">Raised over time</h3>
              <p className="mb-2 text-xs text-muted-foreground">Running total by month, through this month.</p>
              <Timeline ranked={ranked} rows={months.data!} />
            </div>
          )}
          {hasSizes && (
            <div className={`min-w-0 ${hasMonths ? "lg:col-span-2" : "lg:col-span-5"}`}>
              <h3 className="text-sm font-semibold">Donation sizes</h3>
              <p className="mb-2 text-xs text-muted-foreground">Share of each campaign's money by the size of the gift.</p>
              <SizeMix ranked={ranked} rows={sizes.data!} />
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

function Timeline({ ranked, rows }: { ranked: Ranked[]; rows: MonthRow[] }) {
  const race = useRaceConfig();
  const { series, data } = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const window = timelineWindow(rows, race.generalDate, today);
    if (!window) return { series: [], data: [] };
    const named = ranked.slice(0, MAX_LINES);
    const rest = ranked.slice(MAX_LINES);
    const keys: Record<string, string[]> = {};
    for (const r of named) keys[r.cand.id] = [r.cand.id];
    if (rest.length) keys[OTHERS] = rest.map((r) => r.cand.id);
    const series = named.map((r, i) => ({
      key: r.cand.id,
      label: `${lastName(r.cand.name)} (${r.cand.party ?? "—"})`,
      color: vizColor(i),
      party: r.cand.party,
      withdrawn: isOffBallot(r.cand.status),
    }));
    if (rest.length) {
      series.push({ key: OTHERS, label: `All others (${rest.length})`, color: vizColor(null), party: null, withdrawn: false });
    }
    return { series, data: cumulativeByMonth(rows, keys, window) };
  }, [ranked, rows, race.generalDate]);

  if (data.length === 0) return null;
  const byKey = new Map(series.map((s) => [s.key, s]));

  return (
    <div className="h-[280px] w-full min-w-0 md:h-[340px]" role="img" aria-label="Money raised over time, by candidate">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.4} vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={monthLabel}
            minTickGap={28}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => formatCurrency(v)}
            width={58}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            // Pinned to the chart's top-left corner, as the polling chart's
            // is: a floating box cannot fit beside the cursor on a phone.
            position={{ x: 0, y: 0 }}
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const sorted = [...payload]
                .filter((p) => typeof p.value === "number")
                .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
              return (
                <div className="w-64 max-w-[calc(100vw-5rem)] rounded-md border bg-card p-3 font-sans text-xs shadow-md">
                  <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {typeof label === "string" ? monthLabelLong(label) : ""}
                  </div>
                  {sorted.map((p) => {
                    const s = byKey.get(String(p.dataKey));
                    return (
                      <div key={String(p.dataKey)} className="flex items-center justify-between gap-2 py-0.5">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s?.color }} aria-hidden="true" />
                          <span className="truncate">{s?.label ?? p.dataKey}</span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">{formatCurrencyFull(Number(p.value))}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {/* One line needs no legend: the heading names it. */}
          {series.length > 1 && (
          <Legend
            wrapperStyle={{ fontFamily: "Inter", fontSize: 11, lineHeight: "1.4", paddingTop: 6 }}
            iconSize={8}
            formatter={(value) => {
              const s = byKey.get(String(value));
              return (
                <span
                  className="whitespace-normal break-words"
                  style={{
                    color: "hsl(var(--foreground))",
                    opacity: s?.withdrawn ? 0.6 : 1,
                    textDecoration: s?.withdrawn ? "line-through" : "none",
                  }}
                >
                  {s?.label ?? value}
                </span>
              );
            }}
          />
          )}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={s.key === OTHERS ? 1.5 : 2}
              strokeDasharray={s.key === OTHERS || s.withdrawn ? "4 4" : undefined}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SizeMix({ ranked, rows }: { ranked: Ranked[]; rows: SizeRow[] }) {
  const [showAll, setShowAll] = useState(false);
  // Tapping a bar lists its exact figures under it: the segments' `title`
  // tooltips need a mouse, and the smallest segments carry no label.
  const [openId, setOpenId] = useState<string | null>(null);
  const mix = useMemo(() => sizeMix(rows), [rows]);
  const list = ranked.filter((r) => (mix.get(r.cand.id)?.total ?? 0) > 0);
  const shown = showAll ? list : list.slice(0, SIZE_ROWS_SHOWN);
  if (list.length === 0) return null;

  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend">
        {SIZE_BINS.map((bin, i) => (
          <li key={bin} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: rampColor(i) }} aria-hidden="true" />
            {SIZE_BIN_LABEL[bin]}
          </li>
        ))}
      </ul>
      <ol className="space-y-3">
        {shown.map(({ cand }) => {
          const m = mix.get(cand.id)!;
          return (
            <li key={cand.id}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: partyColor(cand.party) }}
                    aria-hidden="true"
                  />
                  <span className={`truncate ${isOffBallot(cand.status) ? "line-through opacity-60" : ""}`}>{cand.name}</span>
                </span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{formatCurrency(m.total)}</span>
              </div>
              <button
                type="button"
                aria-expanded={openId === cand.id}
                aria-label={`${cand.name}: ${SIZE_BINS.map((b) => `${SIZE_BIN_LABEL[b]} ${Math.round(m.shares[b] * 100)}%`).join(", ")}. Show the figures`}
                onClick={() => setOpenId((v) => (v === cand.id ? null : cand.id))}
                className="mt-1 flex h-6 w-full gap-[2px] overflow-hidden rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SIZE_BINS.map((bin, i) => {
                  const share = m.shares[bin];
                  if (share <= 0) return null;
                  const pct = Math.round(share * 100);
                  return (
                    <div
                      key={bin}
                      className="flex min-w-0 items-center justify-center overflow-hidden text-[10px] font-semibold text-white"
                      style={{ width: `${share * 100}%`, background: rampColor(i) }}
                      title={`${SIZE_BIN_LABEL[bin]}: ${formatCurrencyFull(m.amounts[bin])} from ${m.counts[bin].toLocaleString()} gift${m.counts[bin] === 1 ? "" : "s"} (${pct}%)`}
                    >
                      {share >= 0.12 ? `${pct}%` : ""}
                    </div>
                  );
                })}
              </button>
              {openId === cand.id && (
                <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                  {SIZE_BINS.map((bin, i) => (
                    <li key={bin} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: rampColor(i) }} aria-hidden="true" />
                        {SIZE_BIN_LABEL[bin]}
                      </span>
                      <span className="ml-auto whitespace-nowrap font-mono tabular-nums text-foreground">
                        {formatCurrencyFull(m.amounts[bin])}{" "}
                        <span className="text-muted-foreground">· {m.counts[bin].toLocaleString()} gift{m.counts[bin] === 1 ? "" : "s"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {list.length > SIZE_ROWS_SHOWN && (
        <button
          type="button"
          className="mt-3 text-xs font-semibold text-primary hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all ${list.length} candidates`}
        </button>
      )}
    </div>
  );
}
