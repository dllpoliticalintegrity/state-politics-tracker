import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Building2 } from "lucide-react";
import MoneyTabs from "@/components/MoneyTabs";
import {
  useCandidates,
  useTopAggregatedDonors,
  useTopIeAggregatedDonors,
  type TxCrossCandidateDonor,
  type TxIeCrossCommitteeDonor,
  type DonorKind,
} from "@/hooks/useCandidates";
import {
  contributorTypeLabel,
  formatCurrency,
  formatCurrencyFull,
  partyColor,
} from "@/lib/finance";

type Source = "candidate" | "ie";

type UnifiedDonor = {
  key: string;
  display_name: string;
  contributor_type: string | null;
  employer: string | null;
  occupation: string | null;
  city: string | null;
  state: string | null;
  contribution_count: number;
  total_amount: number;
  split_count: number;
};

const KIND_OPTIONS: { value: DonorKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "individual", label: "Individuals" },
  { value: "pac", label: "PACs & committees" },
];

const SOURCE_OPTIONS: { value: Source; label: string }[] = [
  { value: "candidate", label: "To candidate campaigns" },
  { value: "ie", label: "To outside committees" },
];

export default function TopDonors() {
  const [source, setSource] = useState<Source>("candidate");
  const [kind, setKind] = useState<DonorKind>("all");
  const [selectedCand, setSelectedCand] = useState<TxCrossCandidateDonor | null>(null);
  const [selectedIe, setSelectedIe] = useState<TxIeCrossCommitteeDonor | null>(null);

  const { data: candidates } = useCandidates();
  const candDonors = useTopAggregatedDonors(50, kind);
  const ieDonors = useTopIeAggregatedDonors(50, kind);

  const candidateById = useMemo(
    () => new Map((candidates ?? []).map((c) => [c.id, c])),
    [candidates],
  );

  const active = source === "candidate" ? candDonors : ieDonors;
  const list: UnifiedDonor[] = useMemo(() => {
    if (source === "candidate") {
      return (candDonors.data ?? []).map((d) => ({
        key: d.key,
        display_name: d.display_name,
        contributor_type: d.contributor_type,
        employer: d.employer,
        occupation: d.occupation,
        city: d.city,
        state: d.state,
        contribution_count: d.contribution_count,
        total_amount: d.total_amount,
        split_count: d.splits.length,
      }));
    }
    return (ieDonors.data ?? []).map((d) => ({
      key: d.key,
      display_name: d.display_name,
      contributor_type: d.contributor_type,
      employer: d.employer,
      occupation: d.occupation,
      city: d.city,
      state: d.state,
      contribution_count: d.contribution_count,
      total_amount: d.total_amount,
      split_count: d.splits.length,
    }));
  }, [source, candDonors.data, ieDonors.data]);

  const totalGiven = list.reduce((s, d) => s + d.total_amount, 0);
  const totalContributions = list.reduce((s, d) => s + d.contribution_count, 0);
  const multiSplitDonors = list.filter((d) => d.split_count > 1).length;

  const splitLabel = source === "candidate" ? "candidates" : "committees";

  const handleSelect = (key: string) => {
    if (source === "candidate") {
      const hit = (candDonors.data ?? []).find((d) => d.key === key) ?? null;
      setSelectedCand(hit);
    } else {
      const hit = (ieDonors.data ?? []).find((d) => d.key === key) ?? null;
      setSelectedIe(hit);
    }
  };

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 pb-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Money in the 2026 Texas Governor's race
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">Top donors</h1>
        <p className="text-base text-muted-foreground max-w-2xl">
          Donors ranked by total dollars given. Switch between money into candidate campaigns
          and money into the outside committees spending for or against them. Select a row for
          the full breakdown.
        </p>
      </section>

      <section className="container pb-6">
        <MoneyTabs />
      </section>

      <section className="container pb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground w-12">Source</span>
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSource(opt.value)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                source === opt.value
                  ? "border-primary text-primary bg-primary/10 font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground w-12">Type</span>
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setKind(opt.value)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                kind === opt.value
                  ? "border-primary text-primary bg-primary/10 font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="container pb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x rounded-lg border bg-card">
          <MoneyStat value={formatCurrency(totalGiven)} label="Given by the top 50" />
          <MoneyStat value={totalContributions.toLocaleString()} label="Contributions" />
          <MoneyStat value={String(multiSplitDonors)} label={`Donors giving to 2+ ${splitLabel}`} />
        </div>
      </section>

      <section className="container pb-16 space-y-3">
        <h2 className="font-display text-xl font-semibold">
          {source === "candidate" ? "Top 50 donors to campaigns" : "Top 50 donors to outside committees"}
        </h2>
        {active.isLoading && (
          <div className="text-sm text-muted-foreground py-6 text-center">Loading donors…</div>
        )}
        {active.error && (
          <div className="text-sm text-destructive py-6 text-center">
            Something went wrong loading donor data. Try refreshing.
          </div>
        )}
        {!active.isLoading && !active.error && list.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No donors found for this filter.
          </div>
        )}
        <div className="space-y-2">
          {list.map((d, i) => (
            <button
              key={d.key}
              type="button"
              onClick={() => handleSelect(d.key)}
              className="block w-full text-left"
            >
              <Card className="p-4 hover:border-primary/40 transition-colors group">
                <div className="flex items-center gap-4">
                  <div className="text-xs text-muted-foreground tabular-nums w-8 shrink-0">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                      {d.display_name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {contributorTypeLabel(d.contributor_type)}
                      {d.employer ? ` · ${d.employer}` : ""}
                      {d.city ? ` · ${d.city}${d.state ? ", " + d.state : ""}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-semibold text-sm tabular-nums">
                      {formatCurrencyFull(d.total_amount)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {d.contribution_count} gift{d.contribution_count === 1 ? "" : "s"} ·{" "}
                      {d.split_count}{" "}
                      {source === "candidate"
                        ? `candidate${d.split_count === 1 ? "" : "s"}`
                        : `committee${d.split_count === 1 ? "" : "s"}`}
                    </div>
                  </div>
                </div>
              </Card>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-2">
          Updated nightly from Texas Ethics Commission filings.
        </p>
      </section>

      {/* Candidate-donor breakdown */}
      <Dialog open={!!selectedCand} onOpenChange={(o) => !o && setSelectedCand(null)}>
        <DialogContent className="w-[95vw] max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              {selectedCand?.display_name}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selectedCand && contributorTypeLabel(selectedCand.contributor_type)}
              {selectedCand?.employer ? ` · ${selectedCand.employer}` : ""}
              {selectedCand?.occupation ? ` · ${selectedCand.occupation}` : ""}
              {selectedCand?.city
                ? ` · ${selectedCand.city}${selectedCand.state ? ", " + selectedCand.state : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedCand && (
            <>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {formatCurrencyFull(selectedCand.total_amount)}
                  </div>
                  <div className="text-xs text-muted-foreground">Total given</div>
                </Card>
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {selectedCand.splits.length} candidate
                    {selectedCand.splits.length === 1 ? "" : "s"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedCand.contribution_count} contribution
                    {selectedCand.contribution_count === 1 ? "" : "s"}
                  </div>
                </Card>
              </div>

              <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
                <h3 className="text-xs font-medium text-muted-foreground pt-2">
                  Breakdown by candidate
                </h3>
                {selectedCand.splits.map((s) => {
                  const cand = candidateById.get(s.candidate_id);
                  const row = (
                    <Card className="p-3 hover:border-primary/40 transition-colors">
                      <div className="flex items-center gap-3">
                        <span
                          className="text-[11px] font-semibold px-1.5 py-0.5 rounded-sm shrink-0"
                          style={{
                            backgroundColor: partyColor(cand?.party),
                            color: "white",
                          }}
                        >
                          {cand?.party ?? "—"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">
                            {cand?.name ?? "Unknown candidate"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {s.contribution_count} gift{s.contribution_count === 1 ? "" : "s"}
                            {s.last_contribution_date
                              ? ` · last ${s.last_contribution_date}`
                              : ""}
                          </div>
                        </div>
                        <div className="font-mono font-semibold text-sm shrink-0 tabular-nums">
                          {formatCurrencyFull(s.total_amount)}
                        </div>
                      </div>
                    </Card>
                  );
                  return cand?.slug ? (
                    <Link
                      key={s.candidate_id}
                      to={`/candidates/${cand.slug}`}
                      onClick={() => setSelectedCand(null)}
                    >
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

      {/* IE-donor breakdown */}
      <Dialog open={!!selectedIe} onOpenChange={(o) => !o && setSelectedIe(null)}>
        <DialogContent className="w-[95vw] max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              {selectedIe?.display_name}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selectedIe && contributorTypeLabel(selectedIe.contributor_type)}
              {selectedIe?.employer ? ` · ${selectedIe.employer}` : ""}
              {selectedIe?.occupation ? ` · ${selectedIe.occupation}` : ""}
              {selectedIe?.city
                ? ` · ${selectedIe.city}${selectedIe.state ? ", " + selectedIe.state : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedIe && (
            <>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {formatCurrencyFull(selectedIe.total_amount)}
                  </div>
                  <div className="text-xs text-muted-foreground">Total given</div>
                </Card>
                <Card className="p-3">
                  <div className="font-mono font-semibold text-lg tabular-nums">
                    {selectedIe.splits.length} committee
                    {selectedIe.splits.length === 1 ? "" : "s"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedIe.contribution_count} contribution
                    {selectedIe.contribution_count === 1 ? "" : "s"}
                  </div>
                </Card>
              </div>

              <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
                <h3 className="text-xs font-medium text-muted-foreground pt-2">
                  Breakdown by committee
                </h3>
                {selectedIe.splits.map((s) => (
                  <Card key={s.ie_filer_ident} className="p-3">
                    <div className="flex items-center gap-3">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate">{s.committee_name}</div>
                        <div className="text-xs text-muted-foreground">
                          Filer {s.ie_filer_ident} · {s.contribution_count} gift
                          {s.contribution_count === 1 ? "" : "s"}
                          {s.last_contribution_date ? ` · last ${s.last_contribution_date}` : ""}
                        </div>
                      </div>
                      <div className="font-mono font-semibold text-sm shrink-0 tabular-nums">
                        {formatCurrencyFull(s.total_amount)}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MoneyStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-4 py-4 md:px-6">
      <div className="font-mono font-semibold text-xl tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
