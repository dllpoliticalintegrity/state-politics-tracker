// Central registry of every state the tracker knows about. This module is
// the single source of truth for routing, the header switcher, the landing
// grid, and (later) per-state SEO and data-sync workflows — see docs/plan.md.

export type StateStatus =
  // Dashboard published on this site.
  | "live"
  // SLCF pipeline implemented upstream; data importable, dashboard not yet curated.
  | "ready"
  // No data pipeline yet.
  | "planned"
  // Tracked on a separate Political Integrity Project site; tiles link out.
  | "external";

export interface RaceConfig {
  /** URL segment: "governor", "attorney-general", "secretary-of-state"… */
  office: string;
  /** Display title: "Governor", "Attorney General"… */
  title: string;
  /** ISO date of the general election. */
  generalDate: string;
  /** Slug in the shared `races` polling table, e.g. "michigan-governor-2026". */
  raceSlug: string;
  /** 270toWin page, where public polling exists (mostly governor races). */
  pollingSourceUrl?: string;
}

export interface StateConfig {
  code: string; // lowercase two-letter code, used as the URL segment
  name: string;
  status: StateStatus;
  /**
   * Every tracked statewide race on the state's 2026 ballot — offices vary
   * per state. Required (non-empty) once status is "live". Races without
   * polling rank the field by money raised.
   */
  races?: RaceConfig[];
  /** The state's campaign-finance disclosure agency. */
  agency?: { name: string; url: string };
  /** Required when status is "external". */
  externalUrl?: string;
}

// States with a complete pipeline in hderyke/state-level-campaign-finance.
// (California is also implemented there, but stays "external" while
// ca-gov-polling remains the CA home.)
const SLCF_READY = new Set([
  "al", "ak", "az", "ar", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "pa",
]);

const EXTERNAL: Record<string, string> = {
  tx: "https://texaspoliticstracker.com",
  // TODO: swap for the CA site's production domain once confirmed.
  ca: "https://github.com/dllpoliticalintegrity/ca-gov-polling",
};

const ALL_STATES: Array<[string, string]> = [
  ["al", "Alabama"], ["ak", "Alaska"], ["az", "Arizona"], ["ar", "Arkansas"],
  ["ca", "California"], ["co", "Colorado"], ["ct", "Connecticut"],
  ["de", "Delaware"], ["fl", "Florida"], ["ga", "Georgia"], ["hi", "Hawaii"],
  ["id", "Idaho"], ["il", "Illinois"], ["in", "Indiana"], ["ia", "Iowa"],
  ["ks", "Kansas"], ["ky", "Kentucky"], ["la", "Louisiana"], ["me", "Maine"],
  ["md", "Maryland"], ["ma", "Massachusetts"], ["mi", "Michigan"],
  ["mn", "Minnesota"], ["ms", "Mississippi"], ["mo", "Missouri"],
  ["mt", "Montana"], ["ne", "Nebraska"], ["nv", "Nevada"],
  ["nh", "New Hampshire"], ["nj", "New Jersey"], ["nm", "New Mexico"],
  ["ny", "New York"], ["nc", "North Carolina"], ["nd", "North Dakota"],
  ["oh", "Ohio"], ["ok", "Oklahoma"], ["or", "Oregon"],
  ["pa", "Pennsylvania"], ["ri", "Rhode Island"], ["sc", "South Carolina"],
  ["sd", "South Dakota"], ["tn", "Tennessee"], ["tx", "Texas"],
  ["ut", "Utah"], ["vt", "Vermont"], ["va", "Virginia"],
  ["wa", "Washington"], ["wv", "West Virginia"], ["wi", "Wisconsin"],
  ["wy", "Wyoming"],
];

// Pilot states live since July 2026: polling synced from 270toWin via the
// import-towin-polling-multi edge function; finance lands via the SLCF
// importer. Down-ballot races get added here as their candidates are curated.
const LIVE_CONFIG: Record<string, Pick<StateConfig, "races" | "agency">> = {
  fl: {
    agency: {
      name: "Florida Division of Elections",
      url: "https://dos.fl.gov/elections/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "florida-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/florida",
      },
      {
        office: "attorney-general",
        title: "Attorney General",
        generalDate: "2026-11-03",
        raceSlug: "florida-attorney-general-2026",
      },
      {
        office: "cfo",
        title: "CFO",
        generalDate: "2026-11-03",
        raceSlug: "florida-cfo-2026",
      },
      {
        office: "agriculture-commissioner",
        title: "Agriculture Commissioner",
        generalDate: "2026-11-03",
        raceSlug: "florida-agriculture-commissioner-2026",
      },
    ],
  },
  mi: {
    agency: {
      name: "Michigan Dept. of State — Campaign Finance",
      url: "https://www.michigan.gov/sos/elections/disclosure",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "michigan-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/michigan",
      },
      {
        office: "attorney-general",
        title: "Attorney General",
        generalDate: "2026-11-03",
        raceSlug: "michigan-attorney-general-2026",
      },
      {
        office: "secretary-of-state",
        title: "Secretary of State",
        generalDate: "2026-11-03",
        raceSlug: "michigan-secretary-of-state-2026",
      },
    ],
  },
  ga: {
    agency: {
      name: "Georgia Government Transparency & Campaign Finance Commission",
      url: "https://ethics.ga.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "georgia-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/georgia",
      },
      {
        office: "lt-governor",
        title: "Lt. Governor",
        generalDate: "2026-11-03",
        raceSlug: "georgia-lt-governor-2026",
      },
      {
        office: "attorney-general",
        title: "Attorney General",
        generalDate: "2026-11-03",
        raceSlug: "georgia-attorney-general-2026",
      },
      {
        office: "secretary-of-state",
        title: "Secretary of State",
        generalDate: "2026-11-03",
        raceSlug: "georgia-secretary-of-state-2026",
      },
    ],
  },
};

const LIVE_CONFIG_2: Record<string, Pick<StateConfig, "races" | "agency">> = {
  az: {
    agency: {
      name: "Arizona Secretary of State — See The Money",
      url: "https://seethemoney.az.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "arizona-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/arizona",
      },
      {
        office: "attorney-general",
        title: "Attorney General",
        generalDate: "2026-11-03",
        raceSlug: "arizona-attorney-general-2026",
      },
      {
        office: "secretary-of-state",
        title: "Secretary of State",
        generalDate: "2026-11-03",
        raceSlug: "arizona-secretary-of-state-2026",
      },
    ],
  },
  // Kentucky elects statewide officers in odd years — its 2026 statewide race
  // (US Senate) is federal and out of scope, so the dashboard tracks the 2027
  // governor's race, where fundraising is already underway.
  ky: {
    agency: {
      name: "Kentucky Registry of Election Finance",
      url: "https://kref.ky.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2027-11-02",
        raceSlug: "kentucky-governor-2027",
      },
    ],
  },
  // Maine's governor is its only elected statewide executive (SoS/AG/Treasurer
  // are chosen by the legislature), so one race is full coverage. Finance is
  // pending: the Maine disclosure system's WAF blocks datacenter IPs.
  me: {
    agency: {
      name: "Maine Ethics Commission",
      url: "https://www.maine.gov/ethics/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "maine-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/maine",
      },
    ],
  },
};
// Wave 3 (Aug 2026): the bulk-open-data states — governor races first,
// down-ballot to follow as candidates are curated. Polling URLs are set only
// where 270toWin actually lists polls for the race.
const LIVE_CONFIG_3: Record<string, Pick<StateConfig, "races" | "agency">> = {
  pa: {
    agency: {
      name: "Pennsylvania Dept. of State — Campaign Finance",
      url: "https://www.pa.gov/agencies/dos/programs/voting-and-elections/campaign-finance.html",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "pennsylvania-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/pennsylvania",
      },
    ],
  },
  ma: {
    agency: {
      name: "Massachusetts Office of Campaign & Political Finance",
      url: "https://www.ocpf.us/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "massachusetts-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/massachusetts",
      },
    ],
  },
  mn: {
    agency: {
      name: "Minnesota Campaign Finance Board",
      url: "https://cfb.mn.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "minnesota-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/minnesota",
      },
    ],
  },
  co: {
    agency: {
      name: "Colorado Secretary of State — TRACER",
      url: "https://tracer.sos.colorado.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin lists only primary polls for CO so far — no general H2H
        // to average yet; the race ranks by money until that changes.
        raceSlug: "colorado-governor-2026",
      },
    ],
  },
  ia: {
    agency: {
      name: "Iowa Ethics & Campaign Disclosure Board",
      url: "https://webapp.iecdb.iowa.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "iowa-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/iowa",
      },
    ],
  },
  md: {
    agency: {
      name: "Maryland State Board of Elections — MDCRIS",
      url: "https://campaignfinance.maryland.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin has no Maryland governor polls page (verified Jul 2026) —
        // the race ranks by money until public polling appears.
        raceSlug: "maryland-governor-2026",
      },
    ],
  },
  hi: {
    agency: {
      name: "Hawaii Campaign Spending Commission",
      url: "https://ags.hawaii.gov/campaign/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // No public polling exists for this race (270toWin has no HI page).
        raceSlug: "hawaii-governor-2026",
      },
    ],
  },
  oh: {
    agency: {
      name: "Ohio Secretary of State — Campaign Finance",
      url: "https://campaignfinance.ohiosos.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "ohio-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/ohio",
      },
    ],
  },
  wi: {
    agency: {
      name: "Wisconsin Ethics Commission — CFIS",
      url: "https://cfis.wi.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "wisconsin-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/wisconsin",
      },
    ],
  },
  nv: {
    agency: {
      name: "Nevada Secretary of State — Aurora",
      url: "https://www.nvsos.gov/sos/online-services/campaign-finance-disclosure",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "nevada-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/nevada",
      },
    ],
  },
};
// Wave 5 (Aug 2026): the last seven SLCF-ready states, all with 2026
// governor races. Polling URLs only where 270toWin lists general-election
// polls (AR/ID have no page; IL/KS list primary polls only so far).
const LIVE_CONFIG_4: Record<string, Pick<StateConfig, "races" | "agency">> = {
  al: {
    agency: {
      name: "Alabama Secretary of State — FCPA",
      url: "https://fcpa.alabamavotes.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "alabama-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/alabama",
      },
    ],
  },
  ak: {
    agency: {
      name: "Alaska Public Offices Commission",
      url: "https://aws.state.ak.us/ApocReports/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "alaska-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/alaska",
      },
    ],
  },
  ar: {
    agency: {
      name: "Arkansas Secretary of State — Financial Disclosure",
      url: "https://ethics-disclosures.sos.arkansas.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin has no Arkansas governor polls page (verified Aug 2026).
        raceSlug: "arkansas-governor-2026",
      },
    ],
  },
  ct: {
    agency: {
      name: "Connecticut State Elections Enforcement Commission — eCRIS",
      url: "https://seec.ct.gov/Portal/eCRIS/eCRISlanding",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "connecticut-governor-2026",
        pollingSourceUrl: "https://www.270towin.com/2026-governor-polls/connecticut",
      },
    ],
  },
  id: {
    agency: {
      name: "Idaho Secretary of State — Sunshine",
      url: "https://sunshine.voteidaho.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin has no Idaho governor polls page (verified Aug 2026).
        raceSlug: "idaho-governor-2026",
      },
    ],
  },
  il: {
    agency: {
      name: "Illinois State Board of Elections",
      url: "https://elections.il.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin lists only a GOP-primary poll for IL so far — no general
        // H2H to average yet; the race ranks by money until that changes.
        raceSlug: "illinois-governor-2026",
      },
    ],
  },
  ks: {
    agency: {
      name: "Kansas Public Disclosure Commission",
      url: "https://kpdc.kansas.gov/",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        // 270toWin lists only a Dem-primary poll for KS so far (primary was
        // Aug 4, 2026) — add the polling URL when general polls appear.
        raceSlug: "kansas-governor-2026",
      },
    ],
  },
};
Object.assign(LIVE_CONFIG, LIVE_CONFIG_2, LIVE_CONFIG_3, LIVE_CONFIG_4);

export const STATES: StateConfig[] = ALL_STATES.map(([code, name]) => ({
  code,
  name,
  status: EXTERNAL[code]
    ? "external"
    : LIVE_CONFIG[code]
      ? "live"
      : SLCF_READY.has(code)
        ? "ready"
        : "planned",
  externalUrl: EXTERNAL[code],
  ...LIVE_CONFIG[code],
}));

const byCode = new Map(STATES.map((s) => [s.code, s]));

export function getState(code: string | undefined): StateConfig | undefined {
  return code ? byCode.get(code.toLowerCase()) : undefined;
}

export const liveStates = () => STATES.filter((s) => s.status === "live");
