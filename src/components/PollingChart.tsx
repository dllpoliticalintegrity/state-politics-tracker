import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { useMemo } from "react";
import { useCandidates } from "@/hooks/useCandidates";
import { isGeneralMatchup, parsePollDate, useTxGovPolling, useTxGovRacePolls } from "@/hooks/usePolling";
import { partyColor } from "@/lib/finance";

// Trailing-window width for the rolling average (days).
const WINDOW_DAYS = 30;

export default function PollingChart() {
  const { data: polling, isLoading } = useTxGovPolling();
  const { data: racePollsAll } = useTxGovRacePolls();
  const racePolls = (racePollsAll ?? []).filter((r) => isGeneralMatchup(r.matchup));
  const { data: candidates } = useCandidates();

  const { series, data } = useMemo(() => {
    if (!polling || !candidates) return { series: [], data: [] };

    // Today (ISO) — we never plot beyond this.
    const todayIso = new Date().toISOString().slice(0, 10);

    // Candidates actually averaged by RCP, sorted by their current avg %
    const avg = polling.average;
    const withPct = candidates
      .map((c) => {
        const surname = c.name.trim().split(/\s+/).pop() ?? "";
        const avgPct = avg && avg[surname] ? Number(avg[surname]) : 0;
        return { cand: c, surname, avgPct };
      })
      .filter((x) => x.avgPct > 0)
      .sort((a, b) => b.avgPct - a.avgPct);

    // Normalize each poll into {iso, values: {surname -> pct}}; drop polls with unparseable
    // dates or dates beyond today. Prefer per-poll rows from race_polls (270toWin backfill);
    // fall back to the legacy RCP raw_data array.
    type NormalizedPoll = { iso: string; values: Record<string, number> };
    const normalized: NormalizedPoll[] = [];
    if (racePolls && racePolls.length > 0) {
      const byKey = new Map<string, NormalizedPoll>();
      for (const r of racePolls) {
        const iso = (r.field_end ?? "").slice(0, 10);
        if (!iso || iso > todayIso) continue;
        const surname = r.candidate_name.trim().split(/\s+/).pop() ?? "";
        const key = `${iso}|${r.pollster}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { iso, values: {} };
          byKey.set(key, entry);
        }
        if (Number.isFinite(r.pct)) entry.values[surname] = Number(r.pct);
      }
      for (const e of byKey.values()) {
        if (Object.keys(e.values).length > 0) normalized.push(e);
      }
    } else {
      for (const poll of polling.polls) {
        const iso = parsePollDate(poll.Date);
        if (!iso || iso === "0000-00-00" || iso > todayIso) continue;
        const values: Record<string, number> = {};
        for (const { surname } of withPct) {
          const v = poll[surname];
          if (v !== undefined && v !== "") {
            const n = Number(v);
            if (Number.isFinite(n)) values[surname] = n;
          }
        }
        if (Object.keys(values).length > 0) normalized.push({ iso, values });
      }
    }
    normalized.sort((a, b) => a.iso.localeCompare(b.iso));
    if (normalized.length === 0) return { series: [], data: [] };

    // For each unique poll date, compute a trailing WINDOW_DAYS rolling average per candidate
    // using every poll that ended within the window. That smooths the raw polls into an
    // average line while never extrapolating past today.
    const uniqueDates = Array.from(new Set(normalized.map((p) => p.iso))).sort();

    const msDay = 24 * 60 * 60 * 1000;
    const rolling = uniqueDates.map((iso) => {
      const end = new Date(iso).getTime();
      const start = end - WINDOW_DAYS * msDay;
      const inWindow = normalized.filter((p) => {
        const t = new Date(p.iso).getTime();
        return t >= start && t <= end;
      });
      const point: Record<string, any> = { date: iso };
      for (const { cand, surname } of withPct) {
        const samples = inWindow
          .map((p) => p.values[surname])
          .filter((n): n is number => typeof n === "number");
        if (samples.length > 0) {
          const mean = samples.reduce((s, n) => s + n, 0) / samples.length;
          point[cand.slug] = Math.round(mean * 10) / 10;
        }
      }
      return point;
    });

    return {
      series: withPct.map(({ cand }) => ({
        slug: cand.slug,
        name: cand.name,
        party: cand.party,
        color: partyColor(cand.party),
        photoUrl: cand.photo_url_thumb ?? cand.photo_url ?? null,
        withdrawn: cand.status === "withdrawn" || cand.status === "dropped_out",
      })),
      data: rolling,
    };
  }, [polling, racePolls, candidates]);

  const seriesBySlug = useMemo(() => {
    const m = new Map<string, (typeof series)[number]>();
    for (const s of series) m.set(s.slug, s);
    return m;
  }, [series]);

  if (isLoading) {
    return (
      <div className="h-[420px] flex items-center justify-center text-sm text-muted-foreground">
        Loading polling…
      </div>
    );
  }
  if (!polling || !polling.average || data.length === 0) {
    return (
      <div className="h-[120px] flex items-center justify-center text-sm text-muted-foreground">
        No polling data yet.
      </div>
    );
  }

  return (
    <div className="w-full h-[320px] md:h-[420px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.4} />
          <XAxis
            dataKey="date"
            tickFormatter={(d) =>
              new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
            minTickGap={28}
          />
          <YAxis
            unit="%"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11, fontFamily: "Inter" }}
            stroke="hsl(var(--border))"
            domain={[0, "dataMax + 5"]}
            width={36}
          />
          <Tooltip
            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const dateLabel =
                typeof label === "string"
                  ? new Date(label).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "";
              const sorted = [...payload]
                .filter((p) => typeof p.value === "number")
                .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
              return (
                <div
                  style={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontFamily: "Inter",
                    fontSize: 12,
                    padding: "10px 12px",
                    minWidth: 200,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: "hsl(var(--muted-foreground))",
                      marginBottom: 6,
                    }}
                  >
                    {dateLabel}
                  </div>
                  {sorted.map((p) => {
                    const s = seriesBySlug.get(String(p.dataKey));
                    const lastName = s?.name.split(" ").pop() ?? "";
                    return (
                      <div
                        key={String(p.dataKey)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "3px 0",
                        }}
                      >
                        {s?.photoUrl ? (
                          <img
                            src={s.photoUrl}
                            alt=""
                            width={22}
                            height={22}
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: "50%",
                              objectFit: "cover",
                              border: `1.5px solid ${s?.color ?? "hsl(var(--border))"}`,
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: "50%",
                              border: `1.5px solid ${s?.color ?? "hsl(var(--border))"}`,
                              backgroundColor: "hsl(var(--muted))",
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <span style={{ color: "hsl(var(--card-foreground))", flex: 1, whiteSpace: "nowrap" }}>
                          {lastName}
                        </span>
                        <span
                          style={{
                            color: s?.color ?? "hsl(var(--card-foreground))",
                            fontWeight: 700,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {Number(p.value).toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontFamily: "Inter", fontSize: 11, lineHeight: "1.4", paddingTop: 4 }}
            iconSize={8}
            formatter={(value) => {
              const s = series.find((x) => x.slug === value);
              const label = s
                ? `${s.name.split(" ").pop()} (${s.party ?? "—"})${s.withdrawn ? " · out" : ""}`
                : value;
              return (
                <span
                  style={{
                    color: "hsl(var(--foreground))",
                    opacity: s?.withdrawn ? 0.5 : 1,
                    textDecoration: s?.withdrawn ? "line-through" : "none",
                  }}
                >
                  {label}
                </span>
              );
            }}
          />
          {series.map((s) => (
            <Line
              key={s.slug}
              type="monotone"
              dataKey={s.slug}
              stroke={s.color}
              strokeOpacity={s.withdrawn ? 0.3 : 1}
              strokeDasharray={s.withdrawn ? "4 4" : undefined}
              strokeWidth={s.withdrawn ? 1.5 : 2}
              dot={false}
              activeDot={{ r: 5 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
