import { Link } from "react-router-dom";
import type { StateConfig } from "@/states/registry";

export default function ComingSoon({ state }: { state: StateConfig }) {
  return (
    <div className="min-h-[60vh] container max-w-2xl pt-16 md:pt-24 pb-16 text-center space-y-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {state.name}
      </p>
      <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight leading-tight">
        {state.name} isn't live yet
      </h1>
      <p className="text-base text-muted-foreground">
        {state.status === "ready" ? (
          <>
            The campaign-finance data pipeline for {state.name} is ready — a curated
            dashboard is coming. Check back soon.
          </>
        ) : (
          <>We don't cover {state.name} yet.</>
        )}
      </p>
      <p>
        <Link to="/" className="text-sm text-primary hover:underline">
          ← All states
        </Link>
      </p>
    </div>
  );
}
