import { Card } from "@/components/ui/card";
import { useStateConfig } from "@/states/StateContext";
import { SITE_STATE, isSingleStateSite } from "@/states/site";
import { useSiteConfig } from "@/hooks/useSiteConfig";
import { pollingSourceLabel } from "@/states/registry";
import { usePublishedSites } from "@/hooks/usePublishedSites";
import { stateGuide } from "@/states/guides";
import StateRulesGuide from "@/components/StateRulesGuide";

export default function About() {
  const stateCfg = useStateConfig();
  const chrome = useSiteConfig(isSingleStateSite ? SITE_STATE : null);
  const races = isSingleStateSite ? chrome.races : stateCfg.races ?? [];
  const polled = (stateCfg.races ?? []).find((r) => r.pollingSourceUrl);
  const pollingLabel = pollingSourceLabel(polled ?? {});
  // Every dedicated single-state site except the one being read.
  const sites = usePublishedSites();
  const otherSites = Object.entries(sites)
    .filter(([code]) => code !== stateCfg.code)
    .sort(([a], [b]) => a.localeCompare(b));
  const guide = stateGuide(stateCfg.code);

  return (
    <div className="min-h-[70vh]">
      <section className="container pt-12 pb-6 space-y-3 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {stateCfg.name}
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          About & methodology
        </h1>
        {chrome.aboutText && (
          <p className="text-base text-foreground whitespace-pre-line">{chrome.aboutText}</p>
        )}
        <p className="text-base text-muted-foreground">
          {chrome.siteName} is a public-interest project of the Political Integrity Project.
          We follow the money and the polls in{" "}
          {isSingleStateSite ? `${stateCfg.name}'s` : ""} 2026 statewide races — who's
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
            {guide?.financeSource ? (
              <>
                's {guide.financeSource} Data is presented as filed; corrections and
                amendments appear after the next sync.
              </>
            ) : (
              <>
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
              </>
            )}
          </p>
          {guide?.methodology?.map((para) => (
            <p key={para} className="text-sm text-muted-foreground">
              {para}
            </p>
          ))}
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Polling</strong> comes from{" "}
            {polled ? (
              <a
                href={polled.pollingSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {pollingLabel}
              </a>
            ) : (
              pollingLabel
            )}
            's {stateCfg.name} pages — both individual polls and the aggregate. Our
            averages cover general-election matchups from roughly the last 60 days;
            primary-only polls are shown but kept out of the head-to-head average, and
            once the nominees are set, matchups {pollingLabel} marks hypothetical or
            that include a candidate who has left the race are left out too.
          </p>
        </Card>

        <Card className="p-5 space-y-3">
          <h2 className="font-display text-xl font-semibold">What's tracked here</h2>
          <p className="text-sm text-muted-foreground">
            For {stateCfg.name} we currently track:{" "}
            {races.map((r) => r.title).join(", ") || "no races yet"}
            {stateCfg.chambers?.length
              ? `, plus every ${stateCfg.chambers.map((c) => `${c.title} (${c.districts} districts)`).join(" and ")} seat — finance only, with the candidate list drawn from active candidate committees on file rather than curated by hand`
              : ""}
            . More statewide races are added as their candidate lists are curated. Campaign-finance rules —
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

        {guide && <StateRulesGuide guide={guide} />}

        <Card className="p-5 space-y-3">
          <h2 className="font-display text-xl font-semibold">Related sites</h2>
          <p className="text-sm text-muted-foreground">
            {otherSites.length > 0 && (
              <>
                States with their own dedicated site:{" "}
                {otherSites.map(([code, url], i) => (
                  <span key={code}>
                    {i > 0 && ", "}
                    <a href={url} className="text-primary hover:underline">
                      {url.replace(/^https?:\/\//, "")}
                    </a>
                  </span>
                ))}
                .{" "}
              </>
            )}
            Questions, corrections, or a state you'd like covered next:{" "}
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
