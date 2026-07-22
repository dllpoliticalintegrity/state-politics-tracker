import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Menu, Heart, ExternalLink } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { useTheme } from "next-themes";
import DonationPanel from "@/components/donate/DonationPanel";
import { useActiveRace, useActiveState } from "@/states/StateContext";
import { STATES } from "@/states/registry";
import star from "@/assets/star.svg";

// `race: true` items live under /:state/:office; the rest under /:state.
const navItems = [
  { to: "candidates", label: "Candidates", race: true },
  { to: "polling", label: "Polling", race: true },
  { to: "money", label: "Money", race: true },
  { to: "about", label: "About", race: false },
];

function StateSwitcher() {
  const activeState = useActiveState();
  const navigate = useNavigate();

  const live = STATES.filter((s) => s.status === "live");
  const external = STATES.filter((s) => s.status === "external");
  const ready = STATES.filter((s) => s.status === "ready");

  const onChange = (code: string) => {
    const cfg = STATES.find((s) => s.code === code);
    if (!cfg) return;
    if (cfg.status === "external") {
      window.open(cfg.externalUrl, "_blank", "noopener");
      return;
    }
    navigate(`/${cfg.code}`);
  };

  return (
    <Select value={activeState?.code ?? ""} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[150px] text-sm" aria-label="Choose a state">
        <SelectValue placeholder="Choose a state" />
      </SelectTrigger>
      <SelectContent>
        {live.length > 0 && (
          <SelectGroup>
            <SelectLabel>Live</SelectLabel>
            {live.map((s) => (
              <SelectItem key={s.code} value={s.code}>
                {s.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectLabel>Separate sites</SelectLabel>
          {external.map((s) => (
            <SelectItem key={s.code} value={s.code}>
              <span className="inline-flex items-center gap-1.5">
                {s.name} <ExternalLink className="h-3 w-3" />
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Coming soon</SelectLabel>
          {ready.map((s) => (
            <SelectItem key={s.code} value={s.code} disabled>
              {s.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function Header() {
  const activeState = useActiveState();
  const activeRace = useActiveRace();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  const stateBase = activeState ? `/${activeState.code}` : "";
  const linkFor = (item: { to: string; race: boolean }) =>
    item.race && activeRace
      ? `${stateBase}/${activeRace.office}/${item.to}`
      : `${stateBase}/${item.to}`;
  const isActive = (item: { to: string; race: boolean }) =>
    activeState ? location.pathname.startsWith(linkFor(item)) : false;

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className="container flex h-14 items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/" className="flex items-center gap-2 min-w-0">
            <span
              aria-label="Star"
              role="img"
              className="inline-block h-5 w-5 shrink-0 bg-primary"
              style={{
                WebkitMaskImage: `url("${star}")`,
                maskImage: `url("${star}")`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
            <span className="font-display text-lg font-bold tracking-tight truncate">
              State Politics Tracker
            </span>
          </Link>
          <StateSwitcher />
        </div>

        {activeState && (
          <nav className="hidden md:flex items-center gap-1">
            {navItems
              .filter((item) => item.to !== "polling" || activeRace?.pollingSourceUrl)
              .map((item) => (
              <Link key={item.to} to={linkFor(item)}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-8 px-3 text-sm ${
                    isActive(item)
                      ? "text-foreground bg-accent font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Button>
              </Link>
            ))}
          </nav>
        )}

        <div className="hidden md:flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Toggle theme"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>
          <Button size="sm" onClick={() => setDonateOpen(true)} className="h-8 px-3 text-sm gap-1.5">
            <Heart className="h-3.5 w-3.5" />
            Donate
          </Button>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild className="md:hidden">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open menu">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-64 bg-card">
            <SheetTitle className="font-display text-lg">Menu</SheetTitle>
            <nav className="flex flex-col gap-1 mt-6">
              {activeState &&
                navItems
                  .filter((item) => item.to !== "polling" || activeRace?.pollingSourceUrl)
                  .map((item) => (
                  <Link key={item.to} to={linkFor(item)} onClick={() => setOpen(false)}>
                    <Button variant="ghost" className="w-full justify-start text-sm">
                      {item.label}
                    </Button>
                  </Link>
                ))}
              <Link to="/" onClick={() => setOpen(false)}>
                <Button variant="ghost" className="w-full justify-start text-sm">
                  All states
                </Button>
              </Link>
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-sm"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </Button>
              <Button
                onClick={() => {
                  setOpen(false);
                  setDonateOpen(true);
                }}
                className="w-full justify-start gap-2 text-sm mt-2"
              >
                <Heart className="h-4 w-4" />
                Donate
              </Button>
            </nav>
          </SheetContent>
        </Sheet>

        <Dialog open={donateOpen} onOpenChange={setDonateOpen}>
          <DialogContent
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="w-[95vw] max-w-md h-[90vh] p-0 overflow-hidden bg-white"
          >
            <DialogTitle className="sr-only">Donate</DialogTitle>
            <DialogDescription className="sr-only">
              Donate to the Political Integrity Project
            </DialogDescription>
            {donateOpen && (
              <div className="h-full w-full overflow-y-auto scrollbar-hide bg-white">
                <DonationPanel />
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </header>
  );
}
