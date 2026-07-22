import { redirect } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-25.1 Commit 10a: root is a server-side redirect only.
 * The public landing page is built + hosted separately by
 * marketing. In-app root sends authed users to /dashboard and
 * everyone else to /login.
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  redirect(user ? '/dashboard' : '/login');
}
