import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { inngest } from '@mbb/jobs';
import { apiError, apiOk } from '@/lib/api-envelope';
import { withApi } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polish-25.10 Commit 59: POST /api/v1/launched_ads/:id/kill
 *
 * Mirrors approveKillAction — creates (or reuses) the pending_approvals
 * row, then dispatches approval/decision.received. The worker
 * (handle-approval-decision) does the actual Meta pauseAd call.
 * This mirror-through-approvals path preserves the safety envelope
 * around every kill (retry logic, audit rows, Telegram alerts).
 */
export const POST = withApi('launched_ads.kill', async (_req, ctx) => {
  const launchedAdId = String(ctx.params?.id ?? '');
  if (!launchedAdId) return apiError('validation_error', 'Missing launched ad id.');
  const db = getDb();
  const ad = await db.query.launchedAds.findFirst({
    where: and(eq(schema.launchedAds.id, launchedAdId), eq(schema.launchedAds.userId, ctx.userId)),
    columns: { id: true, userId: true, killRecommendedAt: true, status: true },
  });
  if (!ad) return apiError('not_found', 'Launched ad not found.');
  if (ad.status === 'killed') {
    return apiOk({ launched_ad_id: ad.id, status: 'killed', changed: false });
  }

  const existing = await db.query.pendingApprovals.findFirst({
    where: and(
      eq(schema.pendingApprovals.launchedAdId, ad.id),
      eq(schema.pendingApprovals.actionType, 'kill'),
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
        actionType: 'kill',
        proposedPayload: {},
        reason: 'API /api/v1/launched_ads/:id/kill',
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
      status: 'kill_requested',
      message: 'Kill dispatched. The Meta pause runs in the background.',
    },
    { status: 202 },
  );
});
