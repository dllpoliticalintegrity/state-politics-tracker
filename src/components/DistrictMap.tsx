import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { featureLabelAnchor, featurePath, fitMercator, type FeatureCollection } from "@/lib/geo";
import { formatCurrency } from "@/lib/finance";
import type { TxCandidate } from "@/hooks/useCandidates";

export interface DistrictRow {
  district: string;
  cands: TxCandidate[]; // sorted by raised, desc
  total: number;
}

/**
 * Who leads the money in a district, as a colour class. Two-party
 * legislatures make this the useful categorical read; anything else folds
 * into "other" (a fixed, validated third hue) and districts with no money
 * yet are a neutral surface — never confused with a party.
 */
export type LeadClass = "dem" | "rep" | "other" | "none";

export function leadClass(row: DistrictRow | undefined, raised: (c: TxCandidate) => number): LeadClass {
  const top = row?.cands[0];
  if (!top || raised(top) <= 0) return "none";
  const p = (top.party ?? "").trim().toUpperCase();
  if (p.startsWith("D")) return "dem";
  if (p.startsWith("R")) return "rep";
  return "other";
}

const FILL: Record<LeadClass, string> = {
  dem: "hsl(var(--dem))",
  rep: "hsl(var(--rep))",
  other: "hsl(var(--map-other))",
  none: "hsl(var(--muted))",
};

const LEGEND: { cls: LeadClass; label: string }[] = [
  { cls: "dem", label: "Democrat leads" },
  { cls: "rep", label: "Republican leads" },
  { cls: "other", label: "Other party leads" },
  { cls: "none", label: "No money reported" },
];

/**
 * Choropleth of a chamber's districts, coloured by which party's candidate
 * has raised the most. Hover for the district's totals; click through to
 * the district dashboard. The table under it is the accessible/complete
 * view of the same numbers.
 */
export default function DistrictMap({
  geoUrl,
  title,
  rows,
  raised,
  base,
}: {
  geoUrl: string;
  title: string;
  rows: DistrictRow[];
  raised: (c: TxCandidate) => number;
  /** URL prefix of the chamber, e.g. "/state-senate" */
  base: string;
}) {
  const { data: fc, isLoading, error } = useQuery({
    queryKey: ["district-map", geoUrl],
    queryFn: async (): Promise<FeatureCollection> => {
      const res = await fetch(geoUrl);
      if (!res.ok) throw new Error(`${res.status} loading ${geoUrl}`);
      return res.json();
    },
    staleTime: Infinity,
  });
  const [hover, setHover] = useState<{ district: string; x: number; y: number; flip: boolean } | null>(null);
  // Tooltip position from a mouse event, in CSS px relative to the svg; flip
  // to the cursor's left on the right 40% so it stays inside the map.
  const place = (e: React.MouseEvent, district: string) => {
    const box = (e.currentTarget as unknown as SVGElement).closest("svg")!.getBoundingClientRect();
    const x = e.clientX - box.left;
    setHover({ district, x, y: e.clientY - box.top, flip: x > box.width * 0.6 });
  };

  const byDistrict = useMemo(() => new Map(rows.map((r) => [r.district, r])), [rows]);

  const shapes = useMemo(() => {
    if (!fc) return null;
    const proj = fitMercator(fc, 600, 4);
    const items = fc.features
      .map((f) => {
        const district = String(f.properties.district ?? "");
        const anchor = featureLabelAnchor(f, proj);
        return { district, d: featurePath(f, proj), anchor };
      })
      .sort((a, b) => Number(a.district) - Number(b.district));
    return { proj, items };
  }, [fc]);

  if (error) {
    return <p className="text-sm text-muted-foreground">Map unavailable ({(error as Error).message}).</p>;
  }
  if (isLoading || !shapes) {
    return <div className="aspect-[4/3] w-full rounded-md bg-muted/40 animate-pulse" aria-hidden />;
  }

  const hovered = hover ? byDistrict.get(hover.district) : undefined;
  const hoveredTop = hovered?.cands[0];
  // Label districts whose largest polygon is wide enough for two digits.
  const labelMin = shapes.items.length > 60 ? 26 : 18;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${shapes.proj.width} ${shapes.proj.height}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={`${title} map, coloured by the party of each district's top fundraiser`}
        onMouseLeave={() => setHover(null)}
      >
        {shapes.items.map(({ district, d, anchor }) => {
          const row = byDistrict.get(district);
          const cls = leadClass(row, raised);
          const active = hover?.district === district;
          return (
            <Link
              key={district}
              to={`${base}/${district}`}
              aria-label={`District ${district}: ${row && row.total > 0 ? `${formatCurrency(row.total)} raised` : "no money reported"}`}
              onMouseEnter={(e) => place(e, district)}
              onMouseMove={(e) => place(e, district)}
              onFocus={() => setHover({ district, x: anchor.x, y: anchor.y, flip: false })}
              onBlur={() => setHover(null)}
              className="outline-none"
            >
              <path
                d={d}
                fill={FILL[cls]}
                fillOpacity={active ? 1 : cls === "none" ? 1 : 0.82}
                stroke={active ? "hsl(var(--foreground))" : "hsl(var(--card))"}
                strokeWidth={active ? 2 : 1}
                strokeLinejoin="round"
                className="transition-[fill-opacity] duration-150 cursor-pointer"
              />
              {anchor.width >= labelMin && (
                <text
                  x={anchor.x}
                  y={anchor.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={shapes.items.length > 60 ? 9 : 11}
                  fontWeight={600}
                  fill={cls === "none" ? "hsl(var(--muted-foreground))" : "hsl(var(--card))"}
                  className="pointer-events-none"
                >
                  {district}
                </text>
              )}
            </Link>
          );
        })}
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-card px-3 py-2 text-xs shadow-md max-w-[240px]"
          style={
            hover.flip
              ? { right: `calc(100% - ${hover.x - 12}px)`, top: hover.y + 12 }
              : { left: hover.x + 12, top: hover.y + 12 }
          }
        >
          <div className="font-display text-sm font-semibold">District {hover.district}</div>
          {hovered && hovered.cands.length > 0 ? (
            <>
              <div className="text-muted-foreground">
                {hovered.cands.length} candidate{hovered.cands.length === 1 ? "" : "s"} ·{" "}
                {hovered.total > 0 ? `${formatCurrency(hovered.total)} raised` : "no money reported"}
              </div>
              {hoveredTop && raised(hoveredTop) > 0 && (
                <div className="mt-1">
                  <span className="font-medium">{hoveredTop.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    ({hoveredTop.party ?? "no party"}) · {formatCurrency(raised(hoveredTop))}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground">No committee on file</div>
          )}
        </div>
      )}

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Legend">
        {LEGEND.map(({ cls, label }) => (
          <li key={cls} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-[3px] border"
              style={{ backgroundColor: FILL[cls], borderColor: cls === "none" ? "hsl(var(--border))" : FILL[cls] }}
              aria-hidden
            />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
