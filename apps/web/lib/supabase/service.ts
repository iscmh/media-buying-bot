import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Polish-25.10 Commit 59: service-role Supabase client for API-route
 * contexts. Bypasses RLS — caller MUST enforce user_id scoping
 * explicitly.
 *
 * The web app usually goes through getSupabaseServerClient() which
 * uses the user's session cookie. API routes authenticate via
 * Bearer token and have no cookie, so RLS-scoped clients return
 * an unauthenticated session and INSERTs get 403'd.
 *
 * Used for storage uploads/deletes in API-route context. DB reads
 * and writes go through @mbb/db's getDb() which already uses the
 * service role.
 */
let cached: ReturnType<typeof createClient> | null = null;

export function getSupabaseServiceClient() {
  if (cached) return cached;
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL) missing — cannot init service client.',
    );
  }
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
