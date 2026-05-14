import { eq, sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * OAuth + email-confirm callback. Supabase posts here with `?code=...`.
 * We exchange it for a session, then redirect to `next` (default
 * /dashboard).
 *
 * Phase 7: if `mbb_invite_code_id` cookie is present AND the
 * authenticated user doesn't yet have a redeemed invite, redeem it
 * here. This covers the OAuth-signup path — email signup redeems
 * atomically via the auth.users trigger (raw_user_meta_data carries
 * the id); OAuth doesn't get that hook, so we redeem post-hoc.
 *
 * The cookie is set in apps/web/app/(auth)/signup/actions.ts during
 * validateInviteCodeAction. Cleared here whether redemption succeeds
 * or fails so a stale id can't bleed into a later auth flow.
 */

const INVITE_COOKIE = 'mbb_invite_code_id';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
    }

    // Phase 7 — best-effort invite-code redemption for the OAuth path.
    const inviteCookie = request.cookies.get(INVITE_COOKIE);
    if (inviteCookie?.value) {
      await redeemOAuthInviteCode(inviteCookie.value);
    }
    const response = NextResponse.redirect(`${origin}${next}`);
    // Clear regardless — single-use either way.
    response.cookies.set(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  }
  return NextResponse.redirect(`${origin}${next}`);
}

/**
 * Validate + redeem the invite code for the just-authed user. Idempotent:
 * if they already have signed_up_via_invite_code_id set, we no-op. If
 * the code is invalid we log + move on — the user is already
 * authenticated, dropping them at /login at this point would be a
 * worse UX than letting them in (an admin can revoke later).
 */
async function redeemOAuthInviteCode(inviteCodeId: string): Promise<void> {
  try {
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const db = getDb();
    const userRow = await db.query.users.findFirst({
      where: eq(schema.users.id, user.id),
      columns: { signedUpViaInviteCodeId: true },
    });
    if (userRow?.signedUpViaInviteCodeId) return;

    const inviteCode = await db.query.inviteCodes.findFirst({
      where: eq(schema.inviteCodes.id, inviteCodeId),
      columns: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        useCount: true,
        maxUses: true,
      },
    });
    if (!inviteCode) return;
    if (inviteCode.revokedAt) return;
    if (inviteCode.expiresAt <= new Date()) return;
    if (inviteCode.useCount >= inviteCode.maxUses) return;

    // Single transaction-ish update — increment use_count + set FK +
    // re-evaluate founding-member eligibility. Race window exists
    // (this isn't FOR UPDATE'd from JS) but the worst-case is two
    // users on the same code both succeeding when the second should
    // have failed; the SQL trigger guards the strict path for email
    // signup.
    await db
      .update(schema.inviteCodes)
      .set({ useCount: sql`${schema.inviteCodes.useCount} + 1` })
      .where(eq(schema.inviteCodes.id, inviteCodeId));
    await db
      .update(schema.users)
      .set({ signedUpViaInviteCodeId: inviteCodeId })
      .where(eq(schema.users.id, user.id));

    // Founding-member eligibility — same function the trigger uses.
    const [eligibility] = await db.execute(
      sql<{ eligible: boolean }>`select public.check_founding_member_eligibility() as eligible`,
    );
    const list = Array.isArray(eligibility)
      ? eligibility
      : ((eligibility as { rows?: unknown[] }).rows ?? [eligibility]);
    const isEligible = (list as Array<{ eligible?: boolean }>)[0]?.eligible === true;
    if (isEligible) {
      await db
        .update(schema.userSettings)
        .set({ isFoundingMember: true })
        .where(eq(schema.userSettings.userId, user.id));
    }

    await logAuditEvent({
      userId: user.id,
      eventType: 'invite_code_redeemed',
      eventData: {
        invite_code_id: inviteCodeId,
        path: 'oauth_callback',
        founding_member_granted: isEligible,
      },
    });
  } catch (err) {
    // Swallow — the user is already authenticated. An admin can fix
    // the missing redemption manually if needed.
    console.error('[auth-callback] redeemOAuthInviteCode failed', err);
  }
}
