import { Link, NavLink } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { getChamber } from "@/states/registry";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";

/**
 * A race's own tabs — Overview / Candidates / Polling / Money — rendered at
 * the top of every page inside a race. The site header stays fixed on the
 * races themselves (Governor, Attorney General, …); this strip is the
 * navigation *within* the race the header selected. District races also
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
      <div className="container flex items-center gap-4 overflow-x-auto scrollbar-hide">
        {chamber && (
          <Link
            to={`${statePath(state.code)}/${chamber.office}`}
            className="inline-flex items-center gap-0.5 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground whitespace-nowrap shrink-0"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {chamber.title}
          </Link>
        )}
        <div className="text-sm font-semibold whitespace-nowrap shrink-0 py-2.5 pr-2 border-r hidden sm:block">
          {race.title}
        </div>
        <nav aria-label={`${race.title} sections`} className="flex gap-5 -mb-px">
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
