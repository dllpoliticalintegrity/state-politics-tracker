import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/money/donors", label: "Top donors" },
  { to: "/money/outside-spending", label: "Outside spending" },
];

/** Tab navigation shared by the pages under the Money section. */
export default function MoneyTabs() {
  return (
    <nav aria-label="Money sections" className="border-b">
      <div className="flex gap-6 -mb-px">
        {tabs.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `pb-2.5 text-sm border-b-2 transition-colors ${
                isActive
                  ? "border-primary text-foreground font-semibold"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
