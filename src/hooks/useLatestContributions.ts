import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { scopeToRace } from "./useCandidates";
import { onBallot } from "@/lib/candidateStatus";

/**
 * Latest individual + PAC contributions across the cycle, joined to the
 * recipient candidate's name + party. Powers the "Latest gifts" ticker on
 * the home page.
 */
export type LatestContribution = {
  id: string;
  amount: number;
  contribution_date: string | null;
  contributor_type: string | null; // INDIVIDUAL / ENTITY
  contributor_first_name: string | null;
  contributor_last_name: string | null;
  employer: string | null;
  city: string | null;
  state: string | null;
  candidate_id: string | null;
  candidate_name: string | null;
  candidate_party: string | null; // 'D' / 'R' / 'I' / etc., normalized
};

const PAC_TYPES = ["ENTITY"];

/**
 * Statewide races tick over $30k gifts; a legislative district's biggest
 * gifts are an order of magnitude smaller, so its ticker starts at $1k.
 */
export function tickerMinAmount(district: string | undefined): number {
  return district ? 1_000 : 30_000;
}

export function useLatestContributions(limit = 20, minAmount?: number) {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const floor = minAmount ?? tickerMinAmount(race.district);
  return useQuery({
    queryKey: ["cf_latest_contributions", stateCfg.code, race.office, race.district ?? null, limit, floor],
    queryFn: async (): Promise<LatestContribution[]> => {
      // Two steps on purpose. The obvious single query — cf_contributions
      // with an embedded cf_candidates!inner filter, ordered by date — makes
      // Postgres walk the date index across all ~1.5M rows looking for the
      // few that belong to this race and clear the floor, and hits the
      // statement timeout for legislative races. Resolving the race's
      // candidate ids first lets the (candidate_id, amount) index do the work.
      const { data: cands, error: candErr } = await scopeToRace(
        (supabase as any).from("cf_candidates").select("id,name,party,status"),
        stateCfg,
        race,
      );
      if (candErr) throw candErr;
      // Ticker is shared across the site: skip gifts to candidates who are
      // off the ballot (lost primary, withdrawn, …).
      const byId = new Map<string, { name: string; party: string | null }>(
        onBallot(cands as { id: string; name: string; party: string | null; status: string | null }[]).map(
          (c) => [c.id, c],
        ),
      );
      if (byId.size === 0) return [];

      const { data, error } = await (supabase as any)
        .from("cf_contributions")
        .select(
          "id,amount,contribution_date,contributor_type,contributor_first_name,contributor_last_name,employer,city,state,candidate_id",
        )
        .in("candidate_id", [...byId.keys()])
        .not("contribution_date", "is", null)
        .gte("amount", floor)
        .order("contribution_date", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        id: r.id,
        amount: Number(r.amount ?? 0),
        contribution_date: r.contribution_date,
        contributor_type: r.contributor_type,
        contributor_first_name: r.contributor_first_name,
        contributor_last_name: r.contributor_last_name,
        employer: r.employer,
        city: r.city,
        state: r.state,
        candidate_id: r.candidate_id,
        candidate_name: byId.get(r.candidate_id)?.name ?? null,
        candidate_party: normalizeParty(byId.get(r.candidate_id)?.party),
      }));
    },
    staleTime: 60_000,
  });
}

function normalizeParty(p: string | null | undefined): string {
  if (!p) return "";
  const s = p.trim().toLowerCase();
  if (s.startsWith("d")) return "D";
  if (s.startsWith("r")) return "R";
  if (s.startsWith("i") || s === "no party preference") return "I";
  return p[0]?.toUpperCase() ?? "";
}

/** Classify into the brand's IND / PAC / LOAN / COM verb pill colors. */
export function contributionVerb(c: LatestContribution): {
  verb: "ind" | "pac" | "loan" | "com";
  label: "IND" | "PAC" | "LOAN" | "COM";
} {
  const t = (c.contributor_type ?? "").toUpperCase();
  if (t === "INDIVIDUAL") return { verb: "ind", label: "IND" };
  if (PAC_TYPES.includes(t)) return { verb: "pac", label: "PAC" };
  // Loans come from Schedule E; we don't have form-type here, so any
  // unexpected contributor_type falls through to COM.
  return { verb: "com", label: "COM" };
}

/** Pretty $ formatter — $5,000 / $1.2M / $250K. */
export function formatContributionAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 10_000) return `$${Math.round(amount / 1000)}K`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  return `$${Math.round(amount).toLocaleString()}`;
}

/** Relative time — "2h ago" / "3d ago". */
export function relativeAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - t);
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(diff / 60_000);
  return `${mins}m ago`;
}

/** Donor display name — falls back to last_name only for PACs (no first name). */
export function donorDisplayName(c: LatestContribution): string {
  const first = (c.contributor_first_name ?? "").trim();
  const last = (c.contributor_last_name ?? "").trim();
  if (first && last) return `${first[0]}. ${last}`; // initial + last for individuals
  return last || first || "—";
}

/** "EMPLOYER · CITY" for context line, with sensible falls-throughs. */
export function donorContext(c: LatestContribution): string {
  const parts: string[] = [];
  if (c.employer) parts.push(c.employer.toUpperCase());
  if (c.city) parts.push(c.city.toUpperCase());
  return parts.join(" · ");
}

/** Last-name surname extraction for the recipient candidate display. */
export function candidateShort(name: string | null): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  // For "Gov. Greg Abbott" -> "ABBOTT"; for "Gina Hinojosa" -> "HINOJOSA"
  return (parts[parts.length - 1] || name).toUpperCase();
}
