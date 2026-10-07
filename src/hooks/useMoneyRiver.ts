import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { RIVER_PAGE_SIZE, type RiverFilters, type RiverRow } from "@/lib/moneyRiver";
import { scopeToRace } from "./useCandidates";

/**
 * One page of the money river for the current race (the cf_money_river view:
 * contributions, expenditures, loans and outside spending, newest transaction
 * first). Filters map straight onto view columns so PostgREST pushes them
 * into each branch of the union; `count: "exact"` gives the pager its total.
 */
export function useMoneyRiver(filters: RiverFilters, pageSize = RIVER_PAGE_SIZE) {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const { kind, candidate, page } = filters;
  return useQuery({
    queryKey: ["cf_money_river", stateCfg.code, race.office, race.district ?? null, kind, candidate, page, pageSize],
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: async (): Promise<{ rows: RiverRow[]; total: number }> => {
      const from = (page - 1) * pageSize;
      // cf_money_river postdates the generated types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = scopeToRace((supabase as any).from("cf_money_river").select("*", { count: "exact" }), stateCfg, race);
      if (kind !== "all") q = q.eq("kind", kind);
      if (candidate) q = q.eq("candidate_id", candidate);
      const { data, error, count } = await q
        .order("txn_date", { ascending: false, nullsFirst: false })
        .order("imported_at", { ascending: false })
        .order("id")
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return {
        rows: ((data ?? []) as RiverRow[]).map((r) => ({ ...r, amount: Number(r.amount ?? 0) })),
        total: count ?? 0,
      };
    },
  });
}
