import { useCandidates } from "@/hooks/useCandidates";
import { useTxGovPolling } from "@/hooks/usePolling";
import { partyColor } from "@/lib/finance";

export default function PollingAveragesList() {
  const { data: polling, isLoading } = useTxGovPolling();
  const { data: candidates } = useCandidates();

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!polling?.average || !candidates) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        No data
      </div>
    );
  }

  const avg = polling.average;
  const rows = candidates
    .map((c) => {
      const surname = c.name.trim().split(/\s+/).pop() ?? "";
      const pct = avg[surname] ? Number(avg[surname]) : 0;
      return {
        slug: c.slug,
        lastName: surname,
        party: c.party,
        pct,
        color: partyColor(c.party),
        photo: c.photo_url_thumb ?? c.photo_url ?? null,
        withdrawn: c.status === "withdrawn" || c.status === "dropped_out",
      };
    })
    .filter((r) => r.pct > 0)
    .sort((a, b) => b.pct - a.pct);

  const max = rows[0]?.pct ?? 1;

  return (
    <div className="h-full flex flex-col">
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground mb-3 pb-2 border-b flex items-center justify-between">
        <span>Current averages</span>
        <span>%</span>
      </div>
      <ol className="flex-1 space-y-1.5 overflow-y-auto">
        {rows.map((r, i) => (
          <li
            key={r.slug}
            className={`relative flex items-center gap-2.5 px-2 py-1.5 rounded-sm hover:bg-muted/50 transition-colors ${
              r.withdrawn ? "opacity-50 grayscale" : ""
            }`}
          >
            <span className="text-[11px] text-muted-foreground tabular-nums w-4">
              {i + 1}
            </span>
            {r.photo ? (
              <img
                src={r.photo}
                alt=""
                className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                style={{ border: `1.5px solid ${r.color}` }}
              />
            ) : (
              <div
                className="w-7 h-7 rounded-full bg-muted flex-shrink-0"
                style={{ border: `1.5px solid ${r.color}` }}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">
                {r.lastName}{" "}
                <span className="text-muted-foreground">({r.party ?? "—"})</span>
                {r.withdrawn && (
                  <span className="ml-1 text-[10px] text-muted-foreground">· out</span>
                )}
              </div>
              <div className="h-1 mt-1 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(r.pct / max) * 100}%`,
                    backgroundColor: r.color,
                  }}
                />
              </div>
            </div>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {r.pct.toFixed(1)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
