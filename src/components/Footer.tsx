import { Link } from "react-router-dom";
import { useActiveState, useStateBase } from "@/states/StateContext";
import { ALL_STATES_URL, SITE_NAME, SITE_STATE, isSingleStateSite } from "@/states/site";

export function Footer() {
  const activeState = useActiveState();
  const stateBase = useStateBase();

  // Same fixed site menu as the header: the state's races, then About.
  const links = activeState
    ? [
        ...(activeState.races ?? []).map((r) => ({ to: `${stateBase}/${r.office}`, label: r.title })),
        ...(activeState.chambers ?? []).map((c) => ({ to: `${stateBase}/${c.office}`, label: c.title })),
        { to: `${stateBase}/about`, label: "About & methodology" },
      ]
    : [];

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
            {links.map(({ to, label }) => (
              <Link key={to} to={to} className="text-muted-foreground hover:text-foreground">
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
