// Every published dedicated state site (state code → https://hostname), from
// `state_sites` (public read). Empty while loading or on failure, so cross-links
// simply don't render rather than break the page.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { publishedSitesFrom, type PublishedSites } from "../../shared/site";

export function usePublishedSites(): PublishedSites {
  const { data } = useQuery({
    queryKey: ["state_sites", "published"],
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("state_sites" as never)
        .select("state,hostname")
        .eq("published", true);
      if (error) throw error;
      return publishedSitesFrom((data as unknown as { state: string; hostname: string }[]) ?? []);
    },
  });
  return data ?? {};
}
