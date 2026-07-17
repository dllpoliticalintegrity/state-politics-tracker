import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Shared Supabase project (same project as the TX tracker — see docs/plan.md;
// the multi-state site reads the cf_* tables and the shared polling tables).
// The publishable key is public by design; env vars override for local dev
// against a different project.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://lohxdfrxnxuxjdvvyfjc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  'sb_publishable_r8D7t0Stine_UgCoU_ps8g_UDRKSpoX';

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
