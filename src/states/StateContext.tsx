import { createContext, useContext, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import {
  districtRace,
  getChamber,
  getState,
  isValidDistrict,
  type RaceConfig,
  type StateConfig,
} from "./registry";
import { SITE_STATE, statePath } from "./site";

const StateContext = createContext<StateConfig | null>(null);
const RaceContext = createContext<RaceConfig | null>(null);

export function StateProvider({
  config,
  children,
}: {
  config: StateConfig;
  children: ReactNode;
}) {
  return <StateContext.Provider value={config}>{children}</StateContext.Provider>;
}

export function RaceProvider({
  race,
  children,
}: {
  race: RaceConfig;
  children: ReactNode;
}) {
  return <RaceContext.Provider value={race}>{children}</RaceContext.Provider>;
}

/** The active live state's config. Only usable inside a live state's routes. */
export function useStateConfig(): StateConfig {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useStateConfig must be used within a live state route");
  return ctx;
}

/** The active race's config. Only usable inside a race's routes. */
export function useRaceConfig(): RaceConfig {
  const ctx = useContext(RaceContext);
  if (!ctx) throw new Error("useRaceConfig must be used within a race route");
  return ctx;
}

/** URL path of a race's pages: "/mi/governor", "/mi/state-senate/11" (prefix-less on a dedicated site). */
export function racePath(state: StateConfig, race: RaceConfig): string {
  return `${statePath(state.code)}/${race.office}${race.district ? `/${race.district}` : ""}`;
}

/**
 * The live state implied by the current URL, if any — safe to use in chrome
 * (Header, Footer) that renders on every page including the
 * landing grid, where no state is active. On a dedicated single-state site
 * the pinned state is always active.
 */
export function useActiveState(): StateConfig | null {
  const { pathname } = useLocation();
  if (SITE_STATE) return SITE_STATE;
  const first = pathname.split("/")[1];
  const cfg = getState(first);
  return cfg && cfg.status === "live" ? cfg : null;
}

/** URL prefix of the active state's pages: "/mi" on the hub, "" on its own site. */
export function useStateBase(): string {
  const state = useActiveState();
  return state ? statePath(state.code) : "";
}

/** Base path for the active race's pages, e.g. "/mi/governor" or "/mi/state-senate/11". */
export function useRaceBase(): string {
  const state = useStateConfig();
  const race = useRaceConfig();
  return racePath(state, race);
}

/**
 * Resolve the URL's office (and district) segments to a race: a statewide
 * race, one district of a chamber, or null when the segments name a chamber
 * without a district (the chamber overview) or nothing race-like at all.
 */
export function raceFromSegments(
  state: StateConfig,
  office: string | undefined,
  next: string | undefined,
): RaceConfig | null {
  const statewide = state.races?.find((r) => r.office === office);
  if (statewide) return statewide;
  const chamber = getChamber(state, office);
  if (chamber && isValidDistrict(chamber, next)) return districtRace(state, chamber, next!);
  return null;
}

/**
 * The race implied by the URL (statewide office, or chamber + district),
 * falling back to the state's first race on non-race pages such as /about.
 * Null on a chamber overview, where race-scoped links make no sense.
 */
export function useActiveRace(): RaceConfig | null {
  const activeState = useActiveState();
  const { pathname } = useLocation();
  if (!activeState?.races?.length) return null;
  const segments = pathname.split("/");
  const officeIdx = SITE_STATE ? 1 : 2;
  const office = segments[officeIdx];
  if (getChamber(activeState, office)) {
    return raceFromSegments(activeState, office, segments[officeIdx + 1]);
  }
  return raceFromSegments(activeState, office, undefined) ?? activeState.races[0];
}

/** URL path of the active race's pages, for chrome links; null when no race is active. */
export function useActiveRaceBase(): string | null {
  const state = useActiveState();
  const race = useActiveRace();
  return state && race ? racePath(state, race) : null;
}
