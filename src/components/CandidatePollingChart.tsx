import {
  Area,
  AreaChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { useMemo } from "react";
import { isGeneralMatchup, useTxGovRacePolls } from "@/hooks/usePolling";
import { partyColor } from "@/lib/finance";

// Same CUD-safe palette as the overview chart so colors stay consistent.
const CANDIDATE_COLORS: Record<string, string> = {
  "steve-hilton":         "#D55E00",
  "chad-bianco":          "#E69F00",
  "katie-porter":         "#56B4E9",
  "tom-steyer":           "#CC79A7",
  "eric-swalwell":        "#0072B2",
  "antonio-villaraigosa": "#009E73",
  "tony-thurmond":        "#B276B2",
  "xavier-becerra":       "#F0E442",
  "betty-yee":            "#7DCEA0",
  "matt-mahan":           "#BEBEBE",
};

const WINDOW_DAYS = 30;

type Props = {
  candidate: {
    slug: string;
    name: string;
    party: string | null;
  };
};

export default function CandidatePollingChart({ candidate }: Props) {
  const { data: racePollsAll, isLoading } = useTxGovRacePolls();
  const racePolls = (racePollsAll ?? []).filter((r) => isGeneralMatchup(r.matchup));
  const surname = candidate.name.trim().split(/\s+/).pop() ?? "";
  const color =
    CANDIDATE_COLORS[candidate.slug] ?? partyColor(candidate.party) ?? "hsl(var(--primary))";

  const { rawPoints, rollingPoints } = useMemo(() => {
    if (!racePolls) return { rawPoints: [], rollingPoints: [] };
    const todayIso = new Date().toISOString().slice(0, 10);

    const raw = racePolls
      .filter((r) => (r.candidate_name.trim().split(/\s+/).pop() ?? "") === surname)
      .map((r) => {
        const iso = (r.field_end ?? "").slice(0, 10);
        const n = Number(r.pct);
        if (!iso || iso > todayIso || !Number.isFinite(n)) return null;
        return { iso, pct: n, label: iso, pollster: r.pollster };
      })
      .filter((x): x is { iso: string; pct: number; label: string; pollster: string } => x !== null)
      .sort((a, b) => a.iso.localeCompare(b.iso));

    // Rolling average per unique date
    const msDay = 24 * 60 * 60 * 1000;
    const uniqueDates = Array.from(new Set(raw.map((r) => r.iso))).sort();
    const rolling = uniqueDates.map((iso) => {
      const end = new Date(iso).getTime();
      const start = end - WINDOW_DAYS * msDay;
      const window = raw.filter((p) => {
        const t = new Date(p.iso).getTime();
        return t >= start && t <= end;
      });
      const mean =
        window.reduce((s, p) => s + p.pct, 0) / Math.max(1, window.length);
      return { date: iso, pct: Math.round(mean * 10) / 10, samples: window.length };
    });

    return { rawPoints: raw, rollingPoints: rolling };
  }, [racePolls, surname]);

  if (isLoading) {
    return (
      <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">
        Loading polling…
      </div>
    );
  }
  if (rollingPoints.length < 2) {
    return (
      <div className="h-[140px] flex items-center justify-center text-sm text-muted-foreground">
        Not enough polls to chart {candidate.name}'s trend yet.
      </div>
    );
  }

  const gradientId = `cp-grad-${candidate.slug}`;
  const maxPct = Math.max(...rollingPoints.map((p) => p.pct));
  const yMax = Math.max(10, Math.ceil(maxPct / 5) * 5 + 5);

  return (
    <div className="w-full h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rollingPoints} margin={{ top: 12, right: 20, left: -10, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.4} />
          <XAxis
            dataKey="date"
            tickFormatter={(d) =>
              new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
          />
          <YAxis
            unit="%"
            domain={[0, yMax]}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
          />
          <Tooltip
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const pct = Number(payload[0].value);
              const samples = (payload[0].payload as { samples?: number })?.samples ?? 0;
              const dateLabel =
                typeof label === "string"
                  ? new Date(label).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "";
              return (
                <div
                  style={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontFamily: "Inter",
                    fontSize: 12,
                    padding: "8px 10px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                    minWidth: 180,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: "hsl(var(--muted-foreground))",
                      marginBottom: 4,
                    }}
                  >
                    {dateLabel}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <strong style={{ color, fontSize: 18 }}>{pct.toFixed(1)}%</strong>
                    <span style={{ color: "hsl(var(--muted-foreground))", fontSize: 10 }}>
                      30-day avg · {samples} poll{samples === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="pct"
            stroke={color}
            strokeWidth={2.4}
            fill={`url(#${gradientId})`}
            dot={{ r: 3, fill: color, stroke: color }}
            activeDot={{ r: 5 }}
          />
          <ReferenceLine y={0} stroke="hsl(var(--border))" />
        </AreaChart>
      </ResponsiveContainer>
      <div className="text-xs text-muted-foreground mt-2">
        30-day rolling average · {rawPoints.length} polls
      </div>
    </div>
  );
}
