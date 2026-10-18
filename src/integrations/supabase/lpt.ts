import { createClient } from "@supabase/supabase-js";

// The Local Politics Tracker project (Henry DeRyke and Colin's database
// behind statemoney.us) — the hub's unified store for the statemoney.us
// states and, once it is loaded there, California. States read it when their
// registry entry says `source: "lpt"`; see docs/lpt-frontend-plan.md.
//
// The publishable key is public by design (every table there is public-read
// through RLS). Env vars override for local dev against another project.
// No auth session: this client only ever reads with the anon role.
const LPT_URL = import.meta.env.VITE_LPT_SUPABASE_URL ?? "https://rwiueylzgcgnzypdyszi.supabase.co";
const LPT_PUBLISHABLE_KEY =
  import.meta.env.VITE_LPT_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_c8uRhk8kjqwGc6yRXhFx1g_aCv1Bqq4";

export const lpt = createClient(LPT_URL, LPT_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
