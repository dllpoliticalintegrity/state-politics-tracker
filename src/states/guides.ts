// Per-state reference content for the About page: how the state's finance
// data is assembled, and a plain-English guide to its campaign-finance rules
// (with FAQ structured data). The page layout is shared; only this content
// differs by state, so a state gains a rules guide by adding an entry here.
//
// Texas's guide moved here from the Texas Politics Tracker's About page when
// Texas joined the hub (Oct 2026); California's from cagovtracker.com's FAQ
// page when California did.

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
    /** Further two-column tables, after the limits and the schedule. */
    tables?: { title: string; head: [string, string]; rows: [string, string][]; note?: string }[];
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
  // California: limits and ceilings for 2025–26 per the FPPC.
  ca: {
    financeSource:
      "nightly CAL-ACCESS bulk export of electronically filed reports (Forms 460, 461, 496 and 497). Each filing counts at its latest amendment; late-contribution reports (Form 497) are dropped once the candidate's next Form 460 covers the same dates, and unitemized small gifts are added from each Form 460's summary page.",
    methodology: [
      "Outside spending is built from independent-expenditure reports (Forms 496, 461 and 460) naming the candidate supported or opposed, plus the committees primarily formed to support or oppose one candidate. Money raised by those committees is shown once per transaction, however many later reports restate it.",
      "California's primary is top-two: every candidate runs on one ballot and the two leaders advance regardless of party, so the general can be a same-party race. Primary-season money stays in each candidate's totals.",
    ],
    rules: {
      heading: "California campaign-finance rules",
      intro:
        "California limits how much money can flow to candidates for state office. These are the rules that apply to the 2026 governor's race, per the",
      sourceUrl:
        "https://www.fppc.ca.gov/learn/campaign-rules/state-contribution-limits-and-voluntary-expenditure-ceilings/",
      sourceName: "Fair Political Practices Commission",
      allowed: [
        "Individuals donating up to $39,200 per election to a Governor candidate",
        "Political parties making unlimited contributions to candidates",
        "Independent expenditures by Super PACs (no contribution limit when not coordinated)",
        "Ballot measure committees accepting unlimited contributions",
        "Candidates voluntarily accepting expenditure ceilings in exchange for ballot statement space",
        "Small Contributor Committees aggregating $200/yr donations from 100+ people",
      ],
      notAllowed: [
        "An individual giving more than $39,200 to a Governor candidate per election",
        "A PAC giving more than $9,800/year to another PAC that funds state candidates",
        "A state candidate transferring more than $5,900 to another state candidate's committee",
        "Coordinating spending between a candidate and an 'independent' expenditure committee",
        "Aggregating contributions from affiliated entities to bypass per-source limits",
        "Using legal defense funds for amounts beyond what is reasonably necessary",
      ],
      limits: {
        title: "Contribution limits — Governor (per election)",
        rows: [
          { who: "Individual / business / PAC", limit: "$39,200" },
          { who: "Small Contributor Committee", limit: "$39,200" },
          { who: "Political party", limit: "No limit" },
        ],
        note: "Primary, general, special, and special run-off elections are each treated as separate elections.",
      },
      tables: [
        {
          title: "Limits on giving to other committees (per calendar year)",
          head: ["Committee", "Limit from any person"],
          rows: [
            ["PAC contributing to state candidates", "$9,800 / yr"],
            ["Political party account for state candidates", "$49,000 / yr"],
            ["Small Contributor Committee", "$200 / yr"],
            ["Ballot measure / non-candidate PAC", "No limit*"],
          ],
          note: "*State PACs and parties may accept contributions over the limit only if they are not used for state candidate contributions.",
        },
        {
          title: "Voluntary expenditure ceiling — Governor",
          head: ["Election", "Ceiling"],
          rows: [
            ["Primary", "$11,767,000"],
            ["General", "$19,611,000"],
          ],
        },
      ],
    },
    faq: [
      {
        q: "How much can I personally give to a candidate for Governor?",
        a: "Up to $39,200 per election. Since the primary and general are separate elections, an individual can give up to $78,400 total across the 2026 cycle.",
      },
      {
        q: "Are there any contributions with no limit?",
        a: "Yes. Political parties can give unlimited amounts to candidates. Ballot measure committees, legal defense funds, and committees opposing a recall can also accept unlimited contributions.",
      },
      {
        q: "What about Super PACs and outside spending?",
        a: "Independent expenditure committees (Super PACs) can raise and spend unlimited money supporting or opposing candidates — as long as that spending is not coordinated with the candidate's campaign.",
      },
      {
        q: "Can a candidate transfer money to another candidate?",
        a: "A state candidate or officeholder may not contribute more than $5,900 per election to a committee controlled by another state candidate, including from personal or campaign funds.",
      },
      {
        q: "What is the voluntary expenditure ceiling?",
        a: "Candidates can voluntarily cap their own spending in exchange for a 250-word statement in the official ballot pamphlet. For Governor, the ceiling is $11.77M for the primary and $19.61M for the general.",
      },
      {
        q: "What is a Small Contributor Committee?",
        a: "A committee that has existed for 6+ months, receives donations from 100+ people, accepts no more than $200/year from any single person, and contributes to 5+ candidates. SCCs can give the same $39,200 limit as individuals to gubernatorial candidates.",
      },
      {
        q: "Are contributions from affiliated companies counted separately?",
        a: "No — contributions from affiliated entities are aggregated for the limit. You cannot bypass the cap by routing donations through subsidiaries or related LLCs.",
      },
      {
        q: "Where does this data come from?",
        a: "All limits are published by the California Fair Political Practices Commission (FPPC). Contribution data on this site is sourced from CAL-ACCESS filings (Forms 460, 461, 496 and 497).",
      },
    ],
  },
};

export function stateGuide(code: string): StateGuide | undefined {
  return STATE_GUIDES[code];
}
