import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '@mbb/db';
import { inngest } from '@mbb/jobs';
import { apiError, apiOk } from '@/lib/api-envelope';
import { parseJsonBody, withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ScaleBody = z.object({
  new_budget_usd: z.number().positive(),
});

/**
 * Polish-25.10 Commit 59: POST /api/v1/launched_ads/:id/scale
 *
 * Body: { new_budget_usd: number }
 * Creates a pending_approvals scale row + dispatches
 * approval/decision.received. Worker enforces the platform scale
 * caps + calls Meta.
 */
export const POST = withApi('launched_ads.scale', async (req, ctx) => {
  const launchedAdId = String(ctx.params?.id ?? '');
  if (!launchedAdId) return apiError('validation_error', 'Missing launched ad id.');
  const parsed = await parseJsonBody(req, ScaleBody);
  if (!parsed.ok) return parsed.response;
  const { new_budget_usd } = parsed.data;

  const db = getDb();
  const ad = await db.query.launchedAds.findFirst({
    where: and(eq(schema.launchedAds.id, launchedAdId), eq(schema.launchedAds.userId, ctx.userId)),
    columns: { id: true, userId: true, dailyBudgetUsd: true, metaAdSetId: true, status: true },
  });
  if (!ad) return apiError('not_found', 'Launched ad not found.');
  if (!ad.metaAdSetId) {
    return apiError(
      'conflict',
      "Ad has no meta_ad_set_id — Meta didn't return one at launch. Can't scale.",
    );
  }
  if (ad.status === 'killed') {
    return apiError('conflict', 'Ad is killed. Cannot scale a killed ad.');
  }

  const existing = await db.query.pendingApprovals.findFirst({
    where: and(
      eq(schema.pendingApprovals.launchedAdId, ad.id),
      eq(schema.pendingApprovals.actionType, 'scale'),
      eq(schema.pendingApprovals.status, 'pending'),
    ),
    columns: { id: true },
  });
  let approvalId = existing?.id;
  if (!approvalId) {
    const [inserted] = await db
      .insert(schema.pendingApprovals)
      .values({
        userId: ad.userId,
        launchedAdId: ad.id,
        actionType: 'scale',
        proposedPayload: {
          new_budget_usd,
          from_budget_usd: Number(ad.dailyBudgetUsd),
        },
        reason: 'API /api/v1/launched_ads/:id/scale',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.pendingApprovals.id });
    if (!inserted)
      return apiError('internal_error', 'Could not create approval row.', { status: 500 });
    approvalId = inserted.id;
  }
  await inngest.send({
    name: 'approval/decision.received',
    data: { approvalId, decision: 'confirm' },
  });
  return apiOk(
    {
      launched_ad_id: ad.id,
      approval_id: approvalId,
      from_budget_usd: Number(ad.dailyBudgetUsd),
      new_budget_usd,
      status: 'scale_requested',
      message: 'Scale dispatched. The Meta budget update runs in the background.',
    },
    { status: 202 },
  );
});
