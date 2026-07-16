import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { useEffect } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";
import { ThemeProvider } from "next-themes";
import { StateProvider, useActiveState } from "@/states/StateContext";
import { getState } from "@/states/registry";
import StatePicker from "./pages/StatePicker";
import ComingSoon from "./pages/ComingSoon";
import Index from "./pages/Index";
import Candidates from "./pages/Candidates";
import CandidateDetail from "./pages/CandidateDetail";
import IndependentExpenditures from "./pages/IndependentExpenditures";
import TopDonors from "./pages/TopDonors";
import Polling from "./pages/Polling";
import Statewide from "./pages/Statewide";
import About from "./pages/About";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Everything under /:state. Validates the code against the registry and
// renders the live dashboard, a coming-soon page, an external redirect,
// or a 404.
function StateArea() {
  const { state } = useParams();
  const cfg = getState(state);

  if (!cfg) return <NotFound />;
  if (cfg.status === "external") return <ExternalRedirect url={cfg.externalUrl!} name={cfg.name} />;
  if (cfg.status !== "live") return <ComingSoon state={cfg} />;

  return (
    <StateProvider config={cfg}>
      <Routes>
        <Route index element={<Index />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:slug" element={<CandidateDetail />} />
        <Route path="money" element={<Navigate to="money/donors" replace />} />
        <Route path="money/donors" element={<TopDonors />} />
        <Route path="money/outside-spending" element={<IndependentExpenditures />} />
        <Route path="polling" element={<Polling />} />
        <Route path="statewide" element={<Statewide />} />
        <Route path="about" element={<About />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </StateProvider>
  );
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
  const activeState = useActiveState();

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).posthog?.capture) {
      (window as any).posthog.capture("$pageview", { $current_url: window.location.href });
    }
  }, [location.pathname, location.search]);

  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<StatePicker />} />
        <Route path="/:state/*" element={<StateArea />} />
      </Routes>
      <Footer />
      {activeState && (
        <>
          <MobileTabBar />
          <div className="md:hidden h-14" aria-hidden />
        </>
      )}
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
