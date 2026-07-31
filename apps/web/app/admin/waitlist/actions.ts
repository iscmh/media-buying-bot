'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { approveWaitlistEntry, getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { sendEmail } from '@/lib/email/send';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireAdminUserId(): Promise<string> {
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
  if (row?.role !== 'admin') redirect('/dashboard');
  return user.id;
}

export interface ApproveResult {
  ok: boolean;
  code?: string;
  emailSent?: boolean;
  emailStubbed?: boolean;
  errorMessage?: string;
}

/**
 * Phase 7: approve a waitlist entry. Generates a fresh single-use
 * invite code, stamps the row, then emails the user. If
 * RESEND_API_KEY isn't set, sendEmail() logs the payload to stdout
 * and returns stubbed=true so the admin still sees "queued" UX.
 */
export async function approveWaitlistEntryAction(entryId: string): Promise<ApproveResult> {
  const adminUserId = await requireAdminUserId();
  const result = await approveWaitlistEntry({ entryId, approvedBy: adminUserId });
  if (!result.ok || !result.inviteCode || !result.email) {
    return { ok: false, errorMessage: result.errorMessage ?? 'Approval failed.' };
  }
  const { inviteCode, email } = result;

  await logAuditEvent({
    userId: adminUserId,
    eventType: 'waitlist_approved',
    eventData: {
      waitlist_entry_id: entryId,
      invite_code_id: inviteCode.id,
      _meta: await auditMetaFromHeaders(),
    },
  });

  const send = await sendEmail({
    to: email,
    subject: "You're off the waitlist - your Media Buying Bot invite",
    text: [
      'Hey,',
      '',
      'A spot opened up. Use this invite code to sign up:',
      '',
      `    ${inviteCode.code}`,
      '',
      `It expires on ${inviteCode.expiresAt.toISOString().slice(0, 10)} and is single-use.`,
      '',
      `Sign up at: ${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.example.com'}/signup`,
      '',
      '- Media Buying Bot',
    ].join('\n'),
  });

  revalidatePath('/admin/waitlist');
  return {
    ok: true,
    code: inviteCode.code,
    emailSent: send.ok,
    emailStubbed: send.stubbed,
    errorMessage: send.ok ? undefined : send.errorMessage,
  };
}
