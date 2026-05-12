'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { assertDailyLaunchBudgetCap, getDb, logAuditEvent, schema } from '@mbb/db';
import { PLATFORM_HARD_AD_DAILY_BUDGET_USD } from '@mbb/shared';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { sendMetaLaunchEvent } from '@/lib/inngest/send';
import { getSupabaseServerClient } from '@/lib/supabase/server';

type Decision = 'approved' | 'rejected';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Approve or reject a single variant. Idempotent (re-clicking the same
 * decision is a no-op).
 */
export async function decideVariantAction(
  variantId: string,
  decision: Decision,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const user = await requireUser();
  const db = getDb();

  const variant = await db.query.generatedCreatives.findFirst({
    where: and(
      eq(schema.generatedCreatives.id, variantId),
      eq(schema.generatedCreatives.userId, user.id),
    ),
    columns: { id: true, status: true, generationJobId: true },
  });
  if (!variant) {
    return { ok: false, errorMessage: 'Variant not found.' };
  }
  if (variant.status === decision) {
    return { ok: true };
  }

  await db
    .update(schema.generatedCreatives)
    .set({ status: decision })
    .where(eq(schema.generatedCreatives.id, variantId));

  await logAuditEvent({
    userId: user.id,
    eventType: decision === 'approved' ? 'variant_approved' : 'variant_rejected',
    eventData: {
      variant_id: variantId,
      job_id: variant.generationJobId,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath(`/jobs/${variant.generationJobId}`);
  return { ok: true };
}

/**
 * Bulk decide every variant in a job that's still in 'ready_for_review'.
 * Skips already-decided variants so re-clicks are safe.
 */
export async function bulkDecideJobAction(
  jobId: string,
  decision: Decision,
): Promise<{ ok: boolean; updated?: number; errorMessage?: string }> {
  const user = await requireUser();
  const db = getDb();

  // Verify job ownership before bulk update.
  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.userId, user.id)),
    columns: { id: true },
  });
  if (!job) return { ok: false, errorMessage: 'Job not found.' };

  const result = await db
    .update(schema.generatedCreatives)
    .set({ status: decision })
    .where(
      and(
        eq(schema.generatedCreatives.generationJobId, jobId),
        eq(schema.generatedCreatives.status, 'ready_for_review'),
      ),
    )
    .returning({ id: schema.generatedCreatives.id });

  await logAuditEvent({
    userId: user.id,
    eventType: decision === 'approved' ? 'variants_bulk_approved' : 'variants_bulk_rejected',
    eventData: {
      job_id: jobId,
      updated_count: result.length,
      _meta: await auditMetaFromHeaders(),
    },
  });

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, updated: result.length };
}

/**
 * Phase 4a: record first-time launch acknowledgment. Idempotent. Sets
 * user_settings.launch_acknowledged_at + audit-logs once. Subsequent
 * launches skip the dialog because the timestamp is non-null.
 */
export async function acknowledgeLaunchAction(): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  const user = await requireUser();
  const db = getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.id),
    columns: { launchAcknowledgedAt: true },
  });
  if (existing?.launchAcknowledgedAt) {
    return { ok: true };
  }
  await db
    .update(schema.userSettings)
    .set({ launchAcknowledgedAt: new Date() })
    .where(eq(schema.userSettings.userId, user.id));
  await logAuditEvent({
    userId: user.id,
    eventType: 'launch_first_acknowledged',
    eventData: { _meta: await auditMetaFromHeaders() },
  });
  return { ok: true };
}

export interface LaunchApprovedResult {
  ok: boolean;
  errorMessage?: string;
  /** Echoed back so the dialog can show what the cap math allowed. */
  committedTodayUsd?: number;
  capUsd?: number;
  plannedBudgetUsd?: number;
}

/**
 * Phase 4a: dispatch the Meta launch job for every approved variant on a
 * generation job. Validates server-side that:
 *   - User has acknowledged the launch ack dialog at least once
 *   - At least 1 variant is in 'approved' status
 *   - Total daily budget the batch commits fits under the user's launch
 *     cap (TZ-aware "today")
 * After validation, fires the meta/launch.requested event and returns
 * immediately — the Inngest worker does the actual Meta CRUD.
 */
export async function launchApprovedAction(jobId: string): Promise<LaunchApprovedResult> {
  const user = await requireUser();
  const db = getDb();

  // 1. Verify ownership.
  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.userId, user.id)),
    columns: { id: true },
  });
  if (!job) return { ok: false, errorMessage: 'Job not found.' };

  // 2. Ack must be set.
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.id),
    columns: { launchAcknowledgedAt: true, defaultAdDailyBudgetUsd: true },
  });
  if (!settings) {
    return { ok: false, errorMessage: 'User settings missing.' };
  }
  if (!settings.launchAcknowledgedAt) {
    return {
      ok: false,
      errorMessage: 'You must acknowledge the launch confirmation dialog first.',
    };
  }

  // 3. Count approved variants.
  const approved = await db.query.generatedCreatives.findMany({
    where: and(
      eq(schema.generatedCreatives.generationJobId, jobId),
      eq(schema.generatedCreatives.userId, user.id),
      eq(schema.generatedCreatives.status, 'approved'),
    ),
    columns: { id: true },
  });
  if (approved.length === 0) {
    return { ok: false, errorMessage: 'No approved variants to launch.' };
  }

  // 4. Daily cap math (server-side).
  const perAdBudget = Math.min(
    Number(settings.defaultAdDailyBudgetUsd),
    PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  );
  const plannedBudgetUsd = approved.length * perAdBudget;
  const cap = await assertDailyLaunchBudgetCap(user.id, plannedBudgetUsd);
  if (!cap.allowed) {
    return {
      ok: false,
      errorMessage: cap.reason,
      committedTodayUsd: cap.committedTodayUsd,
      capUsd: cap.capUsd,
      plannedBudgetUsd,
    };
  }

  // 5. Audit + dispatch.
  await logAuditEvent({
    userId: user.id,
    eventType: 'ad_launch_requested',
    eventData: {
      job_id: jobId,
      approved_count: approved.length,
      planned_budget_usd: plannedBudgetUsd,
      _meta: await auditMetaFromHeaders(),
    },
  });
  await sendMetaLaunchEvent({ userId: user.id, generationJobId: jobId });

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath('/launched');
  return {
    ok: true,
    committedTodayUsd: cap.committedTodayUsd,
    capUsd: cap.capUsd,
    plannedBudgetUsd,
  };
}
