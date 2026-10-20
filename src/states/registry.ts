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
 * on race_polling / race_polls rows. Every race is polled by FiftyPlusOne
 * (supabase/functions/import-fiftyplusone-polling-multi) since Oct 2026; the
 * 270toWin scrape it replaced left its rows under source '270towin', which
 * nothing reads any more. A second source would be a new key here.
 */
export type PollingSourceKey = "fiftyplusone" | "lpt";

export const POLLING_SOURCES: Record<PollingSourceKey, { label: string }> = {
  fiftyplusone: { label: "FiftyPlusOne" },
  // The Local Politics Tracker's own poll table (one row per poll, no
  // aggregate); the site averages the most recent polls itself — src/lib/lpt.ts.
  lpt: { label: "Local Politics Tracker" },
};

/** A race's page on statemoney.us, the Local Politics Tracker's own site. */
function lptRace(state: string, slug: string): string {
  return `https://statemoney.us/${state}/races/${slug}`;
}

/** A race's FiftyPlusOne page: "Florida" → …/polls/governor/general/florida. */
function fpoGovernor(stateName: string): string {
  return `https://fiftyplusone.news/polls/governor/general/${stateName.toLowerCase().replace(/ /g, "-")}`;
}

export interface RaceConfig {
  /** URL segment: "governor", "attorney-general", "secretary-of-state"… */
  office: string;
  /** Display title: "Governor", "Attorney General"… */
  title: string;
  /**
   * Shorter label for the site menu, where every race shares one row: Arizona
   * has seven statewide races, and the full "Superintendent of Public
   * Instruction" pushed About off the end of the desktop menu (2026-10-19).
   * Pages keep `title`.
   */
  navLabel?: string;
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
  /** Which importer's rows to read; defaults to FiftyPlusOne. */
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
  /**
   * Districts on this cycle's ballot, when only some are (staggered senates:
   * TX, FL, OH, OR, WI, AK). Unset = every district 1..districts. Overviews,
   * sitemaps and district lists use these; the map greys the rest.
   */
  seatsUp?: number[];
}

/**
 * Which database a live state's pages read. "tracker" is the site's own
 * project (cf_* tables); "lpt" is the Local Politics Tracker project behind
 * statemoney.us, the unified store every state is moving to one at a time —
 * see docs/lpt-frontend-plan.md. Every data hook dispatches on this.
 */
export type DataSource = "lpt" | "tracker";

export interface StateConfig {
  code: string; // lowercase two-letter code, used as the URL segment
  name: string;
  status: StateStatus;
  /** Where the state's data is read from. Always set; "tracker" until a state is checked on LPT. */
  source: DataSource;
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
// (California is also implemented there, but is live on its own CAL-ACCESS
// importer instead — see LIVE_CONFIG_CA.)
const SLCF_READY = new Set([
  "al", "ak", "az", "ar", "co", "ct", "de", "fl", "ga", "hi", "id", "il",
  "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "pa",
]);

// States whose pages read the Local Politics Tracker project. A state moves
// here only while the tracker has no rows for it (docs/lpt-frontend-plan.md).
// The tracker project is the unified store: every state reads it as soon as
// its own pipeline reconciles. OR reads Henry's tables until its ORESTAR
// scrape lands in the tracker. Iowa moved to the tracker on 2026-10-19 once
// its SLCF load and LPT roster landed there (same candidates and statuses
// per race, raised as current or newer, all statewide headshots; the admin
// console's photos only reach the site from the tracker). VITE_LPT_STATES
// ("or,ia") overrides the set at build time, for previews and local checks.
const LPT_STATES: Set<string> = new Set(
  ((import.meta.env?.VITE_LPT_STATES as string | undefined) ?? "or")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// The site covers the statemoney.us states plus Michigan, California and
// Iowa (decided 2026-10-18). These states have dashboards and nightly imports but
// are hidden from the hub for now: their tiles read "coming soon" and their
// routes render the coming-soon page. Their pipelines keep running, so
// un-hiding one is a one-line change.
const HIDDEN: Set<string> = new Set([
  "al", "ar", "co", "ct", "hi", "id", "il", "ks", "ky", "ma", "md", "me", "mn", "nv", "pa",
]);

// States tracked on a separate site, whose tiles link out. Empty since Oct
// 2026: Texas and California both had their own sites (texaspoliticstracker.com,
// cagovtracker.com) and are now live states here, their data staged by their
// own importers and published into cf_* — see docs/plan.md, "Texas joins the
// hub" and "California joins the hub".
const EXTERNAL: Record<string, string> = {};

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

// Pilot states live since July 2026: polling synced from FiftyPlusOne via the
// import-fiftyplusone-polling-multi edge function (270toWin until Oct 2026);
// finance lands via the SLCF importer. Down-ballot races get added here as their candidates are curated.
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
        pollingSourceUrl: fpoGovernor("Florida"),
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
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 40, generalDate: "2026-11-03", map: "/maps/fl-state-senate.json", seatsUp: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40] },
      { office: "state-house", title: "State House", districts: 120, generalDate: "2026-11-03", map: "/maps/fl-state-house.json" },
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
        pollingSourceUrl: fpoGovernor("Michigan"),
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
        pollingSourceUrl: fpoGovernor("Georgia"),
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
      // Down-ballot statewide races (Oct 2026): candidates from the Local Politics
      // Tracker (states.json lpt_statewide; LPT's office for Insurance Commissioner
      // is renamed in roster.py LPT_OFFICE). The Public Service Commission has no
      // ballot list in LPT, so its whole field shows.
      { office: "superintendent-of-education", title: "School Superintendent", generalDate: "2026-11-03", raceSlug: "georgia-superintendent-of-education-2026" },
      { office: "insurance-commissioner", title: "Insurance Commissioner", generalDate: "2026-11-03", raceSlug: "georgia-insurance-commissioner-2026" },
      { office: "agriculture-commissioner", title: "Agriculture Commissioner", generalDate: "2026-11-03", raceSlug: "georgia-agriculture-commissioner-2026" },
      { office: "labor-commissioner", title: "Labor Commissioner", generalDate: "2026-11-03", raceSlug: "georgia-labor-commissioner-2026" },
      { office: "public-service-commissioner", title: "Public Service Commission", generalDate: "2026-11-03", raceSlug: "georgia-public-service-commissioner-2026" },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 56, generalDate: "2026-11-03", map: "/maps/ga-state-senate.json" },
      { office: "state-house", title: "State House", districts: 180, generalDate: "2026-11-03", map: "/maps/ga-state-house.json" },
    ],
  },
};

const LIVE_CONFIG_2: Record<string, Pick<StateConfig, "races" | "agency" | "chambers">> = {
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
        pollingSourceUrl: fpoGovernor("Arizona"),
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
      // Down-ballot statewide races (Oct 2026): candidates from the Local Politics
      // Tracker (states.json lpt_statewide). The Corporation Commission elects two
      // seats; LPT has no ballot list for it, so its whole field shows.
      { office: "treasurer", title: "Treasurer", generalDate: "2026-11-03", raceSlug: "arizona-treasurer-2026" },
      { office: "superintendent-of-education", title: "Superintendent of Public Instruction", navLabel: "Superintendent", generalDate: "2026-11-03", raceSlug: "arizona-superintendent-of-education-2026" },
      { office: "corporation-commissioner", title: "Corporation Commission", generalDate: "2026-11-03", raceSlug: "arizona-corporation-commissioner-2026" },
      { office: "mine-inspector", title: "Mine Inspector", generalDate: "2026-11-03", raceSlug: "arizona-mine-inspector-2026" },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 30, generalDate: "2026-11-03", map: "/maps/az-state-senate.json" },
      { office: "state-house", title: "State House", districts: 30, generalDate: "2026-11-03", map: "/maps/az-state-house.json" },
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
        pollingSourceUrl: fpoGovernor("Maine"),
      },
    ],
  },
};
// Wave 3 (Aug 2026): the bulk-open-data states — governor races first,
// down-ballot to follow as candidates are curated. Polling URLs are set only
// where FiftyPlusOne has general-election polls for the race.
const LIVE_CONFIG_3: Record<string, Pick<StateConfig, "races" | "agency" | "chambers">> = {
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
        pollingSourceUrl: fpoGovernor("Pennsylvania"),
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
        pollingSourceUrl: fpoGovernor("Massachusetts"),
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
        pollingSourceUrl: fpoGovernor("Minnesota"),
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
        // FiftyPlusOne has only primary polls for CO so far (Oct 2026) — no
        // general matchup to average yet; the race ranks by money until that
        // changes. The importer already loads it: add pollingSourceUrl then.
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
        pollingSourceUrl: fpoGovernor("Iowa"),
      },
      // Every Iowa executive office is on the 2026 ballot; candidates come from
      // the Local Politics Tracker (states.json lpt_statewide). The segment
      // is LPT's office name, so Secretary of Agriculture keeps FL's segment.
      { office: "attorney-general", title: "Attorney General", generalDate: "2026-11-03", raceSlug: "iowa-attorney-general-2026" },
      { office: "secretary-of-state", title: "Secretary of State", generalDate: "2026-11-03", raceSlug: "iowa-secretary-of-state-2026" },
      { office: "treasurer", title: "Treasurer", generalDate: "2026-11-03", raceSlug: "iowa-treasurer-2026" },
      { office: "auditor", title: "Auditor", generalDate: "2026-11-03", raceSlug: "iowa-auditor-2026" },
      { office: "agriculture-commissioner", title: "Secretary of Agriculture", generalDate: "2026-11-03", raceSlug: "iowa-secretary-of-agriculture-2026" },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census cartographic-boundary 2024 districts simplified with
    // mapshaper (6%). The 25 odd-numbered Senate seats are up.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 50, generalDate: "2026-11-03", map: "/maps/ia-state-senate.json", seatsUp: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49] },
      { office: "state-house", title: "State House", districts: 100, generalDate: "2026-11-03", map: "/maps/ia-state-house.json" },
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
        raceSlug: "maryland-governor-2026",
        pollingSourceUrl: fpoGovernor("Maryland"),
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
        // No public polling for this race yet (none on FiftyPlusOne, Oct 2026).
        raceSlug: "hawaii-governor-2026",
      },
    ],
  },
  // Ohio (Oct 2026): finance and polling come with the Local Politics
  // Tracker data — the tracker never had Ohio filings.
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
        pollingSourceUrl: fpoGovernor("Ohio"),
      },
      { office: "attorney-general", title: "Attorney General", generalDate: "2026-11-03", raceSlug: "ohio-attorney-general-2026" },
      { office: "secretary-of-state", title: "Secretary of State", generalDate: "2026-11-03", raceSlug: "ohio-secretary-of-state-2026" },
      { office: "auditor", title: "Auditor", generalDate: "2026-11-03", raceSlug: "ohio-auditor-2026" },
      { office: "treasurer", title: "Treasurer", generalDate: "2026-11-03", raceSlug: "ohio-treasurer-2026" },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 33, generalDate: "2026-11-03", map: "/maps/oh-state-senate.json", seatsUp: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33] },
      { office: "state-house", title: "State House", districts: 99, generalDate: "2026-11-03", map: "/maps/oh-state-house.json" },
    ],
  },
  // Oregon (Oct 2026): new on the site, from the Local Politics Tracker
  // data. Half the Senate (15 of 30 seats) and the whole House are on the
  // 2026 ballot.
  or: {
    agency: {
      name: "Oregon Secretary of State — ORESTAR",
      url: "https://sos.oregon.gov/elections/Pages/orestar.aspx",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "oregon-governor-2026",
        pollingSource: "lpt",
        pollingSourceUrl: lptRace("or", "governor-2026"),
      },
    ],
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 30, generalDate: "2026-11-03", map: "/maps/or-state-senate.json", seatsUp: [3, 4, 6, 7, 8, 10, 11, 13, 15, 16, 17, 19, 20, 24, 26] },
      { office: "state-house", title: "State House", districts: 60, generalDate: "2026-11-03", map: "/maps/or-state-house.json" },
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
        pollingSourceUrl: fpoGovernor("Wisconsin"),
      },
      // Down-ballot statewide races (Oct 2026): candidates from the Local Politics
      // Tracker (states.json lpt_statewide).
      { office: "lt-governor", title: "Lt. Governor", generalDate: "2026-11-03", raceSlug: "wisconsin-lt-governor-2026" },
      { office: "attorney-general", title: "Attorney General", generalDate: "2026-11-03", raceSlug: "wisconsin-attorney-general-2026" },
      { office: "secretary-of-state", title: "Secretary of State", generalDate: "2026-11-03", raceSlug: "wisconsin-secretary-of-state-2026" },
      { office: "treasurer", title: "Treasurer", generalDate: "2026-11-03", raceSlug: "wisconsin-treasurer-2026" },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 33, generalDate: "2026-11-03", map: "/maps/wi-state-senate.json", seatsUp: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33] },
      { office: "state-house", title: "State Assembly", districts: 99, generalDate: "2026-11-03", map: "/maps/wi-state-house.json" },
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
        pollingSourceUrl: fpoGovernor("Nevada"),
      },
    ],
  },
};
// Wave 5 (Aug 2026): the last seven SLCF-ready states, all with 2026
// governor races. Polling URLs only where FiftyPlusOne has general-election
// polls (all seven as of Oct 2026).
const LIVE_CONFIG_4: Record<string, Pick<StateConfig, "races" | "agency" | "chambers">> = {
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
        pollingSourceUrl: fpoGovernor("Alabama"),
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
        pollingSourceUrl: fpoGovernor("Alaska"),
      },
    ],
    // Legislature (Oct 2026): rosters from the Local Politics Tracker
    // (pipelines/load/roster.py), finance from the nightly SLCF load; maps
    // are Census TIGER 2024 districts simplified with mapshaper.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 20, generalDate: "2026-11-03", map: "/maps/ak-state-senate.json", seatsUp: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19] },
      { office: "state-house", title: "State House", districts: 40, generalDate: "2026-11-03", map: "/maps/ak-state-house.json" },
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
        raceSlug: "arkansas-governor-2026",
        pollingSourceUrl: fpoGovernor("Arkansas"),
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
        pollingSourceUrl: fpoGovernor("Connecticut"),
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
        raceSlug: "idaho-governor-2026",
        pollingSourceUrl: fpoGovernor("Idaho"),
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
        raceSlug: "illinois-governor-2026",
        pollingSourceUrl: fpoGovernor("Illinois"),
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
        raceSlug: "kansas-governor-2026",
        pollingSourceUrl: fpoGovernor("Kansas"),
      },
    ],
  },
};
// Texas (Oct 2026): moved in from its own site. Finance is the TEC bulk
// import (scripts/data-import/tec, tx-finance-sync.yml) staged in tx_* and
// published into cf_* nightly; polling is FiftyPlusOne, like every state's.
// Primaries were Mar 3 with May 26 runoffs.
const LIVE_CONFIG_TX: Record<string, Pick<StateConfig, "races" | "agency" | "legacyPaths" | "chambers">> = {
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
        pollingSourceUrl: fpoGovernor("Texas"),
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
      // Down-ballot statewide races (Oct 2026): candidates seeded into tx_candidates
      // from the Local Politics Tracker (roster.py sync_texas_statewide).
      { office: "comptroller", title: "Comptroller", generalDate: "2026-11-03", raceSlug: "texas-comptroller-2026" },
      { office: "railroad-commissioner", title: "Railroad Commissioner", generalDate: "2026-11-03", raceSlug: "texas-railroad-commissioner-2026" },
      { office: "agriculture-commissioner", title: "Agriculture Commissioner", generalDate: "2026-11-03", raceSlug: "texas-agriculture-commissioner-2026" },
      { office: "land-commissioner", title: "Land Commissioner", generalDate: "2026-11-03", raceSlug: "texas-land-commissioner-2026" },
    ],
    // Legislature (Oct 2026): candidates seeded into tx_candidates from the
    // Local Politics Tracker (pipelines/load/roster.py --texas), finance from
    // the TEC import; 16 of 31 Senate seats and the whole House are up.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 31, generalDate: "2026-11-03", map: "/maps/tx-state-senate.json", seatsUp: [1, 2, 3, 4, 5, 9, 11, 13, 18, 19, 21, 22, 24, 26, 28, 31] },
      { office: "state-house", title: "State House", districts: 150, generalDate: "2026-11-03", map: "/maps/tx-state-house.json" },
    ],
  },
};
// California (Oct 2026): moved in from cagovtracker.com. Finance is the
// CAL-ACCESS bulk import (scripts/data-import/cal-access, ca-finance-sync.yml)
// staged in ca_* and published into cf_* nightly; polling is FiftyPlusOne. The
// primary (Jun 2) was top-two, so the general can pit any two parties.
const LIVE_CONFIG_CA: Record<string, Pick<StateConfig, "races" | "agency" | "legacyPaths" | "chambers">> = {
  ca: {
    agency: {
      name: "California Secretary of State (CAL-ACCESS)",
      url: "https://cal-access.sos.ca.gov/Campaign/",
    },
    // cagovtracker.com's URLs before it moved onto this codebase: one race,
    // its pages at the root.
    legacyPaths: {
      "/candidates": "/governor/candidates",
      "/polling": "/governor/polling",
      "/top-donors": "/governor/money/donors",
      "/independent-expenditures": "/governor/money/outside-spending",
      "/faq": "/about",
    },
    races: [
      {
        office: "governor",
        title: "Governor",
        generalDate: "2026-11-03",
        raceSlug: "california-governor-2026",
        pollingSourceUrl: fpoGovernor("California"),
      },
    ],
    // Legislature (Oct 2026): the general-election candidates from the
    // Secretary of State's certified list (pipelines/load/roster_ca.py),
    // finance from the CAL-ACCESS import; the 20 even-numbered Senate seats
    // and all 80 Assembly seats are up.
    chambers: [
      { office: "state-senate", title: "State Senate", districts: 40, generalDate: "2026-11-03", map: "/maps/ca-state-senate.json", seatsUp: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40] },
      { office: "state-house", title: "State Assembly", districts: 80, generalDate: "2026-11-03", map: "/maps/ca-state-house.json" },
    ],
  },
};
Object.assign(LIVE_CONFIG, LIVE_CONFIG_2, LIVE_CONFIG_3, LIVE_CONFIG_4, LIVE_CONFIG_TX, LIVE_CONFIG_CA);

export const STATES: StateConfig[] = ALL_STATES.map(([code, name]) => ({
  code,
  name,
  status: EXTERNAL[code]
    ? "external"
    : LIVE_CONFIG[code] && !HIDDEN.has(code)
      ? "live"
      : SLCF_READY.has(code)
        ? "ready"
        : "planned",
  source: LPT_STATES.has(code) ? "lpt" : "tracker",
  externalUrl: EXTERNAL[code],
  ...LIVE_CONFIG[code],
}));

/** Every state the hub currently hides although it has a dashboard. */
export const hiddenStates = () => STATES.filter((s) => HIDDEN.has(s.code) && !!LIVE_CONFIG[s.code]);

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
  return race.pollingSource ?? "fiftyplusone";
}

/** "FiftyPlusOne" — for source credits next to polling. */
export function pollingSourceLabel(race: Pick<RaceConfig, "pollingSource">): string {
  return POLLING_SOURCES[pollingSourceKey(race)].label;
}

/**
 * The polling sources a state's polled races use, joined for prose
 * ("FiftyPlusOne"). Null when none of its races is polled.
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
  if (chamber.seatsUp?.length) return [...chamber.seatsUp].sort((a, b) => a - b).map(String);
  return Array.from({ length: chamber.districts }, (_, i) => String(i + 1));
}

/** "all 56 State Senate districts" or "the 17 of 33 State Senate seats on the 2026 ballot". */
export function chamberScope(chamber: ChamberConfig): string {
  const n = chamberDistricts(chamber).length;
  return n === chamber.districts
    ? `all ${chamber.districts} ${chamber.title} districts`
    : `the ${n} of ${chamber.districts} ${chamber.title} seats on the ${chamber.generalDate.slice(0, 4)} ballot`;
}
