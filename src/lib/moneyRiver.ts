// Money → River: every itemized contribution, expenditure, loan and outside
// expenditure in one race, newest first (the cf_money_river view). Ported
// from the Texas Politics Tracker, where it covered every Texas race at once;
// on the hub it is race-scoped like the other Money tabs, so the race filter
// became the race you are on.

/** The four row sources the cf_money_river view unions. */
export const RIVER_KINDS = ["contribution", "expenditure", "outside", "loan"] as const;
export type RiverKind = (typeof RIVER_KINDS)[number];

export const RIVER_KIND_LABEL: Record<RiverKind, string> = {
  contribution: "Contribution",
  expenditure: "Spending",
  outside: "Outside spending",
  loan: "Loan",
};

export const RIVER_PAGE_SIZE = 50;

export type RiverRow = {
  kind: RiverKind;
  id: string;
  txn_date: string | null;
  amount: number;
  candidate_id: string;
  candidate_slug: string;
  candidate_name: string;
  candidate_party: string | null;
  state: string;
  office: string;
  district: string | null;
  counterparty: string | null;
  counterparty_type: string | null;
  detail: string | null;
  support_oppose: string | null;
  cycle: string | null;
  imported_at: string | null;
};

export type RiverFilters = {
  kind: RiverKind | "all";
  candidate: string; // "" or a cf_candidates uuid
  page: number; // 1-based
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the river's state from the URL so a filtered page is shareable.
 * Anything malformed falls back to the default rather than throwing.
 */
export function parseRiverParams(params: URLSearchParams): RiverFilters {
  const kind = params.get("kind") ?? "all";
  const candidate = params.get("candidate") ?? "";
  const page = Number(params.get("page") ?? "1");
  return {
    kind: (RIVER_KINDS as readonly string[]).includes(kind) ? (kind as RiverKind) : "all",
    candidate: UUID_RE.test(candidate) ? candidate : "",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Inverse of parseRiverParams; defaults are omitted to keep URLs short. */
export function riverParamsToSearch(f: RiverFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.kind !== "all") p.set("kind", f.kind);
  if (f.candidate) p.set("candidate", f.candidate);
  if (f.page > 1) p.set("page", String(f.page));
  return p;
}

/**
 * One-line plain-English reading of a row, e.g.
 *   "Texans for Lawsuit Reform PAC gave to Greg Abbott"
 *   "Greg Abbott paid Anedot Inc"
 *   "Texans for a Better Future spent to oppose Gina Hinojosa"
 *   "Gina Hinojosa lent to Gina Hinojosa" (self-loans read as "lent to")
 */
export function describeRiverRow(row: Pick<RiverRow, "kind" | "counterparty" | "candidate_name" | "support_oppose">): {
  subject: string;
  verb: string;
  object: string;
} {
  const who = row.counterparty?.trim() || "Unitemized";
  switch (row.kind) {
    case "contribution":
      return { subject: who, verb: "gave to", object: row.candidate_name };
    case "loan":
      return { subject: who, verb: "lent to", object: row.candidate_name };
    case "outside":
      return {
        subject: who,
        verb: row.support_oppose === "O" ? "spent to oppose" : "spent to support",
        object: row.candidate_name,
      };
    case "expenditure":
    default:
      return { subject: row.candidate_name, verb: "paid", object: who };
  }
}

/** "Showing 1–50 of 12,345" bookkeeping for the pager. */
export function pageWindow(page: number, pageSize: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);
  return { pages, current, from, to };
}
