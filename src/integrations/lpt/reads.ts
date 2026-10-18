// Reads against the Local Politics Tracker project (LPT), returning the same
// shapes the tracker-backed hooks return so no page changes. Server-side
// aggregation lives in the hub_* SQL functions
// (supabase/lpt/001_hub_read_layer.sql); per-candidate lists come straight
// from LPT's materialized views through PostgREST. See
// docs/lpt-frontend-plan.md for the query-by-query mapping.

import { lpt } from "@/integrations/supabase/lpt";
import type {
  CandidateTotals,
  CommitteeDonor,
  TxAggregatedDonor,
  TxCandidate,
  TxContributionSummary,
  TxIeAggregatedDonorRow,
  TxIeByCandidate,
  TxIeRow,
  TxLoan,
} from "@/hooks/useCandidates";
import type { LatestContribution } from "@/hooks/useLatestContributions";
import type { RiverFilters, RiverRow } from "@/lib/moneyRiver";
import type { RaceConfig, StateConfig } from "@/states/registry";
import {
  fromLptOffice,
  lptDistrict,
  lptRaceSlug,
  normalizeParty,
  toLptOffice,
  type LptPoll,
  type LptPollAverage,
  type LptRacePolls,
} from "@/lib/lpt";

/** A race in LPT's terms: upper-cased later by the functions; office in LPT's spelling; office_num or null. */
export type RaceScope = { state: string; office: string; district: number | null };

export function raceScope(state: StateConfig, race: RaceConfig): RaceScope {
  return { state: state.code, office: toLptOffice(race.office), district: lptDistrict(state, race) };
}

function scopeArgs(s: RaceScope) {
  return { p_state: s.state, p_office: s.office, p_district: s.district };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;

async function run<T>(q: AnyQuery): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

/**
 * Every row of a query, paging past PostgREST's 1,000-row cap (it applies
 * to RPC results too). `build` must return a fresh query each time.
 */
async function runAll<T>(build: () => AnyQuery, page = 1000): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += page) {
    const chunk = await run<T>(build().range(start, start + page - 1));
    rows.push(...chunk);
    if (chunk.length < page) return rows;
  }
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

type HubCandidateRow = {
  id: string;
  slug: string;
  name: string;
  raw_name: string;
  party: string | null;
  title: string | null;
  bio: string | null;
  photo_url: string | null;
  photo_url_large: string | null;
  photo_url_medium: string | null;
  photo_url_thumb: string | null;
  website: string | null;
  twitter_user: string | null;
  instagram_user: string | null;
  facebook_user: string | null;
  youtube_user: string | null;
  state: string;
  office: string;
  district: number | null;
  race_id: string;
  race_slug: string;
  election_year: number | null;
  status: string;
  on_ballot: boolean | null;
  disposition: string | null;
  is_incumbent: boolean | null;
  featured: boolean;
  committee_name: string | null;
  state_filer_id: string | null;
};

function toCandidate(r: HubCandidateRow): TxCandidate {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    party: normalizeParty(r.party),
    title: r.title,
    bio: r.bio,
    photo_url: r.photo_url,
    photo_url_medium: r.photo_url_medium,
    photo_url_large: r.photo_url_large,
    photo_url_thumb: r.photo_url_thumb,
    website: r.website,
    state: r.state,
    committee_name: r.committee_name,
    filer_refs: r.state_filer_id ? [`${r.state}:${r.state_filer_id}`] : [],
    office: fromLptOffice(r.office),
    district: r.district == null ? null : String(r.district),
    status: r.status,
    featured: !!r.featured,
    twitter_user: r.twitter_user,
    instagram_user: r.instagram_user,
    facebook_user: r.facebook_user,
    youtube_user: r.youtube_user,
  };
}

const byName = (a: TxCandidate, b: TxCandidate) => a.name.localeCompare(b.name);

export async function fetchCandidates(scope: RaceScope): Promise<TxCandidate[]> {
  const rows = await run<HubCandidateRow>(lpt.rpc("hub_candidates", scopeArgs(scope)));
  return rows.map(toCandidate).sort(byName);
}

/** Every candidate of a chamber (all districts). */
export async function fetchChamberCandidates(state: string, office: string): Promise<TxCandidate[]> {
  const rows = await runAll<HubCandidateRow>(() => lpt.rpc("hub_candidates", { p_state: state, p_office: toLptOffice(office) }));
  return rows.map(toCandidate).sort(byName);
}

/** The state's whole roster, every office. */
export async function fetchStateCandidates(state: string): Promise<TxCandidate[]> {
  const rows = await runAll<HubCandidateRow>(() => lpt.rpc("hub_candidates", { p_state: state }));
  return rows.map(toCandidate).sort(byName);
}

export async function fetchCandidateBySlug(state: string, slug: string): Promise<TxCandidate | null> {
  const rows = await run<HubCandidateRow>(lpt.rpc("hub_candidates", { p_state: state }).eq("slug", slug).limit(1));
  return rows.length ? toCandidate(rows[0]) : null;
}

export async function fetchRaceTotals(scope: RaceScope): Promise<Map<string, CandidateTotals>> {
  const rows = await run<{ candidate_id: string; raised: number; spent: number }>(
    lpt.rpc("hub_race_totals", scopeArgs(scope)),
  );
  const out = new Map<string, CandidateTotals>();
  for (const r of rows) {
    const raised = num(r.raised);
    const spent = num(r.spent);
    out.set(r.candidate_id, { raised, spent, cash: Math.max(0, raised - spent) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One candidate's finance
// ---------------------------------------------------------------------------

type HubFinanceRow = {
  candidate_id: string;
  total_raised: number;
  individual_contributions: number;
  self_funding: number;
  entity_contributions: number;
  small_dollar_contributions: number;
  small_dollar_count: number;
  individual_donor_count: number;
  as_of: string | null;
  total_spent: number;
};

export async function fetchCandidateFinance(
  candidateId: string,
): Promise<{ summaries: TxContributionSummary[]; totalSpent: number }> {
  const rows = await run<HubFinanceRow>(lpt.rpc("hub_candidate_finance", { p_candidate_id: candidateId }));
  const r = rows[0];
  if (!r) return { summaries: [], totalSpent: 0 };
  return {
    summaries: [
      {
        candidate_id: r.candidate_id,
        slug: "",
        name: "",
        filer_ident: null,
        cycle: "all",
        individual_donor_count: num(r.individual_donor_count),
        individual_contributions: num(r.individual_contributions),
        entity_contributions: num(r.entity_contributions),
        small_dollar_contributions: num(r.small_dollar_contributions),
        small_dollar_count: num(r.small_dollar_count),
        total_raised: num(r.total_raised),
        as_of: r.as_of,
      },
    ],
    totalSpent: num(r.total_spent),
  };
}

type HubDonorRow = TxAggregatedDonor;

export async function fetchTopDonors(candidateId: string, limit: number, kind: string): Promise<TxAggregatedDonor[]> {
  const rows = await run<HubDonorRow>(
    lpt.rpc("hub_candidate_top_donors", { p_candidate_id: candidateId, p_kind: kind, p_limit: limit }),
  );
  return rows.map((r) => ({ ...r, contribution_count: num(r.contribution_count), total_amount: num(r.total_amount) }));
}

/** Top donors per candidate across a race, for client-side re-aggregation. */
export async function fetchRaceTopDonors(scope: RaceScope, kind: string, perCandidate = 150): Promise<TxAggregatedDonor[]> {
  // Ordered by total, so the first 1,000 rows carry every donor the top-50
  // list can need; no paging.
  const rows = await run<HubDonorRow>(
    lpt.rpc("hub_race_top_donors", { ...scopeArgs(scope), p_kind: kind, p_per_candidate: perCandidate }),
  );
  return rows.map((r) => ({ ...r, contribution_count: num(r.contribution_count), total_amount: num(r.total_amount) }));
}

export async function fetchTopEmployers(state: string, candidateId: string, limit: number): Promise<{ name: string; amount: number }[]> {
  const rows = await run<{ name: string; amount: number; donors: number }>(
    lpt.rpc("hub_candidate_top_employers", { p_state: state, p_candidate_id: candidateId, p_limit: limit }),
  );
  return rows.map((r) => ({ name: r.name, amount: num(r.amount) }));
}

export async function fetchLoans(state: string, candidateId: string, limit: number): Promise<TxLoan[]> {
  const rows = await run<TxLoan>(lpt.rpc("hub_candidate_loans", { p_state: state, p_candidate_id: candidateId }));
  return rows
    .map((r) => ({ ...r, total_amount: num(r.total_amount), contribution_count: num(r.contribution_count) }))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Outside spending
// ---------------------------------------------------------------------------

export async function fetchIeByCandidate(scope: RaceScope): Promise<TxIeByCandidate[]> {
  const rows = await run<TxIeByCandidate>(lpt.rpc("hub_race_ie_by_candidate", scopeArgs(scope)));
  return rows.map((r) => ({
    ...r,
    total_supporting: num(r.total_supporting),
    total_opposing: num(r.total_opposing),
    supporting_count: num(r.supporting_count),
    opposing_count: num(r.opposing_count),
    committee_count: num(r.committee_count),
  }));
}

type IeActivityRow = {
  committee: string | null;
  filer_id: string | null;
  payee: string | null;
  purpose: string | null;
  amount: number;
  expenditure_date: string | null;
  support_oppose: string | null;
};

/** Most recent independent expenditures for or against one candidate. */
export async function fetchIeForCandidate(state: string, candidateId: string, limit: number): Promise<TxIeRow[]> {
  const rows = await run<IeActivityRow>(
    lpt.rpc("hub_candidate_ie_activity", { p_state: state, p_candidate_id: candidateId, p_limit: limit }),
  );
  return rows.slice(0, limit).map((r, i) => ({
    id: `${candidateId}-${r.support_oppose}-${i}`,
    ie_filer_ident: r.filer_id,
    target_candidate_id: candidateId,
    support_oppose: r.support_oppose,
    amount: num(r.amount),
    expenditure_date: r.expenditure_date,
    description: [r.purpose, r.payee].filter(Boolean).join(" · ") || null,
    cycle: null,
    committee_name: r.committee,
  }));
}

export async function fetchTopIeCommittees(scope: RaceScope, limit: number) {
  const rows = await run<{
    filer_id: string;
    name: string;
    total_amount: number;
    supporting: number;
    opposing: number;
    transaction_count: number;
  }>(lpt.rpc("hub_race_ie_committees", scopeArgs(scope)));
  return rows.slice(0, limit).map((r) => ({
    filer_id: r.filer_id,
    name: r.name,
    total_amount: num(r.total_amount),
    supporting: num(r.supporting),
    opposing: num(r.opposing),
    transaction_count: num(r.transaction_count),
  }));
}

/** Donors to the race's outside committees, per committee, plus the committee names. */
export async function fetchRaceIeDonors(
  scope: RaceScope,
  kind: string,
): Promise<{ rows: TxIeAggregatedDonorRow[]; committeeName: Map<string, string> }> {
  const rows = await run<TxIeAggregatedDonorRow & { committee_name: string }>(
    lpt.rpc("hub_race_ie_donors", { ...scopeArgs(scope), p_kind: kind }),
  );
  const committeeName = new Map<string, string>();
  for (const r of rows) committeeName.set(r.ie_filer_ident, r.committee_name);
  return {
    rows: rows.map((r) => ({ ...r, contribution_count: num(r.contribution_count), total_amount: num(r.total_amount) })),
    committeeName,
  };
}

// ---------------------------------------------------------------------------
// State-level committee donors
// ---------------------------------------------------------------------------

export async function fetchCommitteeDonors(state: string): Promise<CommitteeDonor[]> {
  const rows = await runAll<CommitteeDonor>(() => lpt.rpc("hub_state_committee_donors", { p_state: state }));
  return rows.map((r) => ({
    ...r,
    total_amount: num(r.total_amount),
    splits: (r.splits ?? []).map((s) => ({ ...s, total_amount: num(s.total_amount) })),
  }));
}

// ---------------------------------------------------------------------------
// Ticker and river
// ---------------------------------------------------------------------------

export async function fetchLatestContributions(scope: RaceScope, floor: number, limit: number): Promise<LatestContribution[]> {
  const rows = await run<LatestContribution>(
    lpt.rpc("hub_latest_contributions", { ...scopeArgs(scope), p_min_amount: floor, p_limit: limit }),
  );
  return rows.map((r) => ({ ...r, amount: num(r.amount), candidate_party: partyCode(r.candidate_party) }));
}

/** 'D' / 'R' / 'I' from any party spelling, as the ticker expects. */
function partyCode(p: string | null | undefined): string {
  if (!p) return "";
  const s = p.trim().toLowerCase();
  if (s.startsWith("d")) return "D";
  if (s.startsWith("r")) return "R";
  if (s.startsWith("i") || s.startsWith("non") || s === "no party preference") return "I";
  return p[0]?.toUpperCase() ?? "";
}

export async function fetchMoneyRiver(
  scope: RaceScope,
  filters: RiverFilters,
  pageSize: number,
): Promise<{ rows: RiverRow[]; total: number }> {
  const rows = await run<RiverRow & { total_count: number }>(
    lpt.rpc("hub_money_river", {
      ...scopeArgs(scope),
      p_kind: filters.kind,
      p_candidate: filters.candidate || null,
      p_limit: pageSize,
      p_offset: (filters.page - 1) * pageSize,
    }),
  );
  const total = rows.length ? num(rows[0].total_count) : 0;
  return {
    rows: rows.map(({ total_count: _n, ...r }) => ({
      ...r,
      amount: num(r.amount),
      candidate_party: normalizeParty(r.candidate_party),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Every poll of a race with its per-candidate results, newest first, plus the race's published average when one exists. */
export async function fetchRacePolls(state: string, race: RaceConfig): Promise<LptRacePolls> {
  const { data, error } = await lpt.rpc("hub_race_polls", { p_state: state, p_slug: lptRaceSlug(race) });
  if (error) throw error;
  const d = (data ?? {}) as { polls?: LptPoll[]; average?: LptPollAverage | null };
  return { polls: d.polls ?? [], average: d.average ?? null };
}
