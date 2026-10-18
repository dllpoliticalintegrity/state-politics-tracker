// Debounced candidate-name search over cf_candidates (public read). Name
// only: committees and donors are not searched.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  MIN_QUERY,
  cleanQuery,
  toResults,
  type CandidateSearchResult,
  type CandidateSearchRow,
} from "@/lib/candidateSearch";

export function useCandidateSearch(
  query: string,
  states: string[],
): { results: CandidateSearchResult[]; isFetching: boolean; ready: boolean } {
  const cleaned = cleanQuery(query);
  const [debounced, setDebounced] = useState(cleaned);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cleaned), 200);
    return () => clearTimeout(t);
  }, [cleaned]);

  const ready = debounced.length >= MIN_QUERY && states.length > 0;
  const { data, isFetching } = useQuery({
    queryKey: ["candidate-search", states.join(","), debounced.toLowerCase()],
    enabled: ready,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // Every word must appear somewhere in the name ("jo bens" finds Jocelyn Benson).
      let q = supabase
        .from("cf_candidates" as never)
        .select("slug,name,party,state,office,district,status")
        .in("state", states);
      for (const word of debounced.split(" ")) q = q.ilike("name", `%${word}%`);
      const { data, error } = await q.order("name").limit(40);
      if (error) throw error;
      return (data ?? []) as unknown as CandidateSearchRow[];
    },
  });
  return {
    results: ready ? toResults(data ?? [], { showState: states.length > 1 }) : [],
    isFetching: ready && isFetching,
    ready,
  };
}
