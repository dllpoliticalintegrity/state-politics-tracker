import { useParams, Link, Navigate } from "react-router-dom";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import {
  useCandidate,
  useContributionsSummary,
  useTopDonors,
  useTopIndustries,
  useExpenditureTotals,
  useIEForCandidate,
  useIEByCandidate,
  useCandidateLoans,
} from "@/hooks/useCandidates";
import { useTxGovPolling, readCandidatePct } from "@/hooks/usePolling";
import CandidatePollingChart from "@/components/CandidatePollingChart";
import {
  formatCurrency,
  formatCurrencyFull,
  partyColor,
  partyLabel,
  contributorTypeLabel,
} from "@/lib/finance";

export default function CandidateDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { data: candidate, isLoading: candLoading, error: candError } = useCandidate(slug);
  const { data: summaries } = useContributionsSummary(candidate?.id);
  const { data: topIndividualDonors } = useTopDonors(candidate?.id, 10, "individual");
  const { data: topPacDonors } = useTopDonors(candidate?.id, 500, "pac");
  const [pacPage, setPacPage] = useState(0);
  const PAC_PAGE_SIZE = 10;
  const { data: topIndustries } = useTopIndustries(candidate?.id, 10);
  const { data: loans } = useCandidateLoans(candidate?.id, candidate?.name, 10);
  const { data: expn } = useExpenditureTotals(candidate?.id);
  const { data: ieRows } = useIEForCandidate(candidate?.id, 10);
  const { data: ieByCand } = useIEByCandidate();
  const { data: polling } = useTxGovPolling();

  if (candLoading) {
    return (
      <div className="container py-20 text-sm text-muted-foreground text-center">
        Loading candidate…
      </div>
    );
  }
  if (candError || !candidate) return <Navigate to="/candidates" replace />;

  // Aggregate across cycles
  const totals = (summaries ?? []).reduce(
    (acc, s) => {
      acc.totalRaised += Number(s.total_raised ?? 0);
      acc.individual += Number(s.individual_contributions ?? 0);
      acc.pac += Number(s.entity_contributions ?? 0);
      acc.smallDollar += Number(s.small_dollar_contributions ?? 0);
      acc.smallDollarCount += Number(s.small_dollar_count ?? 0);
      acc.individualCount += Number(s.individual_donor_count ?? 0);
      acc.asOf = [acc.asOf, s.as_of].sort().reverse()[0] ?? null;
      return acc;
    },
    {
      totalRaised: 0,
      individual: 0,
      pac: 0,
      smallDollar: 0,
      smallDollarCount: 0,
      individualCount: 0,
      asOf: null as string | null,
    },
  );

  const totalSpent = expn?.totalSpent ?? 0;
  const ieForThis = (ieByCand ?? []).find((r) => r.candidate_id === candidate.id);
  const ieSupporting = Number(ieForThis?.total_supporting ?? 0);
  const ieOpposing = Number(ieForThis?.total_opposing ?? 0);

  const hasFinanceData = totals.totalRaised > 0 || totalSpent > 0;

  // Names that appear in loans — filtered out of the individual donors list
  // so that loans (Schedule B) and outright gifts (Schedule A) don't
  // double-count for self-funders / lenders.
  const loanNameKeys = new Set(
    (loans ?? []).map(
      (l) =>
        `${(l.contributor_last_name ?? "").trim().toUpperCase()}|${(l.contributor_first_name ?? "").trim().toUpperCase()}`,
    ),
  );
  const individualDonorsFiltered = (topIndividualDonors ?? []).filter((d) => {
    const key = `${(d.contributor_last_name ?? "").trim().toUpperCase()}|${(d.contributor_first_name ?? "").trim().toUpperCase()}`;
    return !loanNameKeys.has(key);
  });
  const totalLoans = (loans ?? []).reduce((s, l) => s + l.total_amount, 0);

  // Self-funded portion (excludes Schedule B "loan" rows so we don't subtract
  // loan principal from the individual-donor bar — loans aren't in the
  // individual_contributions sum to begin with).
  const selfFundedFromIndividuals = (loans ?? [])
    .filter((l) => l.source === "self")
    .reduce((s, l) => s + l.total_amount, 0);

  // Strip self-funding out of "individual contributions" so the bar reflects
  // money raised from other people.
  const individualExSelf = Math.max(0, totals.individual - selfFundedFromIndividuals);

  const indPct =
    totals.totalRaised > 0
      ? Math.round((individualExSelf / totals.totalRaised) * 100)
      : 0;
  const pacPct =
    totals.totalRaised > 0 ? Math.round((totals.pac / totals.totalRaised) * 100) : 0;
  const smallDollarPct =
    totals.totalRaised > 0
      ? Math.round((totals.smallDollar / totals.totalRaised) * 100)
      : 0;

  return (
    <div className="min-h-[80vh]">
      <div className="container py-8 space-y-6">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/candidates" className="hover:text-foreground">
            Candidates
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground">{candidate.name}</span>
        </nav>

        {/* Header card */}
        <Card className="p-6">
          <div className="flex flex-col md:flex-row md:items-start gap-6">
            {candidate.photo_url ? (
              <img
                src={candidate.photo_url_large ?? candidate.photo_url}
                alt={candidate.name}
                className="w-28 h-28 md:w-32 md:h-32 rounded-full object-cover shrink-0 border-[3px]"
                style={{ borderColor: partyColor(candidate.party) }}
              />
            ) : (
              <div
                className="w-28 h-28 md:w-32 md:h-32 rounded-full flex items-center justify-center font-display text-3xl shrink-0 border-[3px] bg-muted"
                style={{ borderColor: partyColor(candidate.party) }}
              >
                {candidate.name
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((p) => p[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
            )}
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[11px] font-semibold px-1.5 py-0.5 rounded-sm"
                  style={{ backgroundColor: partyColor(candidate.party), color: "white" }}
                >
                  {candidate.party ?? "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {partyLabel(candidate.party)}
                </span>
                {(candidate.status === "withdrawn" ||
                  candidate.status === "dropped_out") && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground border">
                    Withdrawn
                  </span>
                )}
              </div>
              <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
                {candidate.name}
              </h1>
              {candidate.title && (
                <p className="text-sm text-muted-foreground">{candidate.title}</p>
              )}
              {candidate.committee_name && (
                <p className="text-xs text-muted-foreground">
                  Committee: {candidate.committee_name}
                </p>
              )}
              {candidate.bio && (
                <p className="text-sm text-muted-foreground max-w-2xl pt-2">{candidate.bio}</p>
              )}
            </div>
            <div className="flex gap-4 md:gap-6">
              {(() => {
                const pct = readCandidatePct(polling?.average, candidate.name);
                return <Stat label="Poll average" value={pct !== null ? `${pct}%` : "—"} />;
              })()}
              <Stat label="Raised" value={formatCurrency(totals.totalRaised)} />
            </div>
          </div>
          {totals.asOf && (
            <div className="text-xs text-muted-foreground mt-4">
              Data as of {new Date(totals.asOf).toLocaleDateString()}
            </div>
          )}
        </Card>

        {/* Per-candidate polling trajectory (governor race only — the polls
            feed tracks the top-of-ticket matchup) */}
        {candidate.office === "GOVERNOR" && (
        <Card className="p-6">
          <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-display text-xl font-semibold">Polling history</h2>
            <span className="text-xs text-muted-foreground">Source: 270toWin aggregate</span>
          </div>
          <CandidatePollingChart
            candidate={{ slug: candidate.slug, name: candidate.name, party: candidate.party }}
          />
        </Card>
        )}

        {!hasFinanceData && (
          <Card className="p-8 border-dashed">
            <p className="text-sm text-muted-foreground text-center">
              No filings yet for this candidate. Data will appear after the next TEC sync.
            </p>
          </Card>
        )}

        {hasFinanceData && (
          <>
            {/* Finance overview */}
            <div className="grid grid-cols-2 gap-3">
              <FinanceStat label="Total raised" value={formatCurrency(totals.totalRaised)} />
              <FinanceStat
                label="Small donors"
                value={`${smallDollarPct}%`}
                sub={`${totals.smallDollarCount.toLocaleString()} gifts under $200`}
              />
            </div>

            {/* Funding source breakdown */}
            <Card className="p-6 space-y-4">
              <h2 className="font-display text-xl font-semibold">Where the money comes from</h2>
              <div className="space-y-3">
                <SourceBar
                  label="Individual contributions"
                  value={individualExSelf}
                  pct={indPct}
                  color="hsl(var(--chart-5))"
                />
                <SourceBar
                  label="Entity contributions (PACs, firms)"
                  value={totals.pac}
                  pct={pacPct}
                  color="hsl(var(--chart-3))"
                />
                {totalLoans > 0 && (
                  <SourceBar
                    label="Self-funded & loans"
                    value={totalLoans}
                    pct={
                      totals.totalRaised > 0
                        ? Math.round((totalLoans / totals.totalRaised) * 100)
                        : 0
                    }
                    color="hsl(var(--chart-2))"
                  />
                )}
              </div>
            </Card>
          </>
        )}

        {/* Outside spending banner */}
        {(ieSupporting > 0 || ieOpposing > 0) && (
          <Card className="p-6">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="font-display text-xl font-semibold">Outside spending</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Independent expenditures by committees targeting this candidate.
                </p>
              </div>
              <div className="flex gap-6">
                <div className="text-right">
                  <div className="font-mono font-semibold text-xl tabular-nums text-success">
                    {formatCurrency(ieSupporting)}
                  </div>
                  <div className="text-xs text-muted-foreground">Supporting</div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-semibold text-xl tabular-nums text-destructive">
                    {formatCurrency(ieOpposing)}
                  </div>
                  <div className="text-xs text-muted-foreground">Opposing</div>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <Link
                to="/money/outside-spending"
                className="text-sm text-primary hover:underline"
              >
                All outside spending in the race →
              </Link>
            </div>
          </Card>
        )}

        {/* Top donors / PACs / employers */}
        {hasFinanceData && (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            <Card className="p-4 md:p-6">
              <h2 className="font-display text-lg font-semibold mb-4">Top individual donors</h2>
              <div className="space-y-2">
                {individualDonorsFiltered.length === 0 && (
                  <div className="text-sm text-muted-foreground">
                    No individual donor data yet.
                  </div>
                )}
                {individualDonorsFiltered.map((d, i) => (
                  <div
                    key={`ind-${d.contributor_last_name ?? ""}|${d.contributor_first_name ?? ""}|${i}`}
                    className="flex items-center justify-between text-sm border-b border-border/60 pb-2 last:border-0 gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">
                        {[d.contributor_first_name, d.contributor_last_name]
                          .filter(Boolean)
                          .join(" ") || "—"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {d.employer ?? d.occupation ?? "—"}
                        {d.contribution_count > 1 ? ` · ${d.contribution_count} gifts` : ""}
                      </div>
                    </div>
                    <div className="font-mono font-semibold shrink-0 text-xs md:text-sm tabular-nums">
                      {formatCurrencyFull(Number(d.total_amount))}
                    </div>
                  </div>
                ))}
                {loans && loans.length > 0 && (
                  <div className="text-xs text-muted-foreground pt-1">
                    Loans listed separately →
                  </div>
                )}
              </div>
            </Card>
            <Card className="p-4 md:p-6">
              <h2 className="font-display text-lg font-semibold mb-4 flex items-baseline">
                Top PAC & committee donors
                <span className="ml-auto text-xs font-sans font-normal text-muted-foreground tabular-nums">
                  {(topPacDonors ?? []).length} total
                </span>
              </h2>
              <div className="space-y-2">
                {(topPacDonors ?? []).length === 0 && (
                  <div className="text-sm text-muted-foreground">No PAC contributions yet.</div>
                )}
                {(topPacDonors ?? [])
                  .slice(pacPage * PAC_PAGE_SIZE, (pacPage + 1) * PAC_PAGE_SIZE)
                  .map((d, i) => (
                  <div
                    key={`pac-${d.contributor_last_name ?? ""}|${d.contributor_first_name ?? ""}|${i}`}
                    className="flex items-center justify-between text-sm border-b border-border/60 pb-2 last:border-0 gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">
                        {[d.contributor_first_name, d.contributor_last_name]
                          .filter(Boolean)
                          .join(" ") || "—"}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {contributorTypeLabel(d.contributor_type)}
                        {d.contribution_count > 1 ? ` · ${d.contribution_count} gifts` : ""}
                      </div>
                    </div>
                    <div className="font-mono font-semibold shrink-0 text-xs md:text-sm tabular-nums">
                      {formatCurrencyFull(Number(d.total_amount))}
                    </div>
                  </div>
                ))}
              </div>
              {(topPacDonors ?? []).length > PAC_PAGE_SIZE && (
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/60">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    disabled={pacPage === 0}
                    onClick={() => setPacPage((p) => Math.max(0, p - 1))}
                  >
                    ← Previous
                  </Button>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Page {pacPage + 1} of{" "}
                    {Math.max(1, Math.ceil((topPacDonors ?? []).length / PAC_PAGE_SIZE))}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    disabled={(pacPage + 1) * PAC_PAGE_SIZE >= (topPacDonors ?? []).length}
                    onClick={() => setPacPage((p) => p + 1)}
                  >
                    Next →
                  </Button>
                </div>
              )}
            </Card>
            <Card className="p-4 md:p-6">
              <h2 className="font-display text-lg font-semibold mb-4">Top employers</h2>
              <div className="space-y-2">
                {(topIndustries ?? []).length === 0 && (
                  <div className="text-sm text-muted-foreground">No employer data yet.</div>
                )}
                {(topIndustries ?? []).map((d, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm border-b border-border/60 pb-2 last:border-0 gap-2"
                  >
                    <div className="font-medium truncate">{d.name}</div>
                    <div className="font-mono font-semibold shrink-0 text-xs md:text-sm tabular-nums">
                      {formatCurrency(d.amount)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            {loans && loans.length > 0 && (
              <Card className="p-4 md:p-6">
                <h2 className="font-display text-lg font-semibold mb-4 flex items-baseline">
                  Self-funding & loans
                  <span className="ml-auto text-xs font-sans font-normal text-muted-foreground tabular-nums">
                    {formatCurrencyFull(totalLoans)}
                  </span>
                </h2>
                <div className="space-y-2">
                  {loans.map((l, i) => (
                    <div
                      key={`loan-${l.contributor_last_name ?? ""}|${l.contributor_first_name ?? ""}|${i}`}
                      className="flex items-center justify-between text-sm border-b border-border/60 pb-2 last:border-0 gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">
                          {[l.contributor_first_name, l.contributor_last_name]
                            .filter(Boolean)
                            .join(" ") || "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {l.source === "loan" ? "Loan" : "Self-funded"}
                          {l.contribution_count > 1
                            ? ` · ${l.contribution_count} ${l.source === "loan" ? "loans" : "gifts"}`
                            : ""}
                        </div>
                      </div>
                      <div className="font-mono font-semibold shrink-0 text-xs md:text-sm tabular-nums">
                        {formatCurrencyFull(Number(l.total_amount))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border/60">
                  Schedule B loans plus candidate self-contributions
                </div>
              </Card>
            )}
          </div>
        )}

        {/* Recent IE transactions */}
        {ieRows && ieRows.length > 0 && (
          <Card className="p-6">
            <h2 className="font-display text-lg font-semibold mb-4">
              Recent outside spending
            </h2>
            <div className="space-y-2">
              {ieRows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between text-sm border-b border-border/60 pb-2 last:border-0 gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{r.committee_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.expenditure_date ? new Date(r.expenditure_date).toLocaleDateString() : "—"}
                      {r.description ? ` · ${r.description}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className={`font-mono font-semibold tabular-nums ${
                        r.support_oppose === "S" ? "text-success" : "text-destructive"
                      }`}
                    >
                      {r.support_oppose === "S" ? "+" : "−"}
                      {formatCurrencyFull(r.amount)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.support_oppose === "S" ? "Support" : "Oppose"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <p className="text-xs text-muted-foreground text-center pt-2">
          Source: Texas Ethics Commission, updated nightly.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="font-display font-semibold text-2xl">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function FinanceStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="font-mono font-semibold text-xl tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

function SourceBar({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: number;
  pct: number;
  color: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono tabular-nums">
          <span className="font-semibold">{formatCurrency(value)}</span>
          <span className="text-muted-foreground ml-2">{pct}%</span>
        </span>
      </div>
      <div className="h-2 bg-muted rounded-sm overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
