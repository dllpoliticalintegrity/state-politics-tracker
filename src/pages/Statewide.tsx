import { Link } from "react-router-dom";
import { useCandidates, useCandidateTotals, type TxCandidate } from "@/hooks/useCandidates";
import { formatCurrency, officeLabel, partyColor, partyLabel } from "@/lib/finance";

const RACES = ["LTGOVERNOR", "ATTYGEN"] as const;

function statusTag(status: string | null): string | null {
  const s = (status ?? "").toLowerCase();
  if (s === "withdrawn" || s === "dropped_out" || s === "dropped out") return "Withdrew";
  if (s === "eliminated") return "Lost Primary";
  return null;
}

export default function Statewide() {
  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Down-ballot in 2026
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          Statewide races
        </h1>
        <p className="text-base text-muted-foreground max-w-2xl">
          Campaign finance for the other statewide executive races, from the same nightly
          Texas Ethics Commission sync. Select a candidate for donors, spending, and filings.
        </p>
      </section>

      {RACES.map((office) => (
        <RaceSection key={office} office={office} />
      ))}
      <div className="pb-10" />
    </div>
  );
}

function RaceSection({ office }: { office: string }) {
  const { data: candidates, isLoading } = useCandidates(office);
  const { data: totalsMap } = useCandidateTotals();

  const rows = (candidates ?? [])
    .map((c) => ({ c, raised: totalsMap?.get(c.id)?.raised ?? 0 }))
    .sort((a, b) => {
      const aOut = statusTag(a.c.status) ? 1 : 0;
      const bOut = statusTag(b.c.status) ? 1 : 0;
      return aOut - bOut || b.raised - a.raised;
    });

  return (
    <section className="container pb-8 space-y-3">
      <div className="flex items-baseline justify-between border-b pb-2">
        <h2 className="font-display text-xl md:text-2xl font-semibold">{officeLabel(office)}</h2>
        <span className="text-xs text-muted-foreground">General: Nov 3, 2026</span>
      </div>
      {isLoading && <div className="p-8 text-sm text-muted-foreground">Loading…</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map(({ c, raised }) => (
          <StatewideCard key={c.slug} candidate={c} raised={raised} />
        ))}
      </div>
    </section>
  );
}

function StatewideCard({ candidate: c, raised }: { candidate: TxCandidate; raised: number }) {
  const tag = statusTag(c.status);
  const pColor = partyColor(c.party);
  const initials = c.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <Link to={`/candidates/${c.slug}`} className="block">
      <div
        className={`relative overflow-hidden rounded-lg border bg-card p-4 transition-all hover:-translate-y-0.5 hover:shadow-sm ${
          tag ? "opacity-60 grayscale" : ""
        }`}
      >
        <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ backgroundColor: pColor }} />
        <div className="flex items-center gap-3">
          <div
            className="h-12 w-12 rounded-full overflow-hidden border shrink-0 flex items-center justify-center bg-muted text-sm"
            style={{ borderColor: pColor }}
          >
            {c.photo_url_thumb || c.photo_url ? (
              <img
                src={c.photo_url_thumb ?? c.photo_url ?? undefined}
                alt={c.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate flex items-center gap-2">
              {c.name}
              {tag && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground border">
                  {tag}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {partyLabel(c.party)}
              {c.title ? ` · ${c.title}` : ""}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[11px] text-muted-foreground">Raised</div>
            <div className="font-mono font-semibold tabular-nums">
              {formatCurrency(raised)}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
