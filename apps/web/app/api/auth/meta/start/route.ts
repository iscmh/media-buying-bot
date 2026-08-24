import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { META_REQUIRED_SCOPES } from '@mbb/shared';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-28.4.9 Commit 107: Meta OAuth start endpoint.
 *
 * Kicks off the "Log in with Meta" flow. Alternative to the paste-token
 * onboarding — the operator clicks a button, Meta shows the standard
 * consent screen, and we get a normal OAuth-issued access token that
 * DOES NOT trigger Meta's fraud alarm (unlike Graph-API-Explorer USER
 * tokens which do — that's why Commit 106 shipped the System User
 * fallback).
 *
 * Requires two env vars:
 *   META_APP_ID     — public App ID from developers.facebook.com/apps
 *   META_APP_SECRET — server-only secret from the same app dashboard
 *
 * When either is absent, the "Log in with Meta" button on the connect
 * page hides and the operator falls back to System User / paste path.
 *
 * ## Meta App Review vs Development Mode
 *
 * A brand-new Meta App is in "Development" mode by default. In that
 * state ONLY users you've explicitly added as App Roles → Testers
 * (accessible from developers.facebook.com/apps/<APP_ID>/roles/roles/)
 * can complete the OAuth flow. Testers see the same consent screen
 * production users would see, and the token they receive works
 * identically. Cap is ~100 testers per app.
 *
 * Once you've onboarded ~50+ real users this way, submit for App
 * Review. Meta approves the ads_management + ads_read + business_
 * management + pages_show_list + pages_read_engagement scopes in
 * 5-30 business days, after which any user can log in without being
 * pre-added as a tester. The OAuth code here doesn't change — Meta
 * just flips the "public access" flag on their side.
 */

const META_OAUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
const STATE_COOKIE_NAME = 'meta_oauth_state';
const STATE_COOKIE_MAX_AGE_SECONDS = 600; // 10 min — plenty for the redirect round-trip.

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth guard: only signed-in Supabase users may start the flow.
  // Anyone else gets a 302 to /login — same pattern as the other
  // authenticated API routes in this app.
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const appId = process.env['META_APP_ID'];
  if (!appId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'META_APP_ID is not configured on this deploy. Operator: create a Business-type app at developers.facebook.com/apps and set META_APP_ID + META_APP_SECRET on the Vercel env.',
      },
      { status: 501 },
    );
  }

  // CSRF: random state token, stored in a signed httpOnly cookie so
  // the callback can verify Meta redirected the SAME session that
  // started the flow (guards against a malicious site tricking a
  // logged-in operator into linking someone else's Meta account).
  const state = randomBytes(24).toString('hex');
  const redirectUri = `${req.nextUrl.origin}/api/auth/meta/callback`;

  const url = new URL(META_OAUTH_URL);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', META_REQUIRED_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  // auth_type=rerequest surfaces the permission chooser again even if
  // the user previously approved — useful when they revoked scopes
  // manually in Facebook settings and need to re-grant.
  url.searchParams.set('auth_type', 'rerequest');

  const res = NextResponse.redirect(url.toString());
  res.cookies.set({
    name: STATE_COOKIE_NAME,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}
