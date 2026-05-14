'use server';

import { getDb, logAuditEvent, schema } from '@mbb/db';

export interface ApplyResult {
  ok: boolean;
  errorMessage?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Phase 8: public /apply intake. Stricter than Phase 7's /waitlist —
 * Email + name are required, the rest are optional context for the
 * admin reviewer. Dedup is "soft" — we let duplicate emails apply
 * again (people lose threads, re-apply with the same address) but
 * audit the duplicate so the admin can spot resubmissions.
 */
export async function applyAction(input: {
  email: string;
  name?: string;
  agencyName?: string;
  monthlyAdSpendUsd?: string;
  verticals?: string[];
  whyApply?: string;
  heardFrom?: string;
}): Promise<ApplyResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, errorMessage: 'That email address looks invalid.' };
  }
  const name = input.name?.trim();
  if (!name) {
    return { ok: false, errorMessage: 'Name is required so we can address you in the reply.' };
  }

  const db = getDb();
  // Soft dedup: see if there's already a pending app from this email.
  const existing = await db.query.applications.findFirst({
    where: (a, { and, eq, inArray }) =>
      and(eq(a.email, email), inArray(a.status, ['pending', 'approved'])),
    columns: { id: true, status: true },
  });
  if (existing) {
    await logAuditEvent({
      userId: null,
      eventType: 'application_duplicate_submission',
      eventData: { email_hash: hashEmail(email), existing_status: existing.status },
    });
    return {
      ok: false,
      errorMessage:
        existing.status === 'approved'
          ? "You're already approved — check your inbox for the invite. Reply to that email if you can't find it."
          : "We've already got your application. Hang tight — we review within 48 hours.",
    };
  }

  const [row] = await db
    .insert(schema.applications)
    .values({
      email,
      name,
      agencyName: input.agencyName?.trim() || null,
      monthlyAdSpendUsd: input.monthlyAdSpendUsd?.trim() || null,
      verticals: (input.verticals ?? []).filter(Boolean).join(',') || null,
      whyApply: input.whyApply?.trim() || null,
      heardFrom: input.heardFrom?.trim() || null,
    })
    .returning({ id: schema.applications.id });

  await logAuditEvent({
    userId: null,
    eventType: 'application_submitted',
    eventData: {
      application_id: row?.id,
      email_hash: hashEmail(email),
      has_agency: !!input.agencyName,
      verticals_count: (input.verticals ?? []).length,
    },
  });

  return { ok: true };
}

function hashEmail(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
