'use server';

import { cookies } from 'next/headers';
import { validateInviteCode } from '@mbb/db';

/**
 * Phase 7: server-side invite-code validation. Called from the signup
 * form's onSubmit before supabase.auth.signUp runs — surfaces "code
 * expired / fully used / not found" as a clear inline error.
 *
 * The trigger on auth.users will re-validate with FOR UPDATE so a
 * race between this read and the actual signup can't slip a stale
 * code through. This action is a UX nicety, not the source of truth.
 *
 * As a side effect we set a short-lived cookie carrying the resolved
 * invite_code_id. The /api/auth/callback handler reads it on the
 * OAuth path (where we can't pass auth metadata up-front) and
 * redeems the code post-creation via the service-role client.
 */
export interface ValidateResult {
  ok: boolean;
  inviteCodeId?: string;
  errorMessage?: string;
}

const COOKIE_NAME = 'mbb_invite_code_id';
const COOKIE_MAX_AGE_SECONDS = 600; // 10 min — enough for the OAuth round-trip

export async function validateInviteCodeAction(code: string): Promise<ValidateResult> {
  const result = await validateInviteCode(code);
  if (!result.ok) {
    return { ok: false, errorMessage: humanReason(result.reason) };
  }
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, result.inviteCodeId, {
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
    httpOnly: true,
    // Polish-28.4.10 Commit 108: gate `secure` on NODE_ENV, not the
    // presence of a NEXT_PUBLIC_SITE_URL prefix. The prior check meant
    // that if the env var was ever absent in prod the cookie shipped
    // over plain HTTP — a real infra-config footgun. NODE_ENV is set
    // by Next during the build; production === secure cookie.
    secure: process.env.NODE_ENV === 'production',
  });
  return { ok: true, inviteCodeId: result.inviteCodeId };
}

function humanReason(reason: 'not_found' | 'revoked' | 'expired' | 'fully_used'): string {
  switch (reason) {
    case 'not_found':
      return "That code doesn't exist. Check the spelling or request a new one from your invite.";
    case 'revoked':
      return 'That code was revoked. Contact whoever invited you for a fresh one.';
    case 'expired':
      return 'That code has expired (codes are good for 30 days). Request a new one.';
    case 'fully_used':
      return 'That code has already been used. Contact whoever invited you for a fresh one.';
  }
}
