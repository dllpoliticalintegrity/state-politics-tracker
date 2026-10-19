import { Link, NavLink } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { getChamber } from "@/states/registry";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";

/**
 * A race's own tabs — Overview / Candidates / Polling / Money — directly
 * beneath the race menu (SiteNavStrip), which already shows the selected
 * race, so the strip carries no race name of its own. District races also
 * get a crumb back to their chamber overview.
 */
export default function RaceSubnav() {
  const state = useStateConfig();
  const race = useRaceConfig();
  const base = useRaceBase();
  const chamber = race.district ? getChamber(state, race.office) : undefined;

  const tabs = [
    { to: base, label: "Overview", end: true },
    { to: `${base}/candidates`, label: "Candidates", end: false },
    ...(race.pollingSourceUrl ? [{ to: `${base}/polling`, label: "Polling", end: false }] : []),
    { to: `${base}/money`, label: "Money", end: false },
  ];

  return (
    <div className="border-b bg-card/60">
      <div className="container flex flex-wrap items-center gap-x-4 sm:flex-nowrap">
        {chamber && (
          <Link
            to={`${statePath(state.code)}/${chamber.office}`}
            className="inline-flex items-center gap-0.5 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground whitespace-nowrap shrink-0"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {chamber.title}
          </Link>
        )}
        <nav aria-label={`${race.title} sections`} className="flex w-full justify-between gap-3 sm:w-auto sm:justify-start sm:gap-5 -mb-px">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `py-2.5 text-sm border-b-2 whitespace-nowrap transition-colors ${
                  isActive
                    ? "border-primary text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
