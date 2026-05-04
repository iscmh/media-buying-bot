import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase client. Carries the user's JWT so RLS policies
 * apply. Use this in Server Components, Route Handlers, Server Actions.
 *
 * Do NOT use the service-role key here — that bypasses RLS and breaks
 * multi-tenant isolation. Service-role goes through @mbb/db only.
 */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }: { name: string; value: string; options: CookieOptions }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component: cookie writes get no-op'd. Middleware handles refresh.
          }
        },
      },
    },
  );
}
