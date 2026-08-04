import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Polish-25.1 Commit 10a: /apply + /waitlist removed as public
// routes — signup no longer gated by an application/invite flow.
// `/` is still public but only serves a server-side redirect to
// /login or /dashboard depending on auth state.
const PUBLIC_PATHS = new Set(['/', '/signup', '/login', '/legal/tos', '/legal/privacy']);

const PUBLIC_PREFIXES = [
  '/api/auth',
  '/api/inngest',
  '/api/health',
  '/api/webhooks',
  // Polish-25.8 Commit 49: Telegram POSTs come from api.telegram.org
  // with no Supabase cookie — middleware was 307-redirecting to
  // /login and Telegram was rejecting "Wrong response from the
  // webhook: 307". Same for the client error sink, which the
  // pre-auth error boundary may hit before any session cookie exists.
  '/api/telegram',
  '/api/log-error',
  // Polish-25.10 Commit 59: /api/v1/* is Bearer-token authenticated
  // per-route. Middleware must NOT redirect these to /login — the
  // 307 would kill any HTTP client that doesn't follow redirects
  // (curl without -L, most Python requests configs). Same failure
  // mode Telegram + Whop webhooks hit pre-Commit-49.
  '/api/v1',
  '/_next',
  '/favicon',
];

/**
 * Middleware does ONE job: redirect unauthenticated requests on protected
 * paths to /login. Onboarding step gating + dashboard gating happens in the
 * server components themselves (they can hit @mbb/db; middleware can't,
 * since it runs on Edge and our Drizzle client is TCP).
 *
 * Also sets x-pathname so server layouts/components can read the current
 * path (Next 14 doesn't expose pathname to RSC otherwise).
 */
export async function middleware(request: NextRequest) {
  // Stamp pathname so layout/components can read it server-side.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh session if expired.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', path);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
