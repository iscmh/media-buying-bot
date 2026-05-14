'use server';

import { joinWaitlist, logAuditEvent } from '@mbb/db';

export interface JoinWaitlistFormResult {
  ok: boolean;
  errorMessage?: string;
}

/**
 * Phase 7: public waitlist intake. No auth required.
 * Form fields all pre-trimmed; email is normalized to lowercase
 * inside joinWaitlist(). Duplicate emails surface a friendly
 * "you're already on the list" rather than a unique-violation
 * stack trace.
 */
export async function joinWaitlistAction(input: {
  email: string;
  name?: string;
  source?: string;
  message?: string;
}): Promise<JoinWaitlistFormResult> {
  const result = await joinWaitlist(input);
  if (!result.ok) {
    if (result.reason === 'duplicate') {
      // Audit so the operator can see organic re-signups, but don't
      // re-record the failed entry — uniqueness already protects us.
      await logAuditEvent({
        userId: null,
        eventType: 'waitlist_duplicate_signup_attempt',
        eventData: { email_hash: emailHash(input.email) },
      });
      return { ok: false, errorMessage: "You're already on the waitlist — we'll be in touch." };
    }
    return { ok: false, errorMessage: 'That email address looks invalid.' };
  }

  await logAuditEvent({
    userId: null,
    eventType: 'waitlist_signup',
    eventData: {
      entry_id: result.entryId,
      source: input.source ?? null,
      has_message: !!input.message,
    },
  });
  return { ok: true };
}

function emailHash(email: string): string {
  // Cheap obfuscation — we don't need cryptographic hashing here,
  // just enough to not store the literal email in the audit log
  // alongside the dedup signal.
  let h = 0;
  const e = email.trim().toLowerCase();
  for (let i = 0; i < e.length; i++) h = (h * 31 + e.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
