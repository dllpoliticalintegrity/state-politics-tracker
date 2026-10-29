// A state's landing page: the home headline, candidate search, and one card
// per statewide race (the races the site's menu shows), each clicking into
// that race's dashboard.
import RaceOverviewCard from "@/components/RaceOverviewCard";
import CandidateSearch from "@/components/CandidateSearch";
import PoweredBy from "@/components/PoweredBy";
import { RaceProvider, useStateConfig } from "@/states/StateContext";
import { SITE_STATE, isSingleStateSite } from "@/states/site";
import { useSiteConfig } from "@/hooks/useSiteConfig";
import { homeHeadline } from "@/states/nicknames";
import MidtermsCountdown from "@/components/MidtermsCountdown";
import CongressLookup from "@/components/CongressLookup";
import RepresentativeLookup from "@/components/RepresentativeLookup";
import { REPRESENTATIVE_LOOKUP_URLS } from "@/lib/representativeLookup";
import { useMemo, useState } from "react";
import DonorTreemap from "@/components/DonorTreemap";
import { useStateCandidates, useStateTopDonors, type DonorKind } from "@/hooks/useCandidates";
import { givesOwnMoney, recipientParty } from "@/lib/donorCharts";
import { formatCurrency } from "@/lib/finance";

export default function Overview() {
  const state = useStateConfig();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  // Same list as the menu: a dedicated site can hide races in the admin.
  const races = isSingleStateSite ? chrome.races : state.races ?? [];
  const year = races[0]?.generalDate.slice(0, 4) ?? "2026";
  const representativeUrl = REPRESENTATIVE_LOOKUP_URLS[state.code];
  // Individuals only, PACs & committees only, or everyone — fetched per
  // type so each view is a true top 100 (the money page's Type filter).
  const [kind, setKind] = useState<DonorKind>("all");
  // A few more than the treemap shows, so it is still a top 100 with
  // candidates' own money left out.
  const topDonors = useStateTopDonors(120, kind);
  const { data: stateCandidates } = useStateCandidates();
  // Candidates' own money (self-funding and the loans they make their
  // campaigns) can be left out of the treemap.
  const [hideOwnMoney, setHideOwnMoney] = useState(false);
  // Each donor's party, from the candidates they gave to — the site's own
  // party designation per candidate — and whether they are a candidate
  // funding their own run.
  const donors = useMemo(() => {
    const byId = new Map((stateCandidates ?? []).map((c) => [c.id, c]));
    return (topDonors.data ?? []).map((d) => ({
      ...d,
      party: recipientParty(d.splits, (id) => byId.get(id)?.party),
      own: givesOwnMoney(d, (id) => byId.get(id)?.name),
    }));
  }, [topDonors.data, stateCandidates]);
  const ownMoney = donors.filter((d) => d.own);
  const shownDonors = hideOwnMoney ? donors.filter((d) => !d.own) : donors;
  const ownTotal = ownMoney.reduce((s, d) => s + d.total_amount, 0);

  return (
    <div className="min-h-[80vh]">

      <section className="container pt-6 md:pt-8 pb-8 max-w-3xl text-center space-y-4">
        <PoweredBy />
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {`${year} ${state.name} elections`}
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {homeHeadline(state.code, state.name)}
        </h1>
        <MidtermsCountdown />
        {state.source === "tracker" && (
          <CandidateSearch
            states={[state.code]}
            placeholder={`Search any ${state.name} candidate by name`}
            mobilePlaceholder="Search candidates"
            className="pt-2"
          />
        )}
        {representativeUrl && (
          <RepresentativeLookup url={representativeUrl} stateName={state.name} />
        )}
        <CongressLookup />
      </section>

      <section className="container pb-16">
        <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Statewide races
        </h2>
        <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-3">
          {races.map((r) => (
            <RaceProvider key={r.office} race={r}>
              <RaceOverviewCard />
            </RaceProvider>
          ))}
        </div>
      </section>

      {(topDonors.data?.length ?? 0) > 0 && (
        <section className="container pb-16">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Top 100 donors
          </h2>
          <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
            Who has given the most to {state.name}'s {year} statewide campaigns, all races combined. Each race's
            Money tab has the full ranking and the breakdown by candidate.
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="w-10 text-muted-foreground">Type</span>
            {(
              [
                { value: "all", label: "All" },
                { value: "individual", label: "Individuals" },
                { value: "pac", label: "PACs & committees" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setKind(opt.value)}
                aria-pressed={kind === opt.value}
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  kind === opt.value
                    ? "border-primary bg-primary/10 font-semibold text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {ownMoney.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="w-10 text-muted-foreground">Show</span>
              {(
                [
                  { value: false, label: "All donors" },
                  { value: true, label: "Without candidates' own money" },
                ] as const
              ).map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => setHideOwnMoney(opt.value)}
                  aria-pressed={hideOwnMoney === opt.value}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    hideOwnMoney === opt.value
                      ? "border-primary bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <span className="text-muted-foreground">
                {hideOwnMoney ? "Hiding" : "Includes"} {ownMoney.length} candidate{ownMoney.length === 1 ? "" : "s"} funding their own
                run{ownMoney.length === 1 ? "" : "s"} ({formatCurrency(ownTotal)}, loans included).
              </span>
            </div>
          )}
          <DonorTreemap donors={shownDonors} limit={100} />
          {state.agency && (
            <p className="mt-2 text-xs text-muted-foreground">Updated nightly from {state.agency.name} filings.</p>
          )}
        </section>
      )}
    </div>
  );
}
