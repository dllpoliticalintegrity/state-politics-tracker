import { Link, useLocation } from "react-router-dom";
import { Home, Users, TrendingUp, DollarSign, Info } from "lucide-react";
import { useActiveRace, useActiveState } from "@/states/StateContext";

const items = [
  { to: "", label: "Home", icon: Home, race: true },
  { to: "/candidates", label: "Candidates", icon: Users, race: true },
  { to: "/polling", label: "Polling", icon: TrendingUp, race: true },
  { to: "/money", label: "Money", icon: DollarSign, race: true },
  { to: "/about", label: "About", icon: Info, race: false },
];

export function MobileTabBar() {
  const location = useLocation();
  const activeState = useActiveState();
  const activeRace = useActiveRace();

  // Only rendered inside a live state's routes (App gates on this too).
  if (!activeState || !activeRace) return null;
  const stateBase = `/${activeState.code}`;
  const base = `${stateBase}/${activeRace.office}`;

  const linkFor = (item: { to: string; race: boolean }) =>
    item.race ? `${base}${item.to}` : `${stateBase}${item.to}`;
  const isActive = (item: { to: string; race: boolean }) =>
    item.to === "" ? location.pathname === base : location.pathname.startsWith(linkFor(item));

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <ul className="flex items-stretch justify-around h-14">
        {items.map((item) => {
          const { to, label, icon: Icon } = item;
          const active = isActive(item);
          return (
            <li key={to} className="flex-1">
              <Link
                to={linkFor(item)}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 h-full text-[11px] transition-colors ${
                  active ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
