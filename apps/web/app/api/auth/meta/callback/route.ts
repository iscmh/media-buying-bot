import { and, eq, isNull } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { encryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { verifyMetaToken } from '@/lib/meta/graph-api';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-28.4.9 Commit 107: Meta OAuth callback.
 *
 * Meta redirects back here with `code` + `state` (or `error`).
 * Sequence:
 *   1. Verify the CSRF state cookie matches the returned state param.
 *   2. Exchange `code` for a short-lived user access token via
 *      /v21.0/oauth/access_token.
 *   3. Exchange short-lived → long-lived (~60 day) via
 *      /v21.0/oauth/access_token?grant_type=fb_exchange_token.
 *   4. Run our normal verifyMetaToken to confirm scopes + get user_id.
 *   5. Encrypt + upsert meta_connections. Status=pending; the operator
 *      then picks a Business Manager + ad accounts on the settings page
 *      (same flow the paste-token path lands in).
 *   6. Redirect back to /settings/connections?tab=meta.
 *
 * Every user-facing failure path redirects to /settings/connections
 * with an `oauth_error` query param the settings page reads + renders
 * as an inline banner. Never leaks the raw Meta error to the URL.
 */

const META_TOKEN_URL = 'https://graph.facebook.com/v21.0/oauth/access_token';
const STATE_COOKIE_NAME = 'meta_oauth_state';

function errorRedirect(req: NextRequest, code: string): NextResponse {
  const url = new URL('/settings/connections', req.url);
  url.searchParams.set('tab', 'meta');
  url.searchParams.set('oauth_error', code);
  const res = NextResponse.redirect(url);
  // Clear the state cookie regardless — a failed round-trip shouldn't
  // leave stale CSRF material sitting around.
  res.cookies.set({ name: STATE_COOKIE_NAME, value: '', path: '/', maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Not signed in — Meta redirected them here but their app session
    // expired mid-flow. Send to /login; they can restart Connect after
    // re-authing.
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const appId = process.env['META_APP_ID'];
  const appSecret = process.env['META_APP_SECRET'];
  if (!appId || !appSecret) {
    return errorRedirect(req, 'not_configured');
  }

  // 1. Meta may have returned an error instead of a code (user denied
  // consent, or the app isn't in the tester list). Surface cleanly.
  const url = req.nextUrl;
  const metaError = url.searchParams.get('error');
  if (metaError) {
    const reason = url.searchParams.get('error_reason') ?? metaError;
    await logAuditEvent({
      userId: user.id,
      eventType: 'meta_oauth_denied',
      eventData: { meta_error: metaError, reason },
    });
    return errorRedirect(req, `denied:${reason}`);
  }

  // 2. CSRF check.
  const stateFromMeta = url.searchParams.get('state');
  const stateFromCookie = req.cookies.get(STATE_COOKIE_NAME)?.value;
  if (!stateFromMeta || !stateFromCookie || stateFromMeta !== stateFromCookie) {
    return errorRedirect(req, 'state_mismatch');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return errorRedirect(req, 'no_code');
  }

  const redirectUri = `${req.nextUrl.origin}/api/auth/meta/callback`;

  // 3. Code → short-lived token.
  let shortLivedToken: string;
  try {
    const exchangeUrl = new URL(META_TOKEN_URL);
    exchangeUrl.searchParams.set('client_id', appId);
    exchangeUrl.searchParams.set('client_secret', appSecret);
    exchangeUrl.searchParams.set('redirect_uri', redirectUri);
    exchangeUrl.searchParams.set('code', code);
    const res = await fetch(exchangeUrl.toString(), { method: 'GET' });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: { message?: string };
    };
    if (!res.ok || !body.access_token) {
      await logAuditEvent({
        userId: user.id,
        eventType: 'meta_oauth_code_exchange_failed',
        eventData: {
          http_status: res.status,
          meta_error: body.error?.message ?? null,
        },
      });
      return errorRedirect(req, 'code_exchange_failed');
    }
    shortLivedToken = body.access_token;
  } catch (err) {
    await logAuditEvent({
      userId: user.id,
      eventType: 'meta_oauth_code_exchange_failed',
      eventData: { fetch_error: err instanceof Error ? err.message : String(err) },
    });
    return errorRedirect(req, 'network_error');
  }

  // 4. Short-lived → long-lived (~60 days). Same endpoint,
  // grant_type=fb_exchange_token. Reference:
  // https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
  let longLivedToken: string;
  try {
    const extendUrl = new URL(META_TOKEN_URL);
    extendUrl.searchParams.set('grant_type', 'fb_exchange_token');
    extendUrl.searchParams.set('client_id', appId);
    extendUrl.searchParams.set('client_secret', appSecret);
    extendUrl.searchParams.set('fb_exchange_token', shortLivedToken);
    const res = await fetch(extendUrl.toString(), { method: 'GET' });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: { message?: string };
    };
    if (!res.ok || !body.access_token) {
      // Fall through with the short-lived one — still usable for ~1
      // hour, and the operator can reconnect later.
      longLivedToken = shortLivedToken;
    } else {
      longLivedToken = body.access_token;
    }
  } catch {
    longLivedToken = shortLivedToken;
  }

  // 5. Verify scopes + get fb_user_id.
  const verify = await verifyMetaToken(user.id, longLivedToken);
  if (!verify.ok || !verify.data) {
    return errorRedirect(req, 'verify_failed');
  }

  // 6. Encrypt + upsert.
  const expiresAt =
    verify.data.expires_at && verify.data.expires_at > 0
      ? new Date(verify.data.expires_at * 1000)
      : null;
  const encrypted = await encryptSecret(longLivedToken);
  const db = getDb();
  const existing = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, user.id),
      isNull(schema.metaConnections.deletedAt),
    ),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(schema.metaConnections)
      .set({
        accessTokenEncrypted: encrypted,
        fbUserId: verify.data.user_id,
        tokenExpiresAt: expiresAt,
        connectionMethod: 'oauth',
        status: 'pending',
        lastVerifiedAt: new Date(),
      })
      .where(eq(schema.metaConnections.id, existing.id));
  } else {
    await db.insert(schema.metaConnections).values({
      userId: user.id,
      accessTokenEncrypted: encrypted,
      fbUserId: verify.data.user_id,
      tokenExpiresAt: expiresAt,
      connectionMethod: 'oauth',
      status: 'pending',
    });
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'meta_oauth_connected',
    eventData: {
      fb_user_id: verify.data.user_id,
      app_id: verify.data.app_id,
      token_expires_at: expiresAt?.toISOString() ?? null,
      token_type: verify.data.type ?? 'unknown',
    },
  });

  // 7. Success — land on the BM picker.
  const success = new URL('/settings/connections', req.url);
  success.searchParams.set('tab', 'meta');
  success.searchParams.set('oauth', 'connected');
  const res = NextResponse.redirect(success);
  res.cookies.set({ name: STATE_COOKIE_NAME, value: '', path: '/', maxAge: 0 });
  return res;
}
