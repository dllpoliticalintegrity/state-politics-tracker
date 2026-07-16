import { Card } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Check, X, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    { q: "How much can I personally give to a candidate for Governor?", a: "There is no limit. Texas places no cap on contributions from individuals or PACs to candidates for non-judicial state office, including Governor. Every contribution over the itemization threshold must be publicly disclosed to the Texas Ethics Commission." },
    { q: "Can corporations or unions give to candidates?", a: "No. Texas prohibits corporations and labor organizations from contributing to candidates or officeholders. They may, however, make unlimited direct campaign expenditures (independent spending) and contribute to committees that only make such expenditures." },
    { q: "What about Super PACs and outside spending?", a: "Direct campaign expenditures — Texas's version of independent expenditures — are unlimited, as long as the spending happens without the candidate's prior consent or approval. Each expenditure is reported to the TEC with the candidate it benefits." },
    { q: "When must contributions be disclosed?", a: "Candidates file semiannual reports each January 15 and July 15, 30-day and 8-day reports before each election, and daily reports of large contributions received in the last days before an election." },
    { q: "Are there timing restrictions on giving?", a: "Yes. Statewide officeholders and legislators may not accept political contributions during the legislative-session moratorium (roughly 30 days before a regular session through 20 days after adjournment), and contributions may not be made or accepted in the Capitol." },
    { q: "Can candidates spend campaign money on themselves?", a: "No. Texas prohibits converting political contributions to personal use — expenses that would exist regardless of the campaign or officeholder duties." },
    { q: "Are political contributions tax-deductible?", a: "No. Political contributions are not deductible on federal income taxes, and Texas has no state income tax." },
    { q: "Where does this data come from?", a: "Contribution and expenditure data on this site is sourced from the Texas Ethics Commission's daily bulk export of electronically filed campaign-finance reports." },
  ].map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

const govLimits = [
  { who: "Individual", limit: "No limit" },
  { who: "PAC (general-purpose committee)", limit: "No limit" },
  { who: "Political party", limit: "No limit" },
  { who: "Corporation / labor union", limit: "Prohibited" },
];

const disclosureSchedule = [
  { report: "Semiannual report", due: "Jan 15 & Jul 15" },
  { report: "30-day pre-election report", due: "30 days before election" },
  { report: "8-day pre-election report", due: "8 days before election" },
  { report: "Daily report (large late gifts)", due: "Final 9 days before election" },
];

const allowed = [
  "Individuals donating any amount to a Governor candidate (fully disclosed)",
  "PACs and political parties making unlimited contributions to candidates",
  "Unlimited direct campaign expenditures (independent spending) by outside groups",
  "Corporations and unions funding PACs that only make direct campaign expenditures",
  "Candidates self-funding or lending their own campaign without limit",
  "Out-of-state PAC contributions (with extra paperwork identifying the donor PAC)",
];

const notAllowed = [
  "A corporation or labor union contributing to a candidate or officeholder",
  "Contributions made in another person's name",
  "Cash contributions totaling more than $100 from one person per reporting period",
  "Coordinating 'independent' spending with the benefited candidate's campaign",
  "Accepting contributions in the Capitol, or during the legislative-session moratorium",
  "Converting campaign funds to personal use",
];

export default function About() {
  return (
    <div className="min-h-[80vh]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <section className="container pt-12 pb-6 space-y-3 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          About this site
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight">
          What we track, and where the data comes from
        </h1>
        <p className="text-base text-muted-foreground">
          Texas Politics Tracker is a public-interest project of the Political Integrity
          Project. We follow the money and the polls in the 2026 Texas Governor's race —
          plus the other statewide executive races — using primary sources only.
        </p>
      </section>

      {/* Methodology / data sources */}
      <section className="container pb-8 max-w-3xl space-y-4">
        <h2 className="font-display text-xl md:text-2xl font-semibold">Data sources & methodology</h2>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Campaign finance</strong> comes from the{" "}
            <a
              href="https://www.ethics.state.tx.us/search/cf/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Texas Ethics Commission's
            </a>{" "}
            daily bulk export of electronically filed reports. Each candidate's totals combine
            their candidate/officeholder account with their principal specific-purpose committee
            (for example, "Texans for Greg Abbott"), so the numbers reflect the whole campaign.
            Superseded reports are excluded.
          </p>
          <p>
            <strong className="text-foreground">Polling</strong> comes from{" "}
            <a
              href="https://www.270towin.com/2026-governor-polls/texas"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              270toWin's
            </a>{" "}
            Texas governor page — both the published average and the individual polls behind it.
          </p>
          <p>
            <strong className="text-foreground">Outside spending</strong> is built from TEC
            direct-campaign-expenditure filings — Texas's version of independent expenditures —
            reported with the candidate each expenditure supports or opposes. See the{" "}
            <Link to="/money/outside-spending" className="text-primary hover:underline">
              outside spending tracker
            </Link>
            .
          </p>
          <p>
            Everything syncs nightly. Data is presented as filed; amendments and corrections
            appear after the next sync. Found something off? Email{" "}
            <a href="mailto:team@politicalintegrity.us" className="text-primary hover:underline">
              team@politicalintegrity.us
            </a>
            .
          </p>
        </div>
      </section>

      {/* Campaign finance rules */}
      <section className="container pb-6 max-w-3xl space-y-3">
        <h2 className="font-display text-xl md:text-2xl font-semibold">
          Texas campaign-finance rules
        </h2>
        <p className="text-sm text-muted-foreground">
          Texas takes the opposite approach from most states: no contribution limits for state
          candidates, but strict source rules and disclosure. These are the rules that apply to
          the 2026 governor's race, per the{" "}
          <a
            href="https://www.ethics.state.tx.us/rules/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            Texas Ethics Commission
            <ExternalLink className="h-3 w-3" />
          </a>
          .
        </p>
      </section>

      <section className="container pb-6 max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Check className="h-4 w-4 text-success" />
            <span className="text-sm font-semibold">Allowed</span>
          </div>
          <ul className="space-y-2">
            {allowed.map((item) => (
              <li key={item} className="text-sm flex gap-2">
                <span className="text-success mt-0.5">+</span>
                <span className="text-muted-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <X className="h-4 w-4 text-destructive" />
            <span className="text-sm font-semibold">Not allowed</span>
          </div>
          <ul className="space-y-2">
            {notAllowed.map((item) => (
              <li key={item} className="text-sm flex gap-2">
                <span className="text-destructive mt-0.5">−</span>
                <span className="text-muted-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="container pb-6 max-w-3xl space-y-4">
        <h3 className="font-display text-lg font-semibold">Contribution limits — Governor</h3>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Contributor</th>
                <th className="text-right px-4 py-2 font-medium">Limit</th>
              </tr>
            </thead>
            <tbody>
              {govLimits.map((row) => (
                <tr key={row.who} className="border-t">
                  <td className="px-4 py-2.5">{row.who}</td>
                  <td className="px-4 py-2.5 text-right font-semibold">{row.limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-xs text-muted-foreground">
          Texas has no contribution limits for non-judicial candidates. Limits exist only in
          judicial races (under the Judicial Campaign Fairness Act) — they do not apply to the
          Governor's race.
        </p>
      </section>

      <section className="container pb-6 max-w-3xl space-y-4">
        <h3 className="font-display text-lg font-semibold">When reports are filed</h3>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Report</th>
                <th className="text-right px-4 py-2 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {disclosureSchedule.map((row) => (
                <tr key={row.report} className="border-t">
                  <td className="px-4 py-2.5">{row.report}</td>
                  <td className="px-4 py-2.5 text-right font-semibold">{row.due}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="text-xs text-muted-foreground">
          Statewide candidates file electronically with the Texas Ethics Commission; filings land
          in the public bulk data within a day.
        </p>
      </section>

      {/* FAQ Accordion */}
      <section className="container pb-16 max-w-3xl space-y-4">
        <h2 className="font-display text-xl md:text-2xl font-semibold">Common questions</h2>
        <Card className="px-4">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="q1">
              <AccordionTrigger className="text-sm text-left">
                How much can I personally give to a candidate for Governor?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                There is <strong className="text-foreground">no limit</strong>. Texas places no
                cap on contributions from individuals or PACs to candidates for non-judicial
                state office. Seven-figure personal checks are a routine feature of Texas
                governor's races — every dollar over the itemization threshold is disclosed.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q2">
              <AccordionTrigger className="text-sm text-left">
                Can corporations or unions give to candidates?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                No. Texas prohibits corporations and labor organizations from contributing to
                candidates or officeholders. They can, however, make unlimited direct campaign
                expenditures and fund committees that only make such expenditures.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q3">
              <AccordionTrigger className="text-sm text-left">
                What about Super PACs and outside spending?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Direct campaign expenditures — Texas's version of independent expenditures — are
                unlimited, as long as the spending happens without the candidate's prior consent.
                Each expenditure is reported with the candidate it benefits. See the{" "}
                <Link to="/money/outside-spending" className="text-primary hover:underline">
                  outside spending tracker
                </Link>{" "}
                for current activity.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q4">
              <AccordionTrigger className="text-sm text-left">
                When must contributions be disclosed?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Semiannual reports each <strong className="text-foreground">Jan 15</strong> and{" "}
                <strong className="text-foreground">Jul 15</strong>, 30-day and 8-day reports
                before each election, and daily reports of large contributions in the final
                stretch before election day.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q5">
              <AccordionTrigger className="text-sm text-left">
                Are there timing restrictions on giving?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Yes. Statewide officeholders and legislators can't accept contributions during
                the legislative-session moratorium (roughly 30 days before a regular session
                through 20 days after adjournment), and contributions can't be made or accepted
                in the Capitol.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q6">
              <AccordionTrigger className="text-sm text-left">
                Can candidates spend campaign money on themselves?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                No. Texas prohibits converting political contributions to personal use —
                expenses that would exist regardless of the campaign or officeholder duties.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q7">
              <AccordionTrigger className="text-sm text-left">
                Why do candidates have two filer accounts?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Texas candidates file under a candidate/officeholder account, but major campaigns
                typically raise through a principal specific-purpose committee — e.g. "Texans for
                Greg Abbott." This site combines both accounts per candidate so totals reflect
                the whole campaign.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="q8">
              <AccordionTrigger className="text-sm text-left">
                Where does this data come from?
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Contribution and expenditure data is sourced from the Texas Ethics Commission's
                daily bulk export of electronically filed campaign-finance reports, cross-checked
                against the TEC's own search totals.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </section>
    </div>
  );
}
