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

/**
 * Where a race's polling comes from — the `source` key its importer writes
 * on race_polling / race_polls rows. 270toWin (import-towin-polling-multi)
 * covers every state but Texas; Texas's governor race is fed by FiftyPlusOne
 * (import-fiftyplusone-polling, from the tx-politics-tracker repo). Both
 * importers write the same row shapes, so only the key and the label differ.
 */
export type PollingSourceKey = "270towin" | "fiftyplusone";

export const POLLING_SOURCES: Record<PollingSourceKey, { label: string }> = {
  "270towin": { label: "270toWin" },
  fiftyplusone: { label: "FiftyPlusOne" },
};

export interface RaceConfig {
  /** URL segment: "governor", "attorney-general", "secretary-of-state"… */
  office: string;
  /** Display title: "Governor", "Attorney General"… */
  title: string;
  /** ISO date of the general election. */
  generalDate: string;
  /** Slug in the shared `races` polling table, e.g. "michigan-governor-2026". */
  raceSlug: string;
  /**
   * Public page of the race's polling source, where public polling exists
   * (mostly governor races). Its presence is what turns the polling sections
   * on.
   */
  pollingSourceUrl?: string;
  /** Which importer's rows to read; defaults to 270toWin. */
  pollingSource?: PollingSourceKey;
  /**
   * Set on the per-district races synthesized from a ChamberConfig (see
   * districtRace): the district number as it appears in the URL and in
   * cf_candidates.district. Statewide races leave it undefined.
   */
  district?: string;
}

/**
 * A legislative chamber tracked as a set of district races: finance only
 * (no polling), rosters built nightly from the state's committee registry
 * by the finance importer, one dashboard per district at
 * /:state/:office/:district. The chamber page at /:state/:office lists
 * every district.
 */
export interface ChamberConfig {
  /** URL segment: "state-senate", "state-house". */
  office: string;
  /** "State Senate", "State House". */
  title: string;
  /** Number of districts, numbered 1..districts. */
  districts: number;
  /** ISO date of the general election. */
  generalDate: string;
  /**
   * Static GeoJSON of the district boundaries (FeatureCollection whose
   * features carry `properties.district`), served from public/maps —
   * Census TIGERweb 2024 legislative districts, simplified. Optional: the
   * chamber overview renders a map when set.
   */
  map?: string;
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
  /** Legislative chambers tracked district by district (finance only). */
  chambers?: ChamberConfig[];
  /** The state's campaign-finance disclosure agency. */
  agency?: { name: string; url: string };
  /** Required when status is "external". */
  externalUrl?: string;
  /**
   * Paths of the state's dedicated site that predate the hub layout, mapped
   * to their hub-layout path (both prefix-less, as on the dedicated site).
   * The Worker 301s them and the SPA redirects them, so old links and search
   * results keep landing. Old candidate profiles (/candidates/:slug) resolve
   * through the state-level candidate route instead, which knows the race.
   */
  legacyPaths?: Record<string, string>;
}

// States with a complete pipeline in hderyke/state-level-campaign-finance.
// (California is also implemented there, but stays "external" while
// ca-gov-polling remains the CA home.)
const SLCF_READY = new Set([
  "al", "ak", "az", "ar", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "pa",
]);

// Texas was external too until Oct 2026 (texaspoliticstracker.com was a fork
// of this codebase's ancestor); it is now a live state whose data the TEC
// importer stages in tx_* and publish_texas_to_cf() copies into cf_* — see
// docs/plan.md, "Texas joins the hub".
const EXTERNAL: Record<string, string> = {
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
const LIVE_CONFIG: Record<string, Pick<StateConfig, "races" | "agency" | "chambers">> = {
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
    // Legislature (Sep 2026): finance only. Rosters are the active candidate
    // committees MiTN lists for "State Senator" / "Representative in State
    // Legislature", refreshed nightly by import_pilot_finance.py; all 38
    // Senate and 110 House seats are on the 2026 ballot.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 38, generalDate: "2026-11-03", map: "/maps/mi-state-senate.json" },
      { office: "state-house", title: "State House", districts: 110, generalDate: "2026-11-03", map: "/maps/mi-state-house.json" },
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
        // 270toWin removed its Alaska page on 2026-09-01 (the URL now
        // redirects to the generic governor-polls hub), so the race ranks by
        // money until public polling reappears. Restore pollingSourceUrl and
        // the RACES entry in import-towin-polling-multi if it comes back.
        raceSlug: "alaska-governor-2026",
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
// Texas (Oct 2026): moved in from its own site. Finance is the TEC bulk
// import (tx-politics-tracker repo) published into cf_* nightly; polling is
// FiftyPlusOne, not 270toWin. Primaries were Mar 3 with May 26 runoffs.
const LIVE_CONFIG_TX: Record<string, Pick<StateConfig, "races" | "agency" | "legacyPaths">> = {
  tx: {
    agency: {
      name: "Texas Ethics Commission",
      url: "https://www.ethics.state.tx.us/search/cf/",
    },
    // texaspoliticstracker.com's URLs before it moved onto this codebase:
    // governor pages lived at the root, the down-ballot races on /statewide.
    legacyPaths: {
      "/candidates": "/governor/candidates",
      "/polling": "/governor/polling",
      "/money": "/governor/money/donors",
      "/money/donors": "/governor/money/donors",
      "/money/outside-spending": "/governor/money/outside-spending",
      "/money/river": "/governor/money/river",
      "/statewide": "/lt-governor",
      "/top-donors": "/governor/money/donors",
      "/independent-expenditures": "/governor/money/outside-spending",
      "/faq": "/about",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "texas-governor-2026",
        pollingSource: "fiftyplusone",
        pollingSourceUrl: "https://fiftyplusone.news/polls/governor/general/texas",
      },
      {
        office: "lt-governor",
        title: "Lt. Governor",
        generalDate: "2026-11-03",
        raceSlug: "texas-lt-governor-2026",
      },
      {
        office: "attorney-general",
        title: "Attorney General",
        generalDate: "2026-11-03",
        raceSlug: "texas-attorney-general-2026",
      },
    ],
  },
};
Object.assign(LIVE_CONFIG, LIVE_CONFIG_2, LIVE_CONFIG_3, LIVE_CONFIG_4, LIVE_CONFIG_TX);

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

/**
 * Where an old dedicated-site path now lives, or null. `pathname` is the
 * prefix-less path on that state's own site; a trailing slash is ignored.
 */
export function legacyRedirect(state: Pick<StateConfig, "legacyPaths"> | null | undefined, pathname: string): string | null {
  if (!state?.legacyPaths) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return state.legacyPaths[path] ?? null;
}

/** The importer key a race's polling rows carry. */
export function pollingSourceKey(race: Pick<RaceConfig, "pollingSource">): PollingSourceKey {
  return race.pollingSource ?? "270towin";
}

/** "270toWin", "FiftyPlusOne" — for source credits next to polling. */
export function pollingSourceLabel(race: Pick<RaceConfig, "pollingSource">): string {
  return POLLING_SOURCES[pollingSourceKey(race)].label;
}

/**
 * The polling sources a state's polled races use, joined for prose ("270toWin",
 * "FiftyPlusOne"). Null when none of its races is polled.
 */
export function statePollingLabel(state: Pick<StateConfig, "races">): string | null {
  const labels = [
    ...new Set((state.races ?? []).filter((r) => r.pollingSourceUrl).map(pollingSourceLabel)),
  ];
  return labels.length ? labels.join(" and ") : null;
}

/** The chamber a state tracks under this office segment, if any. */
export function getChamber(state: StateConfig, office: string | undefined): ChamberConfig | undefined {
  return office ? state.chambers?.find((c) => c.office === office) : undefined;
}

/** "11" → true for a chamber with 38 districts; rejects "0", "011", "abc". */
export function isValidDistrict(chamber: ChamberConfig, district: string | undefined): boolean {
  if (!district || !/^[1-9]\d*$/.test(district)) return false;
  const n = Number(district);
  return n >= 1 && n <= chamber.districts;
}

/**
 * The RaceConfig for one district of a chamber — what the race-scoped pages
 * and hooks consume, so a district dashboard is the ordinary race dashboard
 * with `district` set (no polling: pollingSourceUrl stays undefined).
 */
export function districtRace(state: StateConfig, chamber: ChamberConfig, district: string): RaceConfig {
  return {
    office: chamber.office,
    title: `${chamber.title} District ${district}`,
    generalDate: chamber.generalDate,
    raceSlug: `${state.name.toLowerCase().replace(/\s+/g, "-")}-${chamber.office}-${district}-${chamber.generalDate.slice(0, 4)}`,
    district,
  };
}

/** Every district of a chamber, 1..n as strings. */
export function chamberDistricts(chamber: ChamberConfig): string[] {
  return Array.from({ length: chamber.districts }, (_, i) => String(i + 1));
}
