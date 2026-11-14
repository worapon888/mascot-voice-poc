import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseEnv } from '@/lib/validations/env';

let supabaseClientInstance: SupabaseClient | null = null;

/**
 * Lazily initializes and returns the server-only Supabase client.
 * Never expose SUPABASE_SECRET_KEY to browser/client components.
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (!supabaseClientInstance) {
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = getSupabaseEnv();
    supabaseClientInstance = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return supabaseClientInstance;
}
