// The navigation strip under the site header on every state page, top to
// bottom:
//   1. the live contributions ticker, on the state overview and each race's
//      home (the pages that showed it before);
//   2. the race menu (Overview, each race, the chambers, Committees, About),
//      desktop only — phones use the hamburger and the bottom bar;
//   3. the selected race's own tabs (RaceSubnav: Overview / Candidates /
//      Polling / Money), directly beneath the menu whenever a race is open.
// Rendered once by StateArea, so pages no longer place the ticker or the
// race tabs themselves.
import { Link, useLocation } from "react-router-dom";
import ContributionsTicker from "@/components/ContributionsTicker";
import RaceSubnav from "@/components/RaceSubnav";
import { useSiteMenu } from "@/hooks/useSiteMenu";
import { useSiteConfig } from "@/hooks/useSiteConfig";
import { getChamber } from "@/states/registry";
import { RaceProvider, raceFromSegments, racePath, useStateConfig } from "@/states/StateContext";
import { SITE_STATE, isSingleStateSite } from "@/states/site";

export default function SiteNavStrip() {
  const state = useStateConfig();
  const { pathname } = useLocation();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  const navRaces = isSingleStateSite ? chrome.races : state.races ?? [];
  const menu = useSiteMenu(navRaces);

  const path = pathname.replace(/\/+$/, "");
  const segments = path.split("/");
  const officeIdx = SITE_STATE ? 1 : 2;
  const office = segments[officeIdx];
  const race = office
    ? raceFromSegments(state, office, getChamber(state, office) ? segments[officeIdx + 1] : undefined)
    : null;
  // The ticker reads the active race; on the overview, the top race's.
  const tickerRace = !office ? navRaces[0] : race && path === racePath(state, race) ? race : null;

  return (
    <>
      {tickerRace && (
        <RaceProvider race={tickerRace}>
          <ContributionsTicker />
        </RaceProvider>
      )}
      {menu.length > 0 && (
        <nav aria-label="Races" className="hidden border-b bg-background xl:block">
          <div className="container flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {menu.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                aria-current={item.active ? "page" : undefined}
                className={`-mb-px whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[13px] transition-colors ${
                  item.active
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
      {race && (
        <RaceProvider race={race}>
          <RaceSubnav />
        </RaceProvider>
      )}
    </>
  );
}
