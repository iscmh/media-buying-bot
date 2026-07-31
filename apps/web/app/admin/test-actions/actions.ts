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
