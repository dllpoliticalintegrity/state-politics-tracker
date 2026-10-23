import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRaceConfig, useStateConfig } from "@/states/StateContext";
import { RIVER_PAGE_SIZE, type RiverFilters, type RiverPage, type RiverRow } from "@/lib/moneyRiver";
import * as lptReads from "@/integrations/lpt/reads";
import { raceScope } from "@/integrations/lpt/reads";

/**
 * One page of the money river for the current race (contributions,
 * expenditures, loans and outside spending, newest transaction first).
 *
 * The tracker reads cf_money_river_page(), which reads only the newest rows of
 * each candidate and table, instead of the cf_money_river view: sorting the
 * view meant producing every row of the race (278k for Arizona's governor)
 * and timed out cold. It has no total, so it is asked for one row more than
 * the page and `hasMore` says whether that row came back. LPT states
 * (Oregon) still return an exact `total`.
 */
export function useMoneyRiver(filters: RiverFilters, pageSize = RIVER_PAGE_SIZE) {
  const stateCfg = useStateConfig();
  const race = useRaceConfig();
  const { kind, candidate, page } = filters;
  return useQuery({
    queryKey: ["cf_money_river", stateCfg.source, stateCfg.code, race.office, race.district ?? null, kind, candidate, page, pageSize],
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: async (): Promise<RiverPage> => {
      if (stateCfg.source === "lpt") {
        const r = await lptReads.fetchMoneyRiver(raceScope(stateCfg, race), filters, pageSize);
        return { rows: r.rows, total: r.total, hasMore: page * pageSize < r.total };
      }
      const from = (page - 1) * pageSize;
      // cf_money_river_page postdates the generated types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("cf_money_river_page", {
        p_state: stateCfg.code,
        p_office: race.office,
        p_district: race.district ?? null,
        p_kind: kind === "all" ? null : kind,
        p_candidate: candidate || null,
        p_limit: pageSize + 1,
        p_offset: from,
      });
      if (error) throw error;
      const all = ((data ?? []) as RiverRow[]).map((r) => ({ ...r, amount: Number(r.amount ?? 0) }));
      return { rows: all.slice(0, pageSize), total: null, hasMore: all.length > pageSize };
    },
  });
}
