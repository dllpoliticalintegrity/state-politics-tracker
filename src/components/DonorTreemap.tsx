// A state's top 100 donors as a treemap: one cell per donor, area = dollars
// given across the state's statewide races, colour = individual vs.
// entity/PAC. Cells big enough carry the name (and amount); every cell has a
// hover tooltip, and the list under the chart has every donor for anyone
// the picture doesn't serve.
import { useState } from "react";
import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import {
  DONOR_KIND_LABEL,
  DONOR_KIND_SERIES,
  cellLabelLines,
  fitLabel,
  treemapCells,
  vizColor,
  type DonorKindClass,
  type DonorLike,
  type TreemapCell,
} from "@/lib/donorCharts";
import { formatCurrency, formatCurrencyFull } from "@/lib/finance";

const KINDS: DonorKindClass[] = ["individual", "entity", "unknown"];

function CellContent(props: Partial<TreemapCell> & { x?: number; y?: number; width?: number; height?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, name = "", value = 0, kind = "unknown", rank = 0 } = props;
  if (!width || !height) return null;
  const lines = cellLabelLines(width, height);
  const label = lines ? fitLabel(name, width) : "";
  // One treemap per page, so the rank is a unique clip id.
  const clipId = `donor-cell-${rank}`;
  return (
    <g clipPath={`url(#${clipId})`}>
      <clipPath id={clipId}>
        <rect x={x} y={y} width={width} height={height} />
      </clipPath>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={2}
        fill={vizColor(DONOR_KIND_SERIES[kind])}
        stroke="hsl(var(--card))"
        strokeWidth={2}
      />
      {label && (
        <text
          x={x + 5}
          y={y + 13}
          fill="#fff"
          fontSize={11}
          fontWeight={600}
          style={{ pointerEvents: "none" }}
        >
          {label}
        </text>
      )}
      {lines === 2 && (
        <text x={x + 5} y={y + 27} fill="#fff" fontSize={10} opacity={0.9} style={{ pointerEvents: "none" }}>
          {formatCurrency(value)}
        </text>
      )}
    </g>
  );
}

export default function DonorTreemap({ donors, limit = 100 }: { donors: DonorLike[]; limit?: number }) {
  const cells = treemapCells(donors, limit);
  const [listOpen, setListOpen] = useState(false);
  if (cells.length === 0) return null;
  const total = cells.reduce((s, c) => s + c.value, 0);
  const present = KINDS.filter((k) => cells.some((c) => c.kind === k));

  return (
    <div className="rounded-lg border bg-card p-3 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {formatCurrencyFull(total)} from the top {cells.length}. Bigger box, more given.
        </span>
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
          {present.map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: vizColor(DONOR_KIND_SERIES[k]) }} aria-hidden="true" />
              {DONOR_KIND_LABEL[k]}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 h-[360px] w-full sm:h-[460px]" role="img" aria-label={`Treemap of the top ${cells.length} donors`}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={cells}
            dataKey="value"
            nameKey="name"
            aspectRatio={4 / 3}
            isAnimationActive={false}
            content={<CellContent />}
          >
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
              formatter={(v: number, _n: string, item: { payload?: TreemapCell }) => {
                const c = item.payload;
                const gifts = c ? `${c.gifts} gift${c.gifts === 1 ? "" : "s"}` : "";
                return [
                  `${formatCurrencyFull(v)} · ${gifts} · ${c ? DONOR_KIND_LABEL[c.kind] : ""}`,
                  c ? `#${c.rank} ${c.name}` : "",
                ];
              }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
      <details className="mt-3" open={listOpen} onToggle={(e) => setListOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-xs font-semibold text-primary hover:underline">
          {listOpen ? "Hide the list" : `List all ${cells.length}`}
        </summary>
        <ol className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {cells.map((c) => (
            <li key={c.key} className="flex items-baseline gap-2">
              <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{c.rank}</span>
              <span className="min-w-0 flex-1 truncate" title={c.name}>
                {c.name}
              </span>
              <span className="shrink-0 font-mono tabular-nums">{formatCurrencyFull(c.value)}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
