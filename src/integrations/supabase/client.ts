import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// The Supabase project for this site doesn't exist yet (created in Phase 2 —
// see docs/plan.md). Fall back to a placeholder so the app can boot with no
// env configured; any actual query will fail, but nothing issues queries
// until a state is "live" in the registry.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? 'https://placeholder.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'placeholder';

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
