'use server';

import { eq, inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getDb, schema } from '@mbb/db';
import { inngest } from '@mbb/jobs';
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

export interface TestActionResult {
  ok: boolean;
  message: string;
}

export async function testKillAction(launchedAdId: string): Promise<TestActionResult> {
  await requireAdminUserId();
  const db = getDb();
  const ad = await db.query.launchedAds.findFirst({
    where: eq(schema.launchedAds.id, launchedAdId),
    columns: { id: true, userId: true, metaAdId: true },
  });
  if (!ad) return { ok: false, message: 'Ad not found.' };

  const [approval] = await db
    .insert(schema.pendingApprovals)
    .values({
      userId: ad.userId,
      launchedAdId: ad.id,
      actionType: 'kill',
      proposedPayload: {},
      reason: 'Manual test from /admin/test-actions',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning({ id: schema.pendingApprovals.id });
  if (!approval) return { ok: false, message: 'Could not create approval row.' };

  await inngest.send({
    name: 'approval/decision.received',
    data: { approvalId: approval.id, decision: 'confirm' },
  });

  return {
    ok: true,
    message: `Kill dispatched for ad ${ad.id.slice(0, 8)}. Approval ${approval.id.slice(0, 8)} created. Watch Inngest dashboard for handle-approval-decision run.`,
  };
}

export async function testScaleAction(
  launchedAdId: string,
  newBudgetUsd: number,
): Promise<TestActionResult> {
  await requireAdminUserId();
  const db = getDb();
  const ad = await db.query.launchedAds.findFirst({
    where: eq(schema.launchedAds.id, launchedAdId),
    columns: { id: true, userId: true, metaAdSetId: true, dailyBudgetUsd: true },
  });
  if (!ad) return { ok: false, message: 'Ad not found.' };
  if (!ad.metaAdSetId) return { ok: false, message: 'Ad has no meta_ad_set_id. Cannot scale.' };

  const [approval] = await db
    .insert(schema.pendingApprovals)
    .values({
      userId: ad.userId,
      launchedAdId: ad.id,
      actionType: 'scale',
      proposedPayload: {
        new_budget_usd: newBudgetUsd,
        from_budget_usd: Number(ad.dailyBudgetUsd),
      },
      reason: 'Manual test from /admin/test-actions',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning({ id: schema.pendingApprovals.id });
  if (!approval) return { ok: false, message: 'Could not create approval row.' };

  await inngest.send({
    name: 'approval/decision.received',
    data: { approvalId: approval.id, decision: 'confirm' },
  });

  return {
    ok: true,
    message: `Scale dispatched for ad ${ad.id.slice(0, 8)} ($${Number(ad.dailyBudgetUsd).toFixed(2)} -> $${newBudgetUsd.toFixed(2)}). Watch Inngest for handle-approval-decision.`,
  };
}

/**
 * Polish-29.0.6 Commit 115: fire a real Seedance credit-backed job
 * from the admin dashboard. Creates a generation_jobs row with the
 * prompt + dreamina account in metadata, then dispatches the
 * `generation/polish29-seedance.requested` event. The worker
 * (packages/jobs/src/functions/generate-polish29-seedance.ts) does
 * the reserve → submit → poll → consume/release cycle.
 *
 * Use this to verify end-to-end BEFORE shipping the public generate
 * form. Balance must be ≥ 40 credits (Seedance 2.5 cost).
 */
export async function testSeedanceGeneration(input: {
  prompt: string;
  dreaminaAccount: string;
}): Promise<TestActionResult> {
  const userId = await requireAdminUserId();
  const promptTrimmed = input.prompt.trim();
  const accountTrimmed = input.dreaminaAccount.trim();
  if (!promptTrimmed) return { ok: false, message: 'Prompt is required.' };
  if (!accountTrimmed) return { ok: false, message: 'Dreamina account is required.' };
  if (promptTrimmed.length > 2000) {
    return { ok: false, message: 'Prompt too long (>2000 chars). Trim it and retry.' };
  }

  const db = getDb();
  const [job] = await db
    .insert(schema.generationJobs)
    .values({
      userId,
      pickedPipeline: 'polish29_seedance',
      format: 'polish29_seedance',
      status: 'queued',
      mode: 'live',
      variantCount: 1,
      providerChoice: 'useapi_net',
      metadata: {
        source: 'admin_test_action',
        seedance_prompt: promptTrimmed,
        dreamina_account: accountTrimmed,
      },
    })
    .returning({ id: schema.generationJobs.id });
  if (!job) return { ok: false, message: 'Could not create generation_jobs row.' };

  await inngest.send({
    name: 'generation/polish29-seedance.requested',
    data: {
      jobId: job.id,
      userId,
      dreaminaAccount: accountTrimmed,
      prompt: promptTrimmed,
    },
  });

  return {
    ok: true,
    message: `Seedance job ${job.id.slice(0, 8)} dispatched. Watch Inngest for generate-polish29-seedance run; job row updates status + video URL in metadata.polish29_seedance.`,
  };
}

export async function testDailySummary(): Promise<TestActionResult> {
  const userId = await requireAdminUserId();

  await inngest.send({
    name: 'summary/daily.requested',
    data: { userId, date: new Date().toISOString().slice(0, 10) },
  });

  return {
    ok: true,
    message: 'Daily summary event dispatched. Watch Inngest for daily-summary-generator run.',
  };
}

export async function loadTestableAds(): Promise<
  Array<{
    id: string;
    metaAdId: string | null;
    status: string;
    dailyBudgetUsd: string;
    spendUsd: string | null;
  }>
> {
  await requireAdminUserId();
  const db = getDb();
  const rows = await db.query.launchedAds.findMany({
    where: inArray(schema.launchedAds.status, ['active', 'dry_run', 'paused', 'killed']),
    columns: {
      id: true,
      metaAdId: true,
      status: true,
      dailyBudgetUsd: true,
      metaSpendUsd: true,
    },
    orderBy: (t, { desc }) => [desc(t.launchedAt)],
    limit: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    metaAdId: r.metaAdId,
    status: r.status,
    dailyBudgetUsd: r.dailyBudgetUsd,
    spendUsd: r.metaSpendUsd,
  }));
}
