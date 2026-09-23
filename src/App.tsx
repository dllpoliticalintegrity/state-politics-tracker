import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { useEffect } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ThemeProvider } from "next-themes";
import { StateProvider, RaceProvider, useRaceBase } from "@/states/StateContext";
import {
  districtRace,
  getChamber,
  getState,
  isValidDistrict,
  type ChamberConfig,
  type RaceConfig,
  type StateConfig,
} from "@/states/registry";
import { SITE_NAME, SITE_STATE } from "@/states/site";
import { routeMeta } from "../shared/seo";
import RaceSubnav from "@/components/RaceSubnav";
import StatePicker from "./pages/StatePicker";
import Chamber from "./pages/Chamber";
import ComingSoon from "./pages/ComingSoon";
import Index from "./pages/Index";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import IndependentExpenditures from "./pages/IndependentExpenditures";
import TopDonors from "./pages/TopDonors";
import Polling from "./pages/Polling";
import About from "./pages/About";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Everything under /:state (or under / on a single-state site, where `cfg`
// is the pinned state). Validates the code against the registry and renders
// the live state's race routes, a coming-soon page, an external redirect, or
// a 404.
function StateArea({ cfg: pinned }: { cfg?: StateConfig }) {
  const { state } = useParams();
  const cfg = pinned ?? getState(state);

  if (!cfg) return <NotFound />;
  if (cfg.status === "external") return <ExternalRedirect url={cfg.externalUrl!} name={cfg.name} />;
  if (cfg.status !== "live" || !cfg.races?.length) return <ComingSoon state={cfg} />;

  return (
    <StateProvider config={cfg}>
      <Routes>
        <Route index element={<Navigate to={cfg.races[0].office} replace />} />
        <Route path="about" element={<About />} />
        <Route path=":office/*" element={<RaceArea cfg={cfg} />} />
      </Routes>
    </StateProvider>
  );
}

// Everything under /:state/:office — a statewide race's dashboard pages, or,
// for a legislative chamber, the district overview plus one dashboard per
// district under /:state/:office/:district.
function RaceArea({ cfg }: { cfg: StateConfig }) {
  const { office } = useParams();
  const race = cfg.races!.find((r) => r.office === office);
  const chamber = getChamber(cfg, office);

  if (chamber) {
    return (
      <Routes>
        <Route
          index
          element={
            // A chamber-level pseudo race so race-contextual hooks on the
            // overview (useCandidateTotals) have a RaceProvider.
            <RaceProvider race={{ office: chamber.office, title: chamber.title, generalDate: chamber.generalDate, raceSlug: "" }}>
              <Chamber chamber={chamber} />
            </RaceProvider>
          }
        />
        <Route path=":district/*" element={<DistrictArea cfg={cfg} chamber={chamber} />} />
      </Routes>
    );
  }

  if (!race) return <NotFound />;
  return <RaceRoutes race={race} />;
}

function DistrictArea({ cfg, chamber }: { cfg: StateConfig; chamber: ChamberConfig }) {
  const { district } = useParams();
  if (!isValidDistrict(chamber, district)) return <NotFound />;
  return <RaceRoutes race={districtRace(cfg, chamber, district!)} />;
}

// The race's own tabs on every race sub-page. The race home renders them
// itself, under the live contributions ticker, so the ticker keeps the top.
function SubnavExceptHome() {
  const { pathname } = useLocation();
  const base = useRaceBase();
  if (pathname.replace(/\/+$/, "") === base) return null;
  return <RaceSubnav />;
}

// The race-scoped dashboard pages, shared by statewide and district races.
function RaceRoutes({ race }: { race: RaceConfig }) {
  return (
    <RaceProvider race={race}>
      <SubnavExceptHome />
      <Routes>
        <Route index element={<Index />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:slug" element={<CandidateDetail />} />
        {/* Relative to this route's own path (…/money), so "donors" → …/money/donors. */}
        <Route path="money" element={<Navigate to="donors" replace />} />
        <Route path="money/donors" element={<TopDonors />} />
        <Route path="money/outside-spending" element={<IndependentExpenditures />} />
        <Route path="polling" element={<Polling />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </RaceProvider>
  );
}

// On a single-state site, hub-style links (/mi/governor) still resolve —
// they drop the state prefix so a URL shared from the hub keeps working.
function StripStatePrefix({ code }: { code: string }) {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.replace(new RegExp(`^/${code}(?=/|$)`, "i"), "") || "/";
  return <Navigate to={{ pathname: rest, search, hash }} replace />;
}

function ExternalRedirect({ url, name }: { url: string; name: string }) {
  useEffect(() => {
    window.location.replace(url);
  }, [url]);
  return (
    <div className="min-h-[60vh] container pt-24 text-center text-sm text-muted-foreground">
      {name} is tracked on a separate site — taking you to{" "}
      <a href={url} className="text-primary hover:underline">
        {url.replace(/^https?:\/\//, "")}
      </a>
      …
    </div>
  );
}

function AppShell() {
  const location = useLocation();

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).posthog?.capture) {
      (window as any).posthog.capture("$pageview", { $current_url: window.location.href });
    }
  }, [location.pathname, location.search]);

  // Keep the tab title in step with client-side navigation, using the same
  // per-route metadata the Worker serves to crawlers (shared/seo.ts).
  useEffect(() => {
    const meta = routeMeta(location.pathname, SITE_STATE?.code ?? null);
    if (meta) document.title = meta.title;
    // A dedicated site's 404s and redirects still carry its own name, not the
    // hub's baked-in index.html title.
    else if (SITE_STATE) document.title = SITE_NAME;
  }, [location.pathname]);

  return (
    <>
      <Header />
      <Routes>
        {SITE_STATE ? (
          <>
            <Route path={`/${SITE_STATE.code}/*`} element={<StripStatePrefix code={SITE_STATE.code} />} />
            <Route path="/*" element={<StateArea cfg={SITE_STATE} />} />
          </>
        ) : (
          <>
            <Route path="/" element={<StatePicker />} />
            <Route path="/:state/*" element={<StateArea />} />
          </>
        )}
      </Routes>
      <Footer />
    </>
  );
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
