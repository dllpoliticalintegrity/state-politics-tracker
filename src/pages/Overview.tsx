// A state's landing page: the home headline, candidate search, and one card
// per statewide race (the races the site's menu shows), each clicking into
// that race's dashboard.
import RaceOverviewCard from "@/components/RaceOverviewCard";
import CandidateSearch from "@/components/CandidateSearch";
import ContributionsTicker from "@/components/ContributionsTicker";
import PoweredBy from "@/components/PoweredBy";
import { RaceProvider, useStateConfig } from "@/states/StateContext";
import { SITE_STATE, isSingleStateSite } from "@/states/site";
import { useSiteConfig } from "@/hooks/useSiteConfig";
import { homeHeadline } from "@/states/nicknames";
import MidtermsCountdown from "@/components/MidtermsCountdown";
import CongressLookup from "@/components/CongressLookup";
import RepresentativeLookup from "@/components/RepresentativeLookup";
import { REPRESENTATIVE_LOOKUP_URLS } from "@/lib/representativeLookup";

export default function Overview() {
  const state = useStateConfig();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  // Same list as the menu: a dedicated site can hide races in the admin.
  const races = isSingleStateSite ? chrome.races : state.races ?? [];
  const year = races[0]?.generalDate.slice(0, 4) ?? "2026";
  const representativeUrl = REPRESENTATIVE_LOOKUP_URLS[state.code];

  return (
    <div className="min-h-[80vh]">
      {races[0] && (
        // The ticker reads the active race; on the overview, the top race's.
        <RaceProvider race={races[0]}>
          <ContributionsTicker />
        </RaceProvider>
      )}

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
    </div>
  );
}
