import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCommitteeDonors,
  useStateCandidates,
  type CommitteeDonor,
  type TxCandidate,
} from "@/hooks/useCandidates";
import { formatCurrency, formatCurrencyFull, partyColor } from "@/lib/finance";
import { inactiveLabel } from "@/lib/candidateStatus";
import { useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";
import type { StateConfig } from "@/states/registry";

const PAGE = 50;

type SortKey = "total" | "candidates" | "recent" | "name";
const SORTS: { value: SortKey; label: string }[] = [
  { value: "total", label: "Most given" },
  { value: "candidates", label: "Most candidates" },
  { value: "recent", label: "Most recent gift" },
  { value: "name", label: "Name" },
];

/** Search key: case-folded, punctuation-free, so "U.A.W." finds "UAW". */
function fold(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SMALL_WORDS = new Set(["OF", "AND", "THE", "FOR", "IN", "ON", "AT", "TO", "BY", "A", "AN"]);
/** All-caps tokens kept as filed; other 4–5 letter words get title case. */
const ACRONYMS = new Set([
  "PAC", "PACS", "UAW", "IBEW", "SEIU", "AFSCME", "AFL", "CIO", "UFCW", "IUOE", "CWA", "AFT", "NEA",
  "MEA", "LLC", "LLP", "INC", "CORP", "CO", "LP", "USA", "US", "DC", "CMTE", "PLLC", "NFP", "AIPAC",
]);

function titleCase(s: string): string {
  // Filings arrive in shouty caps; soften them for display, keeping
  // acronyms, 2–3 letter tokens and anything with digits or punctuation as
  // filed, and lower-casing the small connecting words.
  return s
    .split(/(\s+)/)
    .map((w, i) => {
      if (SMALL_WORDS.has(w) && i > 0) return w.toLowerCase();
      if (ACRONYMS.has(w.replace(/[.,]/g, ""))) return w;
      if (/^[A-Z]{1,3}$/.test(w) || !/^[A-Z][A-Z'-]+$/.test(w)) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join("");
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Governor" / "State Senate District 11", and the candidate's profile URL. */
function describeCandidate(state: StateConfig, c: TxCandidate): { office: string; href: string } {
  const race = state.races?.find((r) => r.office === c.office);
  const chamber = state.chambers?.find((ch) => ch.office === c.office);
  const office = race
    ? race.title
    : chamber
      ? `${chamber.title}${c.district ? ` District ${c.district}` : ""}`
      : c.office;
  const href = `${statePath(state.code)}/${c.office}${c.district ? `/${c.district}` : ""}/candidates/${c.slug}`;
  return { office, href };
}

export default function Committees() {
  const stateCfg = useStateConfig();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const sort = (params.get("sort") as SortKey | null) ?? "total";
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<CommitteeDonor | null>(null);

  const { data: committees, isLoading, error } = useCommitteeDonors();
  const { data: candidates } = useStateCandidates();
  const candidateById = useMemo(
    () => new Map((candidates ?? []).map((c) => [c.id, c])),
    [candidates],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setShown(PAGE);
  };

  const filtered = useMemo(() => {
    const all = committees ?? [];
    const terms = fold(query).split(" ").filter(Boolean);
    const hits = terms.length
      ? all.filter((c) => {
          const hay = `${c.norm_key} ${fold(c.city)}`;
          return terms.every((t) => hay.includes(t));
        })
      : [...all];
    switch (sort) {
      case "candidates":
        return hits.sort((a, b) => b.candidate_count - a.candidate_count || b.total_amount - a.total_amount);
      case "recent":
        return hits.sort(
          (a, b) =>
            (b.last_contribution_date ?? "").localeCompare(a.last_contribution_date ?? "") ||
            b.total_amount - a.total_amount,
        );
      case "name":
        return hits.sort((a, b) => a.norm_key.localeCompare(b.norm_key));
      default:
        return hits.sort((a, b) => b.total_amount - a.total_amount);
    }
  }, [committees, query, sort]);

  const totals = useMemo(() => {
    const all = committees ?? [];
    return {
      committees: all.length,
      given: all.reduce((s, c) => s + c.total_amount, 0),
      gifts: all.reduce((s, c) => s + c.contribution_count, 0),
    };
  }, [committees]);

  const visible = filtered.slice(0, shown);

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {stateCfg.name} · 2026 cycle
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          Committees &amp; PACs
        </h1>
        <p className="text-base text-muted-foreground max-w-2xl">
          Every political committee, PAC, union, party and business that has given to a tracked{" "}
          {stateCfg.name} candidate, from {stateCfg.agency?.name ?? "state disclosure"} filings. Pick one
          to see which campaigns it funded.
        </p>
      </section>

      <section className="container pb-8">
        <div className="grid grid-cols-3 divide-x rounded-lg border bg-card">
          <Stat label="Committees" value={isLoading ? "…" : totals.committees.toLocaleString()} />
          <Stat label="Given to candidates" value={isLoading ? "…" : formatCurrency(totals.given)} />
          <Stat label="Contributions" value={isLoading ? "…" : totals.gifts.toLocaleString()} />
        </div>
      </section>

      <section className="container pb-16 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setParam("q", e.target.value)}
              placeholder="Search by committee name or city…"
              aria-label="Search committees"
              className="pl-9 pr-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setParam("q", "")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Sort
            <select
              value={sort}
              onChange={(e) => setParam("sort", e.target.value === "total" ? "" : e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!isLoading && !error && (
          <p className="text-xs text-muted-foreground">
            {query
              ? `${filtered.length.toLocaleString()} of ${totals.committees.toLocaleString()} committees match “${query}”`
              : `${totals.committees.toLocaleString()} committees, ranked by ${SORTS.find((s) => s.value === sort)?.label.toLowerCase()}`}
          </p>
        )}

        {isLoading && (
          <div className="text-sm text-muted-foreground py-10 text-center">Loading committees…</div>
        )}
        {error && (
          <div className="text-sm text-destructive py-10 text-center">
            Something went wrong loading committees. Try refreshing.
          </div>
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <div className="text-sm text-muted-foreground py-10 text-center">
            {query ? `No committees match “${query}”.` : "No committee contributions imported yet."}
          </div>
        )}

        {visible.length > 0 && (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-semibold w-12 text-right">#</th>
                  <th className="px-4 py-2.5 font-semibold">Committee</th>
                  <th className="px-4 py-2.5 font-semibold text-right w-28 hidden sm:table-cell">Candidates</th>
                  <th className="px-4 py-2.5 font-semibold text-right w-24 hidden md:table-cell">Gifts</th>
                  <th className="px-4 py-2.5 font-semibold text-right w-32">Total</th>
                  <th className="px-4 py-2.5 font-semibold text-right w-36 hidden lg:table-cell">Last gift</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((c, i) => (
                  <tr
                    key={c.rn}
                    className="hover:bg-accent/50 cursor-pointer"
                    onClick={() => setSelected(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(c);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`${titleCase(c.name)}: breakdown by candidate`}
                  >
                    <td className="px-4 py-3 text-right font-display text-muted-foreground/70 tabular-nums">
                      {i + 1}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold leading-tight">{titleCase(c.name)}</div>
                      {(c.city || c.contributor_state) && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {[c.city ? titleCase(c.city) : null, c.contributor_state].filter(Boolean).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums hidden sm:table-cell">{c.candidate_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums hidden md:table-cell">{c.contribution_count}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">
                      {formatCurrencyFull(c.total_amount)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground tabular-nums hidden lg:table-cell">
                      {fmtDate(c.last_contribution_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {filtered.length > shown && (
          <div className="text-center">
            <Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more of {(filtered.length - shown).toLocaleString()}
            </Button>
          </div>
        )}
      </section>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display leading-tight">
              {selected ? titleCase(selected.name) : ""}
            </DialogTitle>
            <DialogDescription>
              {selected
                ? [
                    selected.city ? titleCase(selected.city) : null,
                    selected.contributor_state,
                  ]
                    .filter(Boolean)
                    .join(", ") || "Location not filed"
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {formatCurrencyFull(selected.total_amount)}
                  </div>
                  <div className="text-xs text-muted-foreground">Total given</div>
                </Card>
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {selected.candidate_count} candidate{selected.candidate_count === 1 ? "" : "s"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selected.contribution_count} contribution{selected.contribution_count === 1 ? "" : "s"}
                    {selected.first_contribution_date
                      ? ` · ${fmtDate(selected.first_contribution_date)} – ${fmtDate(selected.last_contribution_date)}`
                      : ""}
                  </div>
                </Card>
              </div>

              <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
                <h3 className="text-xs font-medium text-muted-foreground pt-2">Breakdown by candidate</h3>
                {selected.splits.map((s) => {
                  const cand = candidateById.get(s.candidate_id);
                  const meta = cand ? describeCandidate(stateCfg, cand) : null;
                  const out = cand ? inactiveLabel(cand.status) : null;
                  const row = (
                    <Card
                      className={`p-3 hover:border-primary/40 transition-colors ${out ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="text-[11px] font-semibold px-1.5 py-0.5 rounded-sm shrink-0"
                          style={{ backgroundColor: partyColor(cand?.party), color: "white" }}
                        >
                          {cand?.party ?? "—"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">
                            {cand?.name ?? "Candidate no longer tracked"}
                            {out && <span className="ml-2 text-[10px] font-normal text-muted-foreground">{out}</span>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {meta?.office ?? ""}
                            {meta?.office ? " · " : ""}
                            {s.contribution_count} gift{s.contribution_count === 1 ? "" : "s"}
                            {s.last_contribution_date ? ` · last ${fmtDate(s.last_contribution_date)}` : ""}
                          </div>
                        </div>
                        <div className="font-mono font-semibold text-sm shrink-0 tabular-nums">
                          {formatCurrencyFull(s.total_amount)}
                        </div>
                      </div>
                    </Card>
                  );
                  return meta ? (
                    <Link key={s.candidate_id} to={meta.href} onClick={() => setSelected(null)}>
                      {row}
                    </Link>
                  ) : (
                    <div key={s.candidate_id}>{row}</div>
                  );
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-4 md:px-6 text-center">
      <div className="font-display text-2xl md:text-3xl font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
