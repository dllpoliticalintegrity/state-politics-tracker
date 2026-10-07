// Per-state reference content for the About page: how the state's finance
// data is assembled, and a plain-English guide to its campaign-finance rules
// (with FAQ structured data). The page layout is shared; only this content
// differs by state, so a state gains a rules guide by adding an entry here.
//
// Texas's guide moved here from the Texas Politics Tracker's About page when
// Texas joined the hub (Oct 2026).

export type StateGuide = {
  /** Replaces the generic "normalized through state-level-campaign-finance" line. */
  financeSource?: string;
  /** Extra methodology paragraphs under "Where the data comes from". */
  methodology?: string[];
  rules?: {
    heading: string;
    intro: string;
    sourceUrl: string;
    sourceName: string;
    allowed: string[];
    notAllowed: string[];
    limits?: { title: string; rows: { who: string; limit: string }[]; note?: string };
    schedule?: { rows: { report: string; due: string }[]; note?: string };
  };
  faq?: { q: string; a: string }[];
};

export const STATE_GUIDES: Record<string, StateGuide> = {
  tx: {
    financeSource:
      "daily bulk export of electronically filed reports. Each candidate's totals combine their candidate/officeholder account with their principal specific-purpose committee (for example, \"Texans for Greg Abbott\"), so the numbers reflect the whole campaign. Superseded reports are excluded.",
    methodology: [
      "Outside spending is built from TEC direct-campaign-expenditure filings — Texas's version of independent expenditures — reported with the candidate each expenditure supports or opposes.",
      "Special pre-election (\"daily\") reports are counted as soon as they are filed and dropped once the candidate's next regular report re-lists the same transactions, so nothing is counted twice.",
    ],
    rules: {
      heading: "Texas campaign-finance rules",
      intro:
        "Texas takes the opposite approach from most states: no contribution limits for state candidates, but strict source rules and disclosure. These are the rules that apply to the 2026 statewide races, per the",
      sourceUrl: "https://www.ethics.state.tx.us/rules/",
      sourceName: "Texas Ethics Commission",
      allowed: [
        "Individuals donating any amount to a statewide candidate (fully disclosed)",
        "PACs and political parties making unlimited contributions to candidates",
        "Unlimited direct campaign expenditures (independent spending) by outside groups",
        "Corporations and unions funding PACs that only make direct campaign expenditures",
        "Candidates self-funding or lending their own campaign without limit",
        "Out-of-state PAC contributions (with extra paperwork identifying the donor PAC)",
      ],
      notAllowed: [
        "A corporation or labor union contributing to a candidate or officeholder",
        "Contributions made in another person's name",
        "Cash contributions totaling more than $100 from one person per reporting period",
        "Coordinating 'independent' spending with the benefited candidate's campaign",
        "Accepting contributions in the Capitol, or during the legislative-session moratorium",
        "Converting campaign funds to personal use",
      ],
      limits: {
        title: "Contribution limits — statewide races",
        rows: [
          { who: "Individual", limit: "No limit" },
          { who: "PAC (general-purpose committee)", limit: "No limit" },
          { who: "Political party", limit: "No limit" },
          { who: "Corporation / labor union", limit: "Prohibited" },
        ],
        note:
          "Texas has no contribution limits for non-judicial candidates. Limits exist only in judicial races (under the Judicial Campaign Fairness Act) — they do not apply to the races tracked here.",
      },
      schedule: {
        rows: [
          { report: "Semiannual report", due: "Jan 15 & Jul 15" },
          { report: "30-day pre-election report", due: "30 days before election" },
          { report: "8-day pre-election report", due: "8 days before election" },
          { report: "Daily report (large late gifts)", due: "Final 9 days before election" },
        ],
        note:
          "Statewide candidates file electronically with the Texas Ethics Commission; filings land in the public bulk data within a day.",
      },
    },
    faq: [
      {
        q: "How much can I personally give to a candidate for Governor?",
        a: "There is no limit. Texas places no cap on contributions from individuals or PACs to candidates for non-judicial state office, including Governor. Every contribution over the itemization threshold must be publicly disclosed to the Texas Ethics Commission.",
      },
      {
        q: "Can corporations or unions give to candidates?",
        a: "No. Texas prohibits corporations and labor organizations from contributing to candidates or officeholders. They may, however, make unlimited direct campaign expenditures (independent spending) and contribute to committees that only make such expenditures.",
      },
      {
        q: "What about Super PACs and outside spending?",
        a: "Direct campaign expenditures — Texas's version of independent expenditures — are unlimited, as long as the spending happens without the candidate's prior consent or approval. Each expenditure is reported to the TEC with the candidate it benefits.",
      },
      {
        q: "When must contributions be disclosed?",
        a: "Candidates file semiannual reports each January 15 and July 15, 30-day and 8-day reports before each election, and daily reports of large contributions received in the last days before an election.",
      },
      {
        q: "Are there timing restrictions on giving?",
        a: "Yes. Statewide officeholders and legislators may not accept political contributions during the legislative-session moratorium (roughly 30 days before a regular session through 20 days after adjournment), and contributions may not be made or accepted in the Capitol.",
      },
      {
        q: "Can candidates spend campaign money on themselves?",
        a: "No. Texas prohibits converting political contributions to personal use — expenses that would exist regardless of the campaign or officeholder duties.",
      },
      {
        q: "Why do candidates have two filer accounts?",
        a: "Texas candidates file under a candidate/officeholder account, but major campaigns typically raise through a principal specific-purpose committee — e.g. \"Texans for Greg Abbott.\" This site combines both accounts per candidate so totals reflect the whole campaign.",
      },
      {
        q: "Are political contributions tax-deductible?",
        a: "No. Political contributions are not deductible on federal income taxes, and Texas has no state income tax.",
      },
      {
        q: "Where does this data come from?",
        a: "Contribution and expenditure data on this site is sourced from the Texas Ethics Commission's daily bulk export of electronically filed campaign-finance reports.",
      },
    ],
  },
};

export function stateGuide(code: string): StateGuide | undefined {
  return STATE_GUIDES[code];
}
