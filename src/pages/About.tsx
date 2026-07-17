import { Card } from "@/components/ui/card";
import { useStateConfig } from "@/states/StateContext";

export default function About() {
  const stateCfg = useStateConfig();
  const races = stateCfg.races ?? [];

  return (
    <div className="min-h-[70vh]">
      <section className="container pt-12 pb-6 space-y-3 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {stateCfg.name}
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          About & methodology
        </h1>
        <p className="text-base text-muted-foreground">
          State Politics Tracker is a public-interest project of the Political Integrity
          Project. We follow the money and the polls in 2026 statewide races — who's
          giving, who's spending, and where each race stands.
        </p>
      </section>

      <section className="container pb-10 max-w-3xl space-y-4">
        <Card className="p-5 space-y-3">
          <h2 className="font-display text-xl font-semibold">Where the data comes from</h2>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Campaign finance</strong> for {stateCfg.name}{" "}
            is sourced from the{" "}
            {stateCfg.agency ? (
              <a
                href={stateCfg.agency.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {stateCfg.agency.name}
              </a>
            ) : (
              "state disclosure agency"
            )}
            's public filings, normalized through the open-source{" "}
            <a
              href="https://github.com/hderyke/state-level-campaign-finance"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              state-level-campaign-finance
            </a>{" "}
            pipeline. Data is presented as filed; corrections and amendments appear after
            the next sync.
          </p>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Polling</strong> comes from{" "}
            {races[0]?.pollingSourceUrl ? (
              <a
                href={races[0].pollingSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                270toWin
              </a>
            ) : (
              "270toWin"
            )}
            's {stateCfg.name} pages — both individual polls and the aggregate. Our
            averages cover general-election matchups from roughly the last 60 days;
            primary-only polls are shown but kept out of the head-to-head average.
          </p>
        </Card>

        <Card className="p-5 space-y-3">
          <h2 className="font-display text-xl font-semibold">What's tracked here</h2>
          <p className="text-sm text-muted-foreground">
            For {stateCfg.name} we currently track:{" "}
            {races.map((r) => r.title).join(", ") || "no races yet"}. More statewide races
            are added as their candidate lists are curated. Campaign-finance rules —
            contribution limits, who may give, and how outside spending is disclosed —
            differ meaningfully by state; consult{" "}
            {stateCfg.agency ? (
              <a
                href={stateCfg.agency.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {stateCfg.agency.name}
              </a>
            ) : (
              "the state's disclosure agency"
            )}{" "}
            for the authoritative rules in {stateCfg.name}.
          </p>
        </Card>

        <Card className="p-5 space-y-3">
          <h2 className="font-display text-xl font-semibold">Related sites</h2>
          <p className="text-sm text-muted-foreground">
            The 2026 Texas Governor's race is tracked in depth at{" "}
            <a
              href="https://texaspoliticstracker.com"
              className="text-primary hover:underline"
            >
              texaspoliticstracker.com
            </a>
            . Questions, corrections, or a state you'd like covered next:{" "}
            <a
              href="mailto:team@politicalintegrity.us"
              className="text-primary hover:underline"
            >
              team@politicalintegrity.us
            </a>
            .
          </p>
        </Card>
      </section>
    </div>
  );
}
