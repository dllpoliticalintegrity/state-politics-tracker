import { Link } from "react-router-dom";
import { useActiveRace, useActiveState, useStateBase } from "@/states/StateContext";
import { ALL_STATES_URL, SITE_NAME, SITE_STATE, isSingleStateSite } from "@/states/site";

const footerLinks = [
  { to: "candidates", label: "Candidates", race: true },
  { to: "polling", label: "Polling", race: true },
  { to: "money", label: "Money", race: true },
  { to: "about", label: "About & methodology", race: false },
];

export function Footer() {
  const activeState = useActiveState();
  const activeRace = useActiveRace();
  const stateBase = useStateBase();

  return (
    <footer className="border-t mt-16">
      <div className="container py-10 space-y-8">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8">
          <div className="max-w-sm space-y-2">
            <div className="font-display text-lg font-bold">{SITE_NAME}</div>
            <p className="text-sm text-muted-foreground">
              {SITE_STATE
                ? `A public-interest dashboard following the money and polling in ${SITE_STATE.name}'s 2026 statewide races, from the Political Integrity Project.`
                : "A public-interest dashboard following the money and polling in 2026 statewide races across the country, from the Political Integrity Project."}
            </p>
            <p className="text-sm text-muted-foreground">
              <a
                href="https://politicalintegritypac.substack.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Get updates by email →
              </a>
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm">
            {activeState &&
              footerLinks.map(({ to, label, race }) => (
                <Link
                  key={to}
                  to={
                    race && activeRace
                      ? `${stateBase}/${activeRace.office}/${to}`
                      : `${stateBase}/${to}`
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  {label}
                </Link>
              ))}
            {ALL_STATES_URL &&
              (isSingleStateSite ? (
                <a href={ALL_STATES_URL} className="text-muted-foreground hover:text-foreground">
                  All states
                </a>
              ) : (
                <Link to={ALL_STATES_URL} className="text-muted-foreground hover:text-foreground">
                  All states
                </Link>
              ))}
            <a
              href="mailto:team@politicalintegrity.us"
              className="text-muted-foreground hover:text-foreground"
            >
              Contact us
            </a>
          </nav>
        </div>
        <div className="pt-6 border-t text-xs text-muted-foreground space-y-1">
          <p>
            {activeState?.agency
              ? `Updated nightly from the ${activeState.agency.name} and 270toWin. `
              : "Updated nightly from each state's disclosure agency and 270toWin. "}
            Data is presented as filed; corrections and amendments appear after the next sync.
          </p>
          <p>© 2026 Political Integrity Project</p>
        </div>
      </div>
    </footer>
  );
}
