// The Top Donors list as a pie: the six biggest donors as their own slices,
// everyone else folded into "Other". A legend beside the pie carries each
// slice's name, amount and share (the marks never carry text themselves),
// and a slice or legend row opens the same breakdown as the list row.
import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { pieSlices, sliceColor, type DonorLike, type PieSlice } from "@/lib/donorCharts";
import { formatCurrencyFull } from "@/lib/finance";

const pct = (p: number) => `${(p * 100).toFixed(p < 0.095 ? 1 : 0)}%`;

export default function DonorPieChart({
  donors,
  totalLabel,
  onSelect,
}: {
  donors: DonorLike[];
  /** What the whole pie stands for, e.g. "the top 50 donors to campaigns". */
  totalLabel: string;
  onSelect?: (key: string) => void;
}) {
  const slices = pieSlices(donors);
  const [active, setActive] = useState<string | null>(null);
  if (slices.length === 0) return null;
  const total = slices.reduce((s, x) => s + x.amount, 0);

  const select = (s: PieSlice) => {
    if (s.series !== null) onSelect?.(s.key);
  };

  return (
    <div className="rounded-lg border bg-card p-4 sm:p-5">
      <p className="text-xs text-muted-foreground">
        Share of the {formatCurrencyFull(total)} given by {totalLabel}. Select a slice for the breakdown.
      </p>
      <div className="mt-3 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="h-56 w-56 shrink-0 sm:h-64 sm:w-64" role="img" aria-label={`Pie chart of ${totalLabel}`}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="amount"
                nameKey="name"
                innerRadius="38%"
                outerRadius="100%"
                paddingAngle={1}
                stroke="hsl(var(--card))"
                strokeWidth={2}
                isAnimationActive={false}
                onClick={(_, i) => select(slices[i])}
                onMouseEnter={(_, i) => setActive(slices[i].key)}
                onMouseLeave={() => setActive(null)}
              >
                {slices.map((s) => (
                  <Cell
                    key={s.key}
                    fill={sliceColor(s)}
                    opacity={active && active !== s.key ? 0.6 : 1}
                    cursor={s.series !== null ? "pointer" : "default"}
                  />
                ))}
              </Pie>
              <Tooltip
                wrapperClassName="max-w-[calc(100vw-4rem)] whitespace-normal"
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  color: "hsl(var(--popover-foreground))",
                  fontSize: 12,
                }}
                itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                formatter={(v: number, _n: string, item: { payload?: PieSlice }) => [
                  `${formatCurrencyFull(v)} · ${pct(item.payload?.pct ?? 0)}`,
                  item.payload?.name ?? "",
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ol className="w-full min-w-0 flex-1 space-y-1.5 text-sm" aria-label="Pie legend">
          {slices.map((s) => {
            // On a phone the amount drops under the name so a long committee
            // name keeps its width; from `sm` up it sits at the row's end.
            const row = (
              <>
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: sliceColor(s) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words leading-tight">{s.name}</span>
                <span className="col-start-2 whitespace-nowrap font-mono text-xs tabular-nums sm:col-start-3 sm:text-right">
                  {formatCurrencyFull(s.amount)}{" "}
                  <span className="text-muted-foreground">· {pct(s.pct)}</span>
                </span>
              </>
            );
            const cls = `grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left sm:grid-cols-[auto_minmax(0,1fr)_auto] ${
              active === s.key ? "bg-accent" : ""
            }`;
            return (
              <li key={s.key}>
                {s.series !== null ? (
                  <button
                    type="button"
                    className={`${cls} hover:bg-accent`}
                    onClick={() => select(s)}
                    onMouseEnter={() => setActive(s.key)}
                    onMouseLeave={() => setActive(null)}
                  >
                    {row}
                  </button>
                ) : (
                  <div className={`${cls} text-muted-foreground`}>{row}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
