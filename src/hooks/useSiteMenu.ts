import { useLocation } from "react-router-dom";
import { useActiveState, useStateBase } from "@/states/StateContext";
import type { RaceConfig } from "@/states/registry";

/**
 * The site menu is fixed for a state: one entry per tracked race (statewide
 * offices, then legislative chambers) plus About. On desktop it is its own
 * bar under the ticker (SiteNavStrip); on phones it fills the bottom bar and
 * the hamburger sheet. Navigation *within* a race — Overview / Candidates /
 * Polling / Money — is RaceSubnav, right beneath the bar.
 */
export function useSiteMenu(navRaces: RaceConfig[]) {
  const activeState = useActiveState();
  const stateBase = useStateBase();
  const { pathname } = useLocation();
  if (!activeState) return [];
  const officeIdx = stateBase ? 2 : 1;
  const currentOffice = pathname.split("/")[officeIdx];
  const items = [
    { to: stateBase || "/", label: "Overview", key: "" },
    ...navRaces.map((r) => ({ to: `${stateBase}/${r.office}`, label: r.title, key: r.office })),
    ...(activeState.chambers ?? []).map((c) => ({ to: `${stateBase}/${c.office}`, label: c.title, key: c.office })),
    { to: `${stateBase}/committees`, label: "Committees", key: "committees" },
    { to: `${stateBase}/about`, label: "About", key: "about" },
  ];
  return items.map((i) => ({ ...i, active: (currentOffice ?? "") === i.key }));
}
