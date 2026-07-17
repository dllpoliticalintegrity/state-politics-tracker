import { createContext, useContext, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { getState, type RaceConfig, type StateConfig } from "./registry";

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

/**
 * The live state implied by the current URL, if any — safe to use in chrome
 * (Header, Footer, MobileTabBar) that renders on every page including the
 * landing grid, where no state is active.
 */
export function useActiveState(): StateConfig | null {
  const { pathname } = useLocation();
  const first = pathname.split("/")[1];
  const cfg = getState(first);
  return cfg && cfg.status === "live" ? cfg : null;
}

/**
 * The race implied by the current URL's second segment, falling back to the
 * state's first race. Chrome uses this to build race-scoped nav links.
 */
export function useActiveRace(): RaceConfig | null {
  const activeState = useActiveState();
  const { pathname } = useLocation();
  if (!activeState?.races?.length) return null;
  const second = pathname.split("/")[2];
  return activeState.races.find((r) => r.office === second) ?? activeState.races[0];
}
