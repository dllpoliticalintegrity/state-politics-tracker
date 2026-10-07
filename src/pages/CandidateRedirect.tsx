import { Navigate, useParams } from "react-router-dom";
import { useCandidate } from "@/hooks/useCandidates";
import { raceFromSegments, racePath, useStateConfig } from "@/states/StateContext";
import NotFound from "./NotFound";

/**
 * /:state/candidates/:slug (or /candidates/:slug on a dedicated site) — a
 * race-less candidate link, as the Texas site used before it joined the hub.
 * Looks the candidate up and forwards to their race's profile page.
 */
export default function CandidateRedirect() {
  const { slug } = useParams<{ slug: string }>();
  const state = useStateConfig();
  const { data: candidate, isLoading } = useCandidate(slug);

  if (isLoading) {
    return (
      <div className="container py-20 text-sm text-muted-foreground text-center">Loading candidate…</div>
    );
  }
  const race =
    candidate && candidate.state === state.code
      ? raceFromSegments(state, candidate.office ?? undefined, candidate.district ?? undefined)
      : null;
  if (!candidate || !race) return <NotFound />;
  return <Navigate to={`${racePath(state, race)}/candidates/${candidate.slug}`} replace />;
}
