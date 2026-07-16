import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { STATES, type StateConfig } from "@/states/registry";

const STATUS_LABEL: Record<StateConfig["status"], string> = {
  live: "Dashboard live",
  external: "Separate site",
  ready: "Pipeline ready",
  planned: "Not yet covered",
};

const DOT_CLASS: Record<StateConfig["status"], string> = {
  live: "bg-primary",
  external: "border-2 border-primary bg-transparent",
  ready: "bg-warning",
  planned: "bg-border",
};

export default function StatePicker() {
  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 md:pt-16 pb-8 max-w-3xl text-center space-y-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          2026 statewide races
        </p>
        <h1 className="font-display text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          Who's winning your state — and who's paying for it
        </h1>
        <p className="text-base text-muted-foreground max-w-xl mx-auto">
          Polling averages, campaign finance, and outside spending for governor's races
          across the country, synced from each state's disclosure agency and 270toWin.
          Pick your state to start.
        </p>
      </section>

      <section className="container pb-4">
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          {(["live", "external", "ready", "planned"] as const).map((status) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${DOT_CLASS[status]}`} />
              {status === "external" ? "Tracked on a separate site" : STATUS_LABEL[status]}
            </span>
          ))}
        </div>
      </section>

      <section className="container pb-16 pt-6">
        <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          {STATES.map((s) => (
            <StateTile key={s.code} state={s} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StateTile({ state }: { state: StateConfig }) {
  const inner = (
    <>
      <div className="font-mono text-[11px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
        {state.code}
      </div>
      <div className="font-display text-base font-semibold mb-1.5">{state.name}</div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={`h-2 w-2 rounded-full shrink-0 ${DOT_CLASS[state.status]}`} />
        {STATUS_LABEL[state.status]}
        {state.status === "external" && <ExternalLink className="h-3 w-3" />}
      </div>
    </>
  );

  const base = "block rounded-md border bg-card p-3 text-left";

  switch (state.status) {
    case "live":
      return (
        <Link
          to={`/${state.code}`}
          className={`${base} border-primary shadow-[0_1px_0_hsl(var(--primary))] hover:bg-accent`}
        >
          {inner}
        </Link>
      );
    case "external":
      return (
        <a
          href={state.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${base} border-dashed border-primary hover:bg-accent`}
        >
          {inner}
        </a>
      );
    case "ready":
      return (
        <Link to={`/${state.code}`} className={`${base} hover:bg-accent`}>
          {inner}
        </Link>
      );
    default:
      return <div className={`${base} opacity-55`}>{inner}</div>;
  }
}
