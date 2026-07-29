import 'server-only';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getDb, schema } from '@mbb/db';
import { setSentryUser } from '@/lib/sentry-user';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 7: server-side admin gate. Every /admin/* server component
 * calls this at the top. Behavior:
 *   - Not logged in → /login
 *   - Logged in but users.role != 'admin' → /dashboard (silent
 *     redirect; the link is hidden from non-admins so reaching here
 *     means a manual URL probe — we don't want a 403 page leaking
 *     the route's existence).
 *
 * Admins are promoted manually via SQL today:
 *   update public.users set role = 'admin' where email = '<you>';
 */
export async function requireAdmin(): Promise<{ userId: string; email: string }> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const db = getDb();
  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, user.id),
    columns: { role: true },
  });
  if (row?.role !== 'admin') {
    redirect('/dashboard');
  }
  // Polish-25.7 Commit 44: tag the current Sentry scope with the
  // authed admin so any admin-surface error is attributable.
  setSentryUser({ userId: user.id, email: user.email ?? '', isAdmin: true });
  return { userId: user.id, email: user.email ?? '' };
}
