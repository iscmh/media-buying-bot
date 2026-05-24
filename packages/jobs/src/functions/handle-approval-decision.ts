import { and, eq, sql } from 'drizzle-orm';
import { pauseAd, scaleAdBudget, type LaunchMode } from '@mbb/meta-api';
import { decryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

/**
 * Phase 5: the bot's callback_query handler dispatches
 * `approval/decision.received` when the user taps Confirm / Skip on a
 * kill/scale prompt. This function is the executor:
 *
 *   1. Load pending_approvals + verify status='pending' + not expired
 *   2. If decision='skip': mark skipped, audit, done
 *   3. If decision='confirm':
 *        a. Decrypt Meta access token
 *        b. Call pauseAd (kill) or scaleAdBudget (scale) via @mbb/meta-api
 *        c. On success: stamp launched_ads.killed_at / scaled cols +
 *           bump per-user scale_success_count (gates first-5-scales)
 *        d. On failure: mark approval status='confirmed' but launched_ads
 *           gets an error_message; the row's status stays whatever it
 *           was so the user can re-prompt
 *   4. Emit telegram/notify summary so the user sees the outcome
 *
 * All Meta calls go through the same DRY_RUN gating as launches —
 * mock mode just no-ops + logs.
 */

export const handleApprovalDecision = inngest.createFunction(
  { id: 'handle-approval-decision', name: 'Handle approval decision', retries: 1 },
  { event: 'approval/decision.received' },
  async ({ event, step }) => {
    const { approvalId, decision } = event.data;

    // 1. Load + validate.
    const loaded = await step.run('load-approval', async () => {
      const db = getDb();
      const approval = await db.query.pendingApprovals.findFirst({
        where: eq(schema.pendingApprovals.id, approvalId),
      });
      if (!approval) return { ok: false as const, error: 'approval not found' };
      if (approval.status !== 'pending') {
        return { ok: false as const, error: `approval already ${approval.status}` };
      }
      if (approval.expiresAt < new Date()) {
        // Lazy expiration — flip status now.
        await db
          .update(schema.pendingApprovals)
          .set({ status: 'expired', respondedAt: new Date() })
          .where(eq(schema.pendingApprovals.id, approvalId));
        return { ok: false as const, error: 'approval expired (24h limit)' };
      }
      const ad = await db.query.launchedAds.findFirst({
        where: eq(schema.launchedAds.id, approval.launchedAdId),
        columns: {
          id: true,
          userId: true,
          metaAdId: true,
          metaAdSetId: true,
          mode: true,
          dailyBudgetUsd: true,
        },
      });
      if (!ad) return { ok: false as const, error: 'launched_ad not found' };
      return { ok: true as const, approval, ad };
    });

    if (!loaded.ok) {
      await logAuditEvent({
        userId: event.data.approvalId, // we don't have userId at this point
        eventType: 'approval_decision_invalid',
        eventData: { approval_id: approvalId, decision, reason: loaded.error },
      });
      return { ok: false, reason: loaded.error };
    }

    const { approval, ad } = loaded;
    const userId = approval.userId;

    // Polish-7: structured diagnostic logging so every state transition
    // is visible in the Inngest dashboard.
    console.log(
      `[approval-decision] loaded approval=${approvalId} action=${approval.actionType} ` +
        `decision=${decision} ad=${ad.id} meta_ad_id=${ad.metaAdId} status=${ad.mode}`,
    );

    // 2. Skip path.
    if (decision === 'skip') {
      await step.run('mark-skipped', async () => {
        const db = getDb();
        await db
          .update(schema.pendingApprovals)
          .set({ status: 'skipped', respondedAt: new Date() })
          .where(eq(schema.pendingApprovals.id, approvalId));
        // Clear the *_recommended_* fields so the UI stops showing the
        // recommendation badge — user explicitly said no.
        if (approval.actionType === 'kill') {
          await db
            .update(schema.launchedAds)
            .set({ killRecommendedAt: null, killRecommendedReason: null })
            .where(eq(schema.launchedAds.id, ad.id));
        } else {
          await db
            .update(schema.launchedAds)
            .set({
              scaleRecommendedAt: null,
              scaleRecommendedToUsd: null,
              scaleRecommendedReason: null,
            })
            .where(eq(schema.launchedAds.id, ad.id));
        }
      });
      await logAuditEvent({
        userId,
        eventType: 'approval_skipped',
        eventData: {
          approval_id: approvalId,
          launched_ad_id: ad.id,
          action_type: approval.actionType,
        },
      });
      await step.sendEvent('skip-summary', {
        name: 'telegram/notify.requested',
        data: {
          userId,
          message: `⏭ Skipped ${approval.actionType} of ad. Reminder cleared.`,
        },
      });
      return { ok: true, decision: 'skip' };
    }

    // 3. Confirm path — execute on Meta.
    const conn = await step.run('decrypt-token', async () => {
      const db = getDb();
      const metaConn = await db.query.metaConnections.findFirst({
        where: and(
          eq(schema.metaConnections.userId, userId),
          eq(schema.metaConnections.status, 'active'),
        ),
        columns: { accessTokenEncrypted: true },
      });
      let accessToken = '';
      if (metaConn?.accessTokenEncrypted) {
        try {
          accessToken = await decryptSecret(metaConn.accessTokenEncrypted);
        } catch {
          // Empty token only fails the live path — mock still succeeds.
        }
      }
      return { accessToken };
    });

    const mode: LaunchMode = ad.mode === 'live' ? 'live' : 'mock';

    if (approval.actionType === 'kill') {
      if (!ad.metaAdId) {
        await step.run('mark-kill-failed-no-id', async () => {
          const db = getDb();
          await db
            .update(schema.pendingApprovals)
            .set({ status: 'confirmed', respondedAt: new Date() })
            .where(eq(schema.pendingApprovals.id, approvalId));
        });
        return { ok: false, reason: 'no meta_ad_id to pause' };
      }
      console.log(
        `[kill-action] dispatching meta pause for ad=${ad.id} meta_ad_id=${ad.metaAdId} mode=${mode}`,
      );
      const result = await step.run('pause-ad', async () => {
        const r = pauseAd({
          userId,
          accessToken: conn.accessToken,
          adId: ad.metaAdId!,
          mode,
        });
        return r;
      });
      console.log(
        `[kill-action] meta pause response ok=${result.ok} ad=${ad.id}` +
          (result.ok ? '' : ` error=${result.errorMessage}`),
      );
      console.log(`[kill-action] updating launched_ads.status to killed for ad=${ad.id}`);
      await step.run('persist-kill', async () => {
        const db = getDb();
        await db
          .update(schema.pendingApprovals)
          .set({ status: 'confirmed', respondedAt: new Date() })
          .where(eq(schema.pendingApprovals.id, approvalId));
        if (result.ok) {
          await db
            .update(schema.launchedAds)
            .set({
              status: 'killed',
              killConfirmedAt: new Date(),
              killedAt: new Date(),
            })
            .where(eq(schema.launchedAds.id, ad.id));
        }
      });
      await logAuditEvent({
        userId,
        eventType: result.ok ? 'ad_killed' : 'ad_kill_failed',
        eventData: {
          approval_id: approvalId,
          launched_ad_id: ad.id,
          meta_ad_id: ad.metaAdId,
          error: result.ok ? undefined : result.errorMessage,
          mode,
        },
      });
      console.log(`[kill-action] dispatching telegram notification for kill of ad=${ad.id}`);
      await step.sendEvent('kill-summary', {
        name: 'telegram/notify.requested',
        data: {
          userId,
          message: result.ok
            ? `🔻 Killed (paused) ad. Reversible in Ads Manager.`
            : `❌ Kill failed: ${result.errorMessage}`,
        },
      });
      return { ok: result.ok, decision: 'confirm', action: 'kill' };
    }

    // Scale path.
    const proposedBudgetUsd = (approval.proposedPayload as { new_budget_usd?: number })
      .new_budget_usd;
    if (!ad.metaAdSetId || proposedBudgetUsd == null) {
      return { ok: false, reason: 'missing meta_ad_set_id or proposed budget' };
    }
    console.log(
      `[scale-action] dispatching meta budget update for ad=${ad.id} ` +
        `adset=${ad.metaAdSetId} from=$${Number(ad.dailyBudgetUsd).toFixed(2)} to=$${proposedBudgetUsd.toFixed(2)} mode=${mode}`,
    );
    const result = await step.run('scale-ad-budget', async () =>
      scaleAdBudget({
        userId,
        accessToken: conn.accessToken,
        adSetId: ad.metaAdSetId!,
        newDailyBudgetUsd: proposedBudgetUsd,
        mode,
      }),
    );
    await step.run('persist-scale', async () => {
      const db = getDb();
      await db
        .update(schema.pendingApprovals)
        .set({ status: 'confirmed', respondedAt: new Date() })
        .where(eq(schema.pendingApprovals.id, approvalId));
      if (result.ok) {
        await db
          .update(schema.launchedAds)
          .set({
            dailyBudgetUsd: proposedBudgetUsd.toFixed(2),
            scaleConfirmedAt: new Date(),
            lastScaledAt: new Date(),
            scaleCount: sql`${schema.launchedAds.scaleCount} + 1`,
            scaleRecommendedAt: null,
            scaleRecommendedToUsd: null,
            scaleRecommendedReason: null,
          })
          .where(eq(schema.launchedAds.id, ad.id));
        // Bump per-user counter — gates the first-5-scales +25% cap.
        await db
          .update(schema.userSettings)
          .set({ scaleSuccessCount: sql`${schema.userSettings.scaleSuccessCount} + 1` })
          .where(eq(schema.userSettings.userId, userId));
      }
    });
    await logAuditEvent({
      userId,
      eventType: result.ok ? 'ad_scaled' : 'ad_scale_failed',
      eventData: {
        approval_id: approvalId,
        launched_ad_id: ad.id,
        meta_ad_set_id: ad.metaAdSetId,
        from_budget_usd: Number(ad.dailyBudgetUsd),
        to_budget_usd: proposedBudgetUsd,
        error: result.ok ? undefined : result.errorMessage,
        mode,
      },
    });
    console.log(
      `[scale-action] meta budget response ok=${result.ok} ad=${ad.id}` +
        (result.ok ? '' : ` error=${result.errorMessage}`),
    );
    console.log(`[scale-action] dispatching telegram notification for scale of ad=${ad.id}`);
    await step.sendEvent('scale-summary', {
      name: 'telegram/notify.requested',
      data: {
        userId,
        message: result.ok
          ? `📈 Scaled ad daily budget to $${proposedBudgetUsd.toFixed(2)}.`
          : `❌ Scale failed: ${result.errorMessage}`,
      },
    });
    return { ok: result.ok, decision: 'confirm', action: 'scale' };
  },
);
