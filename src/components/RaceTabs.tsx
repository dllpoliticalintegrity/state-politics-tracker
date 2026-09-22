import { Link, useLocation } from "react-router-dom";
import { useRaceBase, useRaceConfig, useStateConfig } from "@/states/StateContext";
import { statePath } from "@/states/site";

/**
 * Pill tabs switching between a state's tracked races. Hidden when a state
 * has only one race.
 *
 * Rendered in two places: at the top of every race sub-page (RaceArea in
 * App), and inline on the race home (Index) where they sit under the hero
 * so the live contributions ticker can take the very top of the page. The
 * top placement skips the race home to avoid showing the tabs twice.
 */
export default function RaceTabs({ inline = false }: { inline?: boolean }) {
  const state = useStateConfig();
  const race = useRaceConfig();
  const raceBase = useRaceBase();
  const { pathname } = useLocation();
  const races = state.races ?? [];
  if (races.length < 2) return null;
  if (!inline && pathname.replace(/\/+$/, "") === raceBase) return null;

  return (
    <div className={inline ? "container pb-8" : "container pt-5 -mb-1"}>
      <nav aria-label="Races" className="flex flex-wrap justify-center gap-1.5">
        {races.map((r) => {
          const active = r.office === race.office;
          return (
            <Link
              key={r.office}
              to={`${statePath(state.code)}/${r.office}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-4 py-1.5 text-[13px] font-semibold transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {r.title}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
