import { Link } from "react-router-dom";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";

/** Pill tabs switching between a state's tracked races. Hidden when a state
 * has only one race. Rendered on every race page (see RaceArea in App). */
export default function RaceTabs() {
  const state = useStateConfig();
  const race = useRaceConfig();
  const races = state.races ?? [];
  if (races.length < 2) return null;

  return (
    <div className="container pt-5 -mb-1">
      <nav aria-label="Races" className="flex flex-wrap justify-center gap-1.5">
        {races.map((r) => {
          const active = r.office === race.office;
          return (
            <Link
              key={r.office}
              to={`/${state.code}/${r.office}`}
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
