import { createContext, useContext, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { getState, type StateConfig } from "./registry";

const StateContext = createContext<StateConfig | null>(null);

export function StateProvider({
  config,
  children,
}: {
  config: StateConfig;
  children: ReactNode;
}) {
  return <StateContext.Provider value={config}>{children}</StateContext.Provider>;
}

/** The active live state's config. Only usable inside a live state's routes. */
export function useStateConfig(): StateConfig {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useStateConfig must be used within a live state route");
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
