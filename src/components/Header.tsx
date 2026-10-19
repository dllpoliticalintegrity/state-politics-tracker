import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Menu, Mail, ExternalLink, LayoutGrid, Landmark, Building2, Users, Info, Vote, Crown, UserRound, Scale, FileText, Wallet } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useActiveState, useStateBase } from "@/states/StateContext";
import { STATES } from "@/states/registry";
import { ALL_STATES_URL, SITE_STATE, isSingleStateSite } from "@/states/site";
import { useSiteConfig } from "@/hooks/useSiteConfig";
import type { RaceConfig } from "@/states/registry";
import star from "@/assets/star.svg";
import { NEWSLETTER_SIGNUP_URL } from "@/lib/links";
import { stateOutlineUrl } from "@/states/outlines";


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
      <SelectTrigger className="h-10 w-[112px] shrink-0 text-sm sm:w-[150px]" aria-label="Choose a state">
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
        {external.length > 0 && (
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
        )}
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

/**
 * The site menu is fixed for a state: one entry per tracked race (statewide
 * offices, then legislative chambers) plus About. Navigation *within* a
 * race — Overview / Candidates / Polling / Money — lives in RaceSubnav on
 * the race pages, so this bar never changes shape as you move around.
 */
function useSiteMenu(navRaces: RaceConfig[]) {
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

function navIcon(key: string) {
  if (key === "") return LayoutGrid;
  if (key === "committees") return Users;
  if (key === "about") return Info;
  if (/senate/.test(key)) return Landmark;
  if (/house|assembly|legislat/.test(key)) return Building2;
  if (/lieutenant|lt-gov/.test(key)) return UserRound;
  if (/governor/.test(key)) return Crown;
  if (/attorney/.test(key)) return Scale;
  if (/secretary/.test(key)) return FileText;
  if (/treasurer|comptroller|controller|auditor/.test(key)) return Wallet;
  return Vote;
}

/** Mobile-only bar pinned to the bottom with the same tabs as the desktop menu. */
export function MobileBottomNav() {
  const activeState = useActiveState();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  const navRaces = isSingleStateSite ? chrome.races : activeState?.races ?? [];
  const menu = useSiteMenu(navRaces);
  if (menu.length === 0) return null;
  return (
    <>
      <div className="h-16 xl:hidden" aria-hidden="true" />
      <nav
        aria-label="Races (bottom)"
        data-mobile-bottom-nav
        className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 xl:hidden pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="flex w-full">
          {menu.slice(0, 3).map((item) => {
            const Icon = navIcon(item.key);
            return (
              <li key={item.key} className="min-w-0 flex-1 basis-0">
                <Link
                  to={item.to}
                  aria-current={item.active ? "page" : undefined}
                  className={`flex h-14 flex-col items-center justify-center gap-0.5 px-1 transition-colors ${
                    item.active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" strokeWidth={item.active ? 2.4 : 1.8} aria-hidden="true" />
                  <span className={`w-full break-words text-center text-[10px] leading-tight ${item.active ? "font-semibold" : "font-medium"}`}>
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
          <li className="min-w-0 flex-1 basis-0">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("open-mobile-menu"))}
              className="flex h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Menu className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
              <span className="w-full text-center text-[10px] font-medium leading-tight">More</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

export function Header() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-mobile-menu", onOpen);
    return () => window.removeEventListener("open-mobile-menu", onOpen);
  }, []);
  const { theme, setTheme } = useTheme();
  const activeState = useActiveState();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  const navRaces = isSingleStateSite ? chrome.races : activeState?.races ?? [];
  const menu = useSiteMenu(navRaces);
  // A state's own outline on its pages; the star on the hub's landing page.
  const outline = stateOutlineUrl(activeState?.code);
  const mark = outline ?? star;

  useEffect(() => {
    const root = document.documentElement;
    if (chrome.accentColor) root.style.setProperty("--site-accent", chrome.accentColor);
    else root.style.removeProperty("--site-accent");
    return () => {
      root.style.removeProperty("--site-accent");
    };
  }, [chrome.accentColor]);

  // Browser-tab icon: a published row's uploaded icon replaces the build's
  // icons (index.html) while it is set; clearing it restores them.
  useEffect(() => {
    if (!chrome.faviconUrl) return;
    const links = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
    const original = links.map((l) => [l.href, l.type] as const);
    for (const l of links) {
      l.href = chrome.faviconUrl;
      l.removeAttribute("type");
    }
    return () => {
      links.forEach((l, i) => {
        l.href = original[i][0];
        if (original[i][1]) l.type = original[i][1];
      });
    };
  }, [chrome.faviconUrl]);

  return (
    <header
      className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
      style={{ borderTop: "3px solid var(--site-accent, hsl(var(--primary)))" }}
    >
      <div className="container flex h-14 items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-2 sm:gap-3 min-w-0">
          <Link to="/" className="flex items-center gap-2 min-w-0 xl:flex-1">
            <span
               aria-label={outline && activeState ? `Outline of ${activeState.name}` : "Star"}
              role="img"
              data-testid="site-mark"
              className={`inline-block shrink-0 bg-primary ${outline ? "h-6 w-6" : "h-5 w-5"}`}
              style={{
                WebkitMaskImage: `url("${mark}")`,
                maskImage: `url("${mark}")`,
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
            <span className="min-w-0 font-display text-xs leading-tight font-bold break-words sm:text-lg sm:truncate">
              {chrome.logoUrl && <img src={chrome.logoUrl} alt="" className="h-6 w-auto mr-2 inline-block align-middle" />}
              {chrome.siteName}
            </span>
          </Link>
          {!isSingleStateSite && <StateSwitcher />}
          <span
            className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary"
            aria-label="Beta version"
          >
            Beta
          </span>
        </div>

        {menu.length > 0 && (
          <nav className="hidden xl:flex shrink-0 items-center gap-0.5" aria-label="Races">
            {menu.map((item) => (
              <Link key={item.key} to={item.to}>
                <Button
                  variant="ghost"
                  size="sm"
                    className={`h-8 px-1.5 2xl:px-2.5 text-[13px] ${
                    item.active
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

        <div className="hidden xl:flex shrink-0 items-center gap-1.5">
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
          <Button asChild size="sm" className="h-8 px-3 text-sm gap-1.5">
            <a href={NEWSLETTER_SIGNUP_URL} target="_blank" rel="noopener noreferrer">
              <Mail className="h-3.5 w-3.5" />
              Sign up
            </a>
          </Button>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild className="xl:hidden">
            <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Open menu">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-64 max-w-[calc(100vw-2rem)] overflow-y-auto bg-card pb-[env(safe-area-inset-bottom)]">
            <SheetTitle className="font-display text-lg">Menu</SheetTitle>
            <SheetDescription className="sr-only">Races, pages and settings for this site</SheetDescription>
            <nav className="flex flex-col gap-1 mt-6" aria-label="Races">
              {menu.map((item) => (
                <Link key={item.key} to={item.to} onClick={() => setOpen(false)}>
                  <Button
                    variant="ghost"
                    className={`w-full justify-start text-sm ${item.active ? "bg-accent font-semibold" : ""}`}
                  >
                    {item.label}
                  </Button>
                </Link>
              ))}
              {ALL_STATES_URL &&
                (isSingleStateSite ? (
                  <a href={ALL_STATES_URL} onClick={() => setOpen(false)}>
                    <Button variant="ghost" className="w-full justify-start gap-2 text-sm">
                      All states <ExternalLink className="h-3 w-3" />
                    </Button>
                  </a>
                ) : (
                  <Link to={ALL_STATES_URL} onClick={() => setOpen(false)}>
                    <Button variant="ghost" className="w-full justify-start text-sm">
                      All states
                    </Button>
                  </Link>
                ))}
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 text-sm"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </Button>
              <Button asChild className="w-full justify-start gap-2 text-sm mt-2">
                <a href={NEWSLETTER_SIGNUP_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
                  <Mail className="h-4 w-4" />
                  Sign up for updates
                </a>
              </Button>
            </nav>
          </SheetContent>
        </Sheet>

      </div>
    </header>
  );
}
