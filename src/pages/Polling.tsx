import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";
import PollingChart from "@/components/PollingChart";
import { useCandidates } from "@/hooks/useCandidates";
import {
  useTxGovPolling,
  useTxGovRacePolls,
  type RacePollRow,
} from "@/hooks/usePolling";
import { partyColor } from "@/lib/finance";

// One row per poll: race_polls stores one row per candidate per poll, so
// group by (pollster, field_end, matchup) and pivot pcts by surname.
type PollGroup = {
  key: string;
  pollster: string;
  field_end: string;
  matchup: string;
  sample: string | null;
  source_url: string | null;
  pcts: Record<string, number>;
};

function groupPolls(rows: RacePollRow[]): PollGroup[] {
  const map = new Map<string, PollGroup>();
  for (const r of rows) {
    const matchup = r.matchup ?? "general";
    const key = `${r.pollster}|${r.field_end}|${matchup}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        pollster: r.pollster,
        field_end: r.field_end,
        matchup,
        sample: null,
        source_url: r.source_url ?? null,
        pcts: {},
      };
      map.set(key, g);
    }
    if (!g.sample && r.sample_size) {
      g.sample = `${r.sample_size}${r.sample_kind ? ` ${r.sample_kind}` : ""}`;
    }
    const surname = r.candidate_name.trim().split(/\s+/).pop() ?? r.candidate_name;
    g.pcts[surname] = Number(r.pct);
  }
  return [...map.values()].sort((a, b) => b.field_end.localeCompare(a.field_end));
}

function matchupLabel(m: string): string {
  if (m === "dem_primary") return "D primary";
  if (m === "rep_primary") return "R primary";
  return "General";
}

function spreadOf(g: PollGroup): string {
  const ranked = Object.entries(g.pcts).sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2) return "—";
  const diff = Math.round((ranked[0][1] - ranked[1][1]) * 10) / 10;
  return diff === 0 ? "Tie" : `${ranked[0][0]} +${diff}`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return m && d ? `${Number(m)}/${Number(d)}/${y?.slice(2)}` : iso;
}

export default function Polling() {
  const { data: polling, isLoading, error } = useTxGovPolling();
  const { data: racePolls, isLoading: pollsLoading } = useTxGovRacePolls();
  const { data: candidates } = useCandidates();

  const groups = useMemo(() => groupPolls(racePolls ?? []), [racePolls]);

  // Candidates ordered by polling average %, only those with an averaged %
  const avg = polling?.average;
  const rankedCandidates = (candidates ?? [])
    .map((c) => {
      const surname = c.name.trim().split(/\s+/).pop() ?? "";
      const avgPct = avg && avg[surname] ? Number(avg[surname]) : null;
      return { cand: c, surname, avgPct };
    })
    .filter((x) => x.avgPct !== null)
    .sort((a, b) => (b.avgPct ?? 0) - (a.avgPct ?? 0));

  // Column set: averaged candidates first, then anyone else who shows up in
  // a poll (primary also-rans), capped so the table stays scannable.
  const columnSurnames = useMemo(() => {
    const cols = rankedCandidates.map((x) => x.surname);
    for (const g of groups) {
      for (const s of Object.keys(g.pcts)) {
        if (!cols.includes(s)) cols.push(s);
      }
    }
    return cols.slice(0, 7);
  }, [rankedCandidates, groups]);

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          2026 Texas Governor's race
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Polling</h1>
        <p className="text-base text-muted-foreground">
          The 270toWin aggregate and every individual poll, updated nightly.
        </p>
      </section>

      <section className="container pb-6">
        <Card className="p-4 md:p-6">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-display text-xl md:text-2xl font-semibold">Polling average</h2>
            <span className="text-xs text-muted-foreground">
              {polling?.spread ? `Leading: ${polling.spread}` : ""}
            </span>
          </div>
          <PollingChart />
        </Card>
      </section>

      {avg && (
        <section className="container pb-6">
          <Card className="p-4 md:p-6">
            <h2 className="font-display text-lg font-semibold mb-4">
              Current average{avg.Date ? ` (as of ${avg.Date})` : ""}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              {rankedCandidates.map(({ cand, avgPct }) => (
                <div
                  key={cand.slug}
                  className="border rounded-md p-3 flex items-center gap-3"
                >
                  <span
                    className="text-[11px] font-semibold px-1.5 py-0.5 rounded-sm"
                    style={{ backgroundColor: partyColor(cand.party), color: "white" }}
                  >
                    {cand.party ?? "—"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{cand.name}</div>
                    <div className="font-mono font-semibold tabular-nums">{avgPct}%</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      <section className="container pb-16">
        <Card className="overflow-hidden">
          <div className="p-4 md:p-6 border-b flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="font-display text-lg font-semibold">
              All polls <span className="text-muted-foreground font-normal">({groups.length})</span>
            </h2>
            <a
              href="https://www.270towin.com/2026-governor-polls/texas"
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
            >
              View on 270toWin <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {(isLoading || pollsLoading) && (
            <div className="p-10 text-sm text-muted-foreground text-center">
              Loading polls…
            </div>
          )}
          {error && (
            <div className="p-10 text-sm text-destructive text-center">
              Something went wrong loading polls. Try refreshing.
            </div>
          )}

          {/* Mobile: one card per poll — no sideways scrolling needed */}
          {!pollsLoading && groups.length > 0 && (
            <ul className="md:hidden divide-y divide-border/40">
              {groups.map((g) => (
                <li key={g.key} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium truncate">
                      {g.source_url ? (
                        <a
                          href={g.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:text-primary"
                        >
                          {g.pollster}
                        </a>
                      ) : (
                        g.pollster
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {fmtDate(g.field_end)}
                    </span>
                  </div>
                  <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground">
                      {matchupLabel(g.matchup)}
                    </span>
                    {Object.entries(g.pcts)
                      .sort((a, b) => b[1] - a[1])
                      .map(([s, p]) => (
                        <span key={s} className="tabular-nums">
                          <span className="text-muted-foreground">{s}</span>{" "}
                          <span className="font-semibold">{p}%</span>
                        </span>
                      ))}
                    <span className="text-muted-foreground ml-auto tabular-nums">{spreadOf(g)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Desktop: classic pivot table */}
          {!pollsLoading && groups.length > 0 && (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Poll</th>
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-left px-4 py-2 font-medium">Matchup</th>
                    <th className="text-left px-4 py-2 font-medium">Sample</th>
                    {columnSurnames.map((s) => (
                      <th
                        key={s}
                        className="text-right px-3 py-2 font-medium whitespace-nowrap"
                      >
                        {s}
                      </th>
                    ))}
                    <th className="text-left px-4 py-2 font-medium">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.key} className="border-b border-border/60 hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium">
                        {g.source_url ? (
                          <a
                            href={g.source_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="hover:text-primary"
                          >
                            {g.pollster}
                          </a>
                        ) : (
                          g.pollster
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                        {fmtDate(g.field_end)}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {matchupLabel(g.matchup)}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                        {g.sample ?? "—"}
                      </td>
                      {columnSurnames.map((s) => (
                        <td key={s} className="px-3 py-2 text-right font-mono tabular-nums">
                          {g.pcts[s] !== undefined ? `${g.pcts[s]}%` : "—"}
                        </td>
                      ))}
                      <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                        {spreadOf(g)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!pollsLoading && groups.length === 0 && !error && (
            <div className="p-10 text-sm text-muted-foreground text-center">
              No polls yet.
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
