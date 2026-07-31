'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { createInviteCode, getDb, logAuditEvent, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { sendEmail } from '@/lib/email/send';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { createPaymentLink, type WhopPlanTier } from '@/lib/whop/client';

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

const TIER_TO_ENV: Record<WhopPlanTier, string> = {
  monthly: 'WHOP_PRODUCT_ID_MONTHLY',
  annual: 'WHOP_PRODUCT_ID_ANNUAL',
  lifetime: 'WHOP_PRODUCT_ID_LIFETIME',
};

export interface ApproveApplicationResult {
  ok: boolean;
  inviteCode?: string;
  checkoutUrl?: string;
  emailSent?: boolean;
  emailStubbed?: boolean;
  errorMessage?: string;
}

/**
 * Phase 8: approve an application atomically:
 *   1. Generate fresh single-use invite code (30-day TTL).
 *   2. Generate Whop checkout link with metadata.application_id +
 *      .invite_code_id so the webhook can link back here.
 *   3. Stamp applications: status='approved' + the URL + code id.
 *   4. Email the user the checkout URL + invite code (Resend or stub).
 *
 * If any of (1)–(3) fail the function returns ok:false; we don't roll
 * back partial state — admin can re-run approve on the same row and
 * the second pass picks up where the first left off (idempotent code
 * generation creates a new code; that's fine — multiple codes pointing
 * at the same Whop product are harmless, only one will be redeemed).
 */
export async function approveApplicationAction(input: {
  applicationId: string;
  tier: WhopPlanTier;
}): Promise<ApproveApplicationResult> {
  const adminUserId = await requireAdminUserId();
  const db = getDb();

  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, input.applicationId),
  });
  if (!app) return { ok: false, errorMessage: 'Application not found.' };
  if (app.status === 'paid') {
    return { ok: false, errorMessage: 'Already paid. Leave it alone.' };
  }

  // 1. Invite code.
  const inviteCode = await createInviteCode({
    createdBy: adminUserId,
    metadata: { source: 'application_approval', application_id: app.id },
  });

  // 2. Whop checkout link.
  const productId = process.env[TIER_TO_ENV[input.tier]];
  if (!productId) {
    return {
      ok: false,
      errorMessage: `${TIER_TO_ENV[input.tier]} env var is not set. Configure it on the host before approving.`,
    };
  }
  const link = await createPaymentLink({
    productId,
    customerEmail: app.email,
    metadata: { application_id: app.id, invite_code_id: inviteCode.id },
  });
  if (!link.ok || !link.url) {
    return { ok: false, errorMessage: link.errorMessage ?? 'Whop did not return a URL.' };
  }

  // 3. Stamp the row.
  await db
    .update(schema.applications)
    .set({
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: adminUserId,
      inviteCodeId: inviteCode.id,
      whopCheckoutUrl: link.url,
      whopProductId: productId,
    })
    .where(eq(schema.applications.id, app.id));

  await logAuditEvent({
    userId: adminUserId,
    eventType: 'application_approved',
    eventData: {
      application_id: app.id,
      invite_code_id: inviteCode.id,
      tier: input.tier,
      whop_product_id: productId,
      _meta: await auditMetaFromHeaders(),
    },
  });

  // 4. Email.
  const send = await sendEmail({
    to: app.email,
    subject: "You're approved - your Media Buying Bot checkout link",
    text: [
      `Hey${app.name ? ` ${app.name}` : ''},`,
      '',
      "You're in. To activate your account:",
      '',
      `  1. Pay on Whop: ${link.url}`,
      `  2. Sign up with this invite code: ${inviteCode.code}`,
      `     (${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.example.com'}/signup)`,
      '',
      `Code expires ${inviteCode.expiresAt.toISOString().slice(0, 10)}. Single-use.`,
      '',
      '- Media Buying Bot',
    ].join('\n'),
  });

  revalidatePath('/admin/applications');
  return {
    ok: true,
    inviteCode: inviteCode.code,
    checkoutUrl: link.url,
    emailSent: send.ok && !send.stubbed,
    emailStubbed: send.stubbed,
  };
}

export interface RejectApplicationResult {
  ok: boolean;
  errorMessage?: string;
}

export async function rejectApplicationAction(input: {
  applicationId: string;
  reason?: string;
}): Promise<RejectApplicationResult> {
  const adminUserId = await requireAdminUserId();
  const db = getDb();
  const app = await db.query.applications.findFirst({
    where: eq(schema.applications.id, input.applicationId),
    columns: { id: true, status: true },
  });
  if (!app) return { ok: false, errorMessage: 'Application not found.' };
  if (app.status !== 'pending') {
    return { ok: false, errorMessage: `Already ${app.status}.` };
  }
  await db
    .update(schema.applications)
    .set({
      status: 'rejected',
      rejectedReason: input.reason?.trim() || null,
    })
    .where(eq(schema.applications.id, app.id));
  await logAuditEvent({
    userId: adminUserId,
    eventType: 'application_rejected',
    eventData: {
      application_id: app.id,
      reason: input.reason ?? null,
      _meta: await auditMetaFromHeaders(),
    },
  });
  revalidatePath('/admin/applications');
  return { ok: true };
}
