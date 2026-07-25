import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { type Chamber } from "@/lib/openstates";

/** A row of cf_officials — one current officeholder role, from Open States. */
export type Official = {
  id: string;
  os_person_id: string;
  state: string;
  role_type: string;
  office: string | null;
  chamber: Chamber | null;
  district: string | null;
  name: string;
  party: string | null;
  image_url: string | null;
  email: string | null;
  phone: string | null;
  capitol_address: string | null;
  links: { url: string; note?: string }[] | null;
  sources: { url: string }[] | null;
  term_start: string | null;
  term_end: string | null;
};

const OFFICIAL_COLUMNS =
  "id,os_person_id,state,role_type,office,chamber,district,name,party,image_url," +
  "email,phone,capitol_address,links,sources,term_start,term_end";

/**
 * The sitting holder of the office this race is for, or null when Open States
 * has no record (Florida's CFO and Agriculture Commissioner aren't covered) or
 * the roster hasn't synced yet.
 */
export function useIncumbent() {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  return useQuery({
    queryKey: ["cf_officials", "incumbent", stateCfg.code, race.office],
    queryFn: async (): Promise<Official | null> => {
      const { data, error } = await (supabase as any)
        .from("cf_officials")
        .select(OFFICIAL_COLUMNS)
        .eq("state", stateCfg.code)
        .eq("office", race.office)
        // A state should only ever have one sitting holder per office, but an
        // upstream data fix mid-transition could briefly produce two — take the
        // most recently sworn in rather than throwing on the extra row.
        .order("term_start", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Official | null;
    },
  });
}

/** A member's campaign finance for the cycle, from cf_official_finance. */
export type OfficialFinance = {
  raised: number;
  spent: number;
  contribution_count: number;
  committees: { filer_id: string; name: string; match_method: string }[];
  /** Weakest match backing the total — anything but district_id is worth a flag. */
  weakest_match: string | null;
  as_of: string | null;
};

export type ChamberRoster = {
  chamber: Chamber;
  members: (Official & { finance?: OfficialFinance })[];
  /** Seat counts by party, largest caucus first. */
  parties: { party: string; seats: number }[];
  /** Seats whose money we have — the honest denominator for the chamber total. */
  seatsWithFinance: number;
  totalRaised: number;
  asOf: string | null;
};

/**
 * Both chambers of the active state's legislature, rostered and with seat
 * counts per party. Empty chambers are dropped, so a state whose roster hasn't
 * synced yet returns [] and the page renders its empty state.
 */
export function useLegislature() {
  const stateCfg = useStateConfig();
  return useQuery({
    queryKey: ["cf_officials", "legislature", stateCfg.code],
    queryFn: async (): Promise<ChamberRoster[]> => {
      const [rosterRes, financeRes] = await Promise.all([
        (supabase as any)
          .from("cf_officials")
          .select(OFFICIAL_COLUMNS)
          .eq("state", stateCfg.code)
          .not("chamber", "is", null)
          .order("name"),
        (supabase as any)
          .from("cf_official_finance")
          .select(
            "official_id,raised,spent,contribution_count,committees,weakest_match,as_of",
          )
          .eq("state", stateCfg.code),
      ]);
      if (rosterRes.error) throw rosterRes.error;
      if (financeRes.error) throw financeRes.error;

      const finance = new Map<string, OfficialFinance>();
      for (const f of (financeRes.data ?? []) as any[]) {
        finance.set(f.official_id, {
          raised: Number(f.raised ?? 0),
          spent: Number(f.spent ?? 0),
          contribution_count: Number(f.contribution_count ?? 0),
          committees: f.committees ?? [],
          weakest_match: f.weakest_match,
          as_of: f.as_of,
        });
      }

      const rows = (rosterRes.data ?? []) as Official[];
      const chambers: Chamber[] = ["upper", "lower"];
      return chambers
        .map((chamber) => {
          const members = rows
            .filter((r) => r.chamber === chamber)
            .map((r) => ({ ...r, finance: finance.get(r.id) }))
            .sort((a, b) => districtRank(a.district) - districtRank(b.district));
          const seats = new Map<string, number>();
          for (const m of members) {
            const key = (m.party ?? "").trim() || "Unknown";
            seats.set(key, (seats.get(key) ?? 0) + 1);
          }
          const funded = members.filter((m) => m.finance);
          return {
            chamber,
            members,
            parties: [...seats.entries()]
              .map(([party, count]) => ({ party, seats: count }))
              .sort((a, b) => b.seats - a.seats),
            seatsWithFinance: funded.length,
            totalRaised: funded.reduce((s, m) => s + (m.finance?.raised ?? 0), 0),
            asOf: funded[0]?.finance?.as_of ?? null,
          };
        })
        .filter((c) => c.members.length > 0);
    },
  });
}

// Districts are text (they can be "1", "12A", or a name), so sort numerically
// where possible and alphabetically otherwise.
function districtRank(district: string | null): number {
  const n = parseInt((district ?? "").trim(), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}
