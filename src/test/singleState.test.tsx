// The React glue for single-state mode: with @/states/site pinned to
// Michigan, the chrome hooks must treat every URL as Michigan's, read the
// office from the first path segment, and build prefix-less links.
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { getState } from "@/states/registry";
import { statePathFor, siteNameFor } from "../../shared/site";

vi.mock("@/states/site", () => {
  const mi = getState("mi")!;
  return {
    SITE_STATE: mi,
    isSingleStateSite: true,
    SITE_NAME: siteNameFor(mi.name),
    ALL_STATES_URL: null,
    statePath: (code: string) => statePathFor("mi", code),
  };
});

import {
  RaceProvider,
  StateProvider,
  useActiveRace,
  useActiveState,
  useRaceBase,
  useStateBase,
} from "@/states/StateContext";

const mi = getState("mi")!;
const at = (path: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
);

describe("single-state hooks (pinned to Michigan)", () => {
  it("treats every URL as Michigan, including the root", () => {
    for (const path of ["/", "/governor", "/attorney-general/candidates/eli-savit", "/about", "/ga/governor"]) {
      const { result } = renderHook(() => useActiveState(), { wrapper: at(path) });
      expect(result.current?.code, path).toBe("mi");
    }
  });

  it("reads the office from the first segment and falls back to the first race", () => {
    const sos = renderHook(() => useActiveRace(), { wrapper: at("/secretary-of-state/polling") });
    expect(sos.result.current?.office).toBe("secretary-of-state");
    const about = renderHook(() => useActiveRace(), { wrapper: at("/about") });
    expect(about.result.current?.office).toBe(mi.races![0].office);
  });

  it("builds prefix-less links for Michigan and prefixed ones for other states", () => {
    const base = renderHook(() => useStateBase(), { wrapper: at("/governor") });
    expect(base.result.current).toBe("");

    const race = mi.races!.find((r) => r.office === "attorney-general")!;
    const raceBase = renderHook(() => useRaceBase(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/attorney-general"]}>
          <StateProvider config={mi}>
            <RaceProvider race={race}>{children}</RaceProvider>
          </StateProvider>
        </MemoryRouter>
      ),
    });
    expect(raceBase.result.current).toBe("/attorney-general");
    expect(statePathFor("mi", "ga")).toBe("/ga");
  });
});
