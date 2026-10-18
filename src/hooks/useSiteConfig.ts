// Live chrome for the active state's dedicated site, from `state_sites`
// (public read). A missing, unpublished or failed row means the registry's
// defaults, so the site never depends on the table being reachable.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { applySiteConfig, type SiteChrome, type StateSiteRow } from "@/lib/siteConfig";
import type { StateConfig } from "@/states/registry";

export function useSiteConfig(cfg: StateConfig | null): SiteChrome {
  const { data } = useQuery({
    queryKey: ["state_sites", cfg?.code ?? null],
    enabled: !!cfg,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("state_sites" as never)
        .select("*")
        .eq("state", cfg!.code)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as StateSiteRow | null) ?? null;
    },
  });
  return applySiteConfig(cfg, data ?? null);
}
