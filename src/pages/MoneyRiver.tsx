import { useEffect, useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import MoneyTabs from "@/components/MoneyTabs";
import { useCandidates } from "@/hooks/useCandidates";
import { useMoneyRiver } from "@/hooks/useMoneyRiver";
import {
  RIVER_KINDS,
  RIVER_KIND_LABEL,
  RIVER_PAGE_SIZE,
  describeRiverRow,
  pageWindow,
  parseRiverParams,
  riverParamsToSearch,
  type RiverFilters,
  type RiverKind,
  type RiverRow,
} from "@/lib/moneyRiver";
import { formatCurrencyFull, partyColor } from "@/lib/finance";
import { offBallotLast } from "@/lib/candidateStatus";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";

const KIND_OPTIONS: { value: RiverKind | "all"; label: string }[] = [
  { value: "all", label: "Everything" },
  ...RIVER_KINDS.map((k) => ({ value: k, label: RIVER_KIND_LABEL[k] + "s" })),
];

const KIND_PILL: Record<RiverKind, string> = {
  contribution: "bg-success/15 text-success",
  expenditure: "bg-muted text-muted-foreground",
  outside: "bg-primary/10 text-primary",
  loan: "bg-warning/15 text-warning",
};

export default function MoneyRiver() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const raceBase = useRaceBase();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseRiverParams(searchParams), [searchParams]);
  const { data, isLoading, isFetching, error } = useMoneyRiver(filters);
  const { data: candidates } = useCandidates();

  const update = (patch: Partial<RiverFilters>) => {
    // Any filter change restarts at page 1; only an explicit page change keeps it.
    const next: RiverFilters = { ...filters, page: 1, ...patch };
    setSearchParams(riverParamsToSearch(next), { replace: !("page" in patch) });
  };

  const candidateOptions = [...(candidates ?? [])].sort(
    (a, b) => offBallotLast(a, b) || a.name.localeCompare(b.name),
  );
  // A candidate from another race can linger in a shared URL.
  useEffect(() => {
    if (filters.candidate && candidates && !candidates.some((c) => c.id === filters.candidate)) {
      update({ candidate: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.candidate, candidates]);

  const total = data?.total ?? 0;
  const win = pageWindow(filters.page, RIVER_PAGE_SIZE, total);
  const agency = stateCfg.agency?.name ?? "the state's disclosure agency";

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`Money in the ${race.generalDate.slice(0, 4)} ${stateCfg.name} ${race.title}'s race`}
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">River</h1>
        <p className="text-base text-muted-foreground max-w-2xl">
          Every itemized contribution, campaign expenditure, loan and outside expenditure the {agency}{" "}
          has on file for this race's candidates, newest first. Filter by type or candidate; the URL
          carries your filters so a view can be shared.
        </p>
      </section>

      <section className="container pb-6">
        <MoneyTabs />
      </section>

      <section className="container pb-4 space-y-2">
        <FilterRow label="Type">
          {KIND_OPTIONS.map((opt) => (
            <Pill key={opt.value} active={filters.kind === opt.value} onClick={() => update({ kind: opt.value })}>
              {opt.label}
            </Pill>
          ))}
        </FilterRow>
        <FilterRow label="Who">
          <select
            aria-label="Candidate"
            value={filters.candidate}
            onChange={(e) => update({ candidate: e.target.value })}
            className="text-xs h-7 px-2 rounded-md border bg-background text-foreground max-w-[18rem]"
          >
            <option value="">All candidates</option>
            {candidateOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FilterRow>
      </section>

      <section className="container pb-10 space-y-3">
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {isLoading
              ? "Loading…"
              : total === 0
                ? "No rows match these filters."
                : `Showing ${win.from.toLocaleString()}–${win.to.toLocaleString()} of ${total.toLocaleString()}`}
            {isFetching && !isLoading ? " · updating" : ""}
          </span>
          <span className="text-right">Source: {agency}, synced nightly</span>
        </div>

        {error && (
          <p className="text-sm text-destructive">Could not load the river: {(error as Error).message}</p>
        )}

        <div className="rounded-lg border bg-card divide-y">
          {isLoading && <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>}
          {(data?.rows ?? []).map((row) => (
            <RiverLine key={`${row.kind}-${row.id}`} row={row} raceBase={raceBase} />
          ))}
        </div>

        {total > RIVER_PAGE_SIZE && (
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm">
            <button
              type="button"
              disabled={win.current <= 1}
              onClick={() => update({ page: win.current - 1 })}
              className="inline-flex items-center gap-1 px-3 h-8 rounded-md border disabled:opacity-40 hover:bg-accent"
            >
              <ChevronLeft className="h-4 w-4" /> Newer
            </button>
            <span className="text-xs text-muted-foreground">
              Page {win.current.toLocaleString()} of {win.pages.toLocaleString()}
            </span>
            <button
              type="button"
              disabled={win.current >= win.pages}
              onClick={() => update({ page: win.current + 1 })}
              className="inline-flex items-center gap-1 px-3 h-8 rounded-md border disabled:opacity-40 hover:bg-accent"
            >
              Older <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground w-12">{label}</span>
      {children}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
        active ? "border-primary text-primary bg-primary/10 font-semibold" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function RiverLine({ row, raceBase }: { row: RiverRow; raceBase: string }) {
  const { subject, verb, object } = describeRiverRow(row);
  const candidateLink = (
    <Link to={`${raceBase}/candidates/${row.candidate_slug}`} className="font-semibold hover:underline underline-offset-4">
      {row.candidate_name}
    </Link>
  );
  const sentence =
    row.kind === "expenditure" ? (
      <>
        {candidateLink} <span className="text-muted-foreground">{verb}</span> <span className="font-semibold">{object}</span>
      </>
    ) : (
      <>
        <span className="font-semibold">{subject}</span> <span className="text-muted-foreground">{verb}</span> {candidateLink}
      </>
    );

  return (
    <div className="grid grid-cols-[3px_1fr_auto] gap-x-3 px-3 py-2.5">
      <div className="rounded-sm" style={{ backgroundColor: partyColor(row.candidate_party) }} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm leading-snug">{sentence}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className={`px-1.5 py-px rounded-sm font-semibold uppercase tracking-wide ${KIND_PILL[row.kind]}`}>
            {RIVER_KIND_LABEL[row.kind]}
          </span>
          {row.detail && <span className="truncate max-w-[32rem]">{row.detail}</span>}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono font-semibold text-sm tabular-nums">{formatCurrencyFull(row.amount)}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums">{formatDate(row.txn_date)}</div>
      </div>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "date not filed";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
