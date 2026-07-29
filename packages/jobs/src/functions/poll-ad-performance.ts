import { and, eq, inArray } from 'drizzle-orm';
import { getAdInsights, type AdInsights, type LaunchMode } from '@mbb/meta-api';
import { assertDailyLaunchBudgetCap, decryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { evaluatePerformance } from '@mbb/shared';
import { inngest } from '../client';

/**
 * Polish-5: shape an AdInsights into the columns we write on every poll.
 * Pure — exposed for unit testing. The poller calls it inline below; the
 * test mocks getAdInsights and asserts this is what gets handed to the
 * launched_ads UPDATE.
 */
export function buildSnapshotUpdate(m: AdInsights, windowKind: string) {
  return {
    metaSpendUsd: m.spendUsd.toFixed(2),
    metaImpressions: m.impressions,
    metaClicks: m.clicks,
    metaConversions: m.conversions,
    // Polish-25.7 Commit 39: persist real conversion value from Meta
    // insights action_values. Zero when Meta didn't return value data;
    // dashboard + /launched fall back to user_settings.
    // assumed_conversion_value_usd × conversions in that case.
    conversionValueUsd: m.conversionValueUsd.toFixed(2),
    currentSpend: m.spendUsd.toFixed(2),
    currentImpressions: m.impressions,
    currentClicks: m.clicks,
    currentCtr: m.ctrPct.toFixed(4),
    currentCpc: m.cpcUsd.toFixed(4),
    currentConversions: m.conversions,
    currentFrequency: m.frequency.toFixed(4),
    currentWindowKind: windowKind,
  };
}

/**
 * Phase 5: scheduled poll across every active launched_ads row. Runs
 * every 30 minutes via Inngest cron; per-user `polling_interval_minutes`
 * gates rows so a user who wants 60-min cadence only gets polled every
 * other tick (we compare last_polled_at + interval ≤ now).
 *
 * Per-ad pipeline:
 *   - getAdInsights via callMeta (mock honors BOT_DRY_RUN)
 *   - UPDATE launched_ads with spend / impressions / clicks / conversions
 *   - evaluatePerformance against user thresholds + remaining launch cap
 *   - If kill / scale: INSERT pending_approvals + sendEvent telegram/notify
 *     with an inline keyboard (Confirm / Skip)
 *
 * Failure isolation: per-ad errors land in the per-ad audit log; siblings
 * continue. The job never throws — Inngest dashboard sees a clean run
 * even when one ad's poll hit a rate limit.
 */

const CONCURRENCY = 5;

export const pollAdPerformance = inngest.createFunction(
  { id: 'poll-ad-performance', name: 'Poll ad performance', retries: 1 },
  // Inngest cron: every 30 minutes. Cron-fired event has empty data.
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const tickAt = new Date();

    // 1. Distinct user IDs with at least one ad in a state that gets
    //    polled. 'active' is the real-live state; 'dry_run' rows also
    //    poll so dev BOT_DRY_RUN sees the loop run end-to-end. Killed /
    //    rejected / failed rows are terminal — skip them.
    const userIds = await step.run('select-active-users', async () => {
      const db = getDb();
      const rows = await db
        .selectDistinct({ userId: schema.launchedAds.userId })
        .from(schema.launchedAds)
        .where(inArray(schema.launchedAds.status, ['active', 'dry_run']));
      return rows.map((r) => r.userId);
    });

    if (userIds.length === 0) {
      return { ok: true, polledUsers: 0, polledAds: 0 };
    }

    let totalPolled = 0;

    for (const userId of userIds) {
      // Per-user setup (one fetch per user — keeps the inner ad loop
      // cheap on shared state).
      const ctx = await step.run(`load-user-${userId}`, async () => {
        const db = getDb();
        const settings = await db.query.userSettings.findFirst({
          where: eq(schema.userSettings.userId, userId),
          columns: {
            pollingIntervalMinutes: true,
            killMaxCpcUsd: true,
            killNoConvSpendUsd: true,
            killMinCtrPct: true,
            scaleMinRoas: true,
            scaleMinSpendUsd: true,
            scaleIncrementPct: true,
            scaleMaxDailyBudgetUsd: true,
            scaleSuccessCount: true,
          },
        });
        if (!settings) return null;

        // Active ads ripe for polling — i.e. either never polled, or
        // last_polled_at older than the user's interval.
        const intervalMs = settings.pollingIntervalMinutes * 60_000;
        const cutoff = new Date(tickAt.getTime() - intervalMs + 60_000); // 1-min grace
        const ads = await db.query.launchedAds.findMany({
          where: and(
            eq(schema.launchedAds.userId, userId),
            inArray(schema.launchedAds.status, ['active', 'dry_run']),
          ),
          columns: {
            id: true,
            metaAdId: true,
            metaAdSetId: true,
            dailyBudgetUsd: true,
            mode: true,
            lastPolledAt: true,
            status: true,
          },
        });
        const ripe = ads.filter((a) => !a.lastPolledAt || a.lastPolledAt < cutoff);

        // Pending approvals for these ads — used to short-circuit
        // double-prompting in the decision engine.
        const pending = ripe.length
          ? await db.query.pendingApprovals.findMany({
              where: and(
                eq(schema.pendingApprovals.userId, userId),
                eq(schema.pendingApprovals.status, 'pending'),
                inArray(
                  schema.pendingApprovals.launchedAdId,
                  ripe.map((a) => a.id),
                ),
              ),
              columns: { launchedAdId: true },
            })
          : [];
        // Return as array — Inngest's Jsonify won't preserve a Set.
        // Caller reconstructs.
        const pendingAdIdArray: string[] = pending.map((p) => p.launchedAdId);

        // Active Meta connection — required to decrypt the access token
        // for live mode. dry_run rows don't need it.
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
            // Keep going with empty token — only live polling will fail,
            // mock rows still loop fine.
          }
        }

        return { settings, ripe, pendingAdIdArray, accessToken };
      });

      if (!ctx) continue;
      if (ctx.ripe.length === 0) continue;
      const pendingAdIds = new Set(ctx.pendingAdIdArray);

      // Remaining daily launch cap — fed into the decision engine so a
      // proposed scale can't blow past the user's daily commit cap.
      const cap = await step.run(`launch-cap-${userId}`, async () =>
        assertDailyLaunchBudgetCap(userId, 0),
      );
      const remainingDailyLaunchBudgetUsd = cap.allowed
        ? cap.remainingUsd
        : Math.max(0, cap.capUsd - cap.committedTodayUsd);

      // Poll in concurrency-capped batches.
      for (let i = 0; i < ctx.ripe.length; i += CONCURRENCY) {
        const batch = ctx.ripe.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map((ad) =>
            step.run(`poll-${ad.id}`, async () => {
              if (!ad.metaAdId) {
                return { ok: false, reason: 'no meta_ad_id' };
              }
              const mode: LaunchMode = ad.mode === 'live' ? 'live' : 'mock';
              const insightsResult = await getAdInsights({
                userId,
                accessToken: ctx.accessToken,
                adId: ad.metaAdId,
                mode,
              });
              if (!insightsResult.ok || !insightsResult.insights) {
                await logAuditEvent({
                  userId,
                  eventType: 'poll_insights_failed',
                  eventData: {
                    launched_ad_id: ad.id,
                    error: insightsResult.errorMessage,
                  },
                });
                return { ok: false };
              }
              const m = insightsResult.insights;

              const db = getDb();
              await db
                .update(schema.launchedAds)
                .set({
                  lastPolledAt: tickAt,
                  ...buildSnapshotUpdate(m, 'last_7d'),
                })
                .where(eq(schema.launchedAds.id, ad.id));

              // Decision engine.
              const decision = evaluatePerformance({
                currentDailyBudgetUsd: Number(ad.dailyBudgetUsd),
                metrics: m,
                hasPendingApproval: pendingAdIds.has(ad.id),
                settings: {
                  killMaxCpcUsd: Number(ctx.settings.killMaxCpcUsd),
                  killNoConvSpendUsd: Number(ctx.settings.killNoConvSpendUsd),
                  killMinCtrPct: Number(ctx.settings.killMinCtrPct),
                  scaleMinRoas: Number(ctx.settings.scaleMinRoas),
                  scaleMinSpendUsd: Number(ctx.settings.scaleMinSpendUsd),
                  scaleIncrementPct: Number(ctx.settings.scaleIncrementPct),
                  scaleMaxDailyBudgetUsd: Number(ctx.settings.scaleMaxDailyBudgetUsd),
                  scaleSuccessCount: ctx.settings.scaleSuccessCount,
                  remainingDailyLaunchBudgetUsd,
                },
              });

              // Polish-7: structured diagnostic logging for every evaluator decision.
              console.log(
                `[evaluator] ad=${ad.id} decision=${decision.action} reason=${decision.reason ?? 'n/a'} ` +
                  `spend=$${m.spendUsd.toFixed(2)} cpc=$${m.cpcUsd.toFixed(2)} ctr=${m.ctrPct.toFixed(2)}% conv=${m.conversions}`,
              );

              if (decision.action === 'no_action') {
                return { ok: true, decision: 'no_action' };
              }

              // Insert pending_approvals row + dispatch Telegram prompt.
              const approvalId = await createPendingApproval({
                userId,
                launchedAdId: ad.id,
                actionType: decision.action,
                proposedBudgetUsd: decision.proposedBudgetUsd ?? null,
                fromBudgetUsd: Number(ad.dailyBudgetUsd),
                reason: decision.reason,
              });

              // Mark the *_recommended_* columns so the UI can show
              // "kill recommended" / "scale recommended" badges before
              // the user acts.
              const recommendedAt = new Date();
              if (decision.action === 'kill') {
                await db
                  .update(schema.launchedAds)
                  .set({
                    killRecommendedAt: recommendedAt,
                    killRecommendedReason: decision.reason,
                  })
                  .where(eq(schema.launchedAds.id, ad.id));
              } else {
                await db
                  .update(schema.launchedAds)
                  .set({
                    scaleRecommendedAt: recommendedAt,
                    scaleRecommendedToUsd:
                      decision.proposedBudgetUsd != null
                        ? decision.proposedBudgetUsd.toFixed(2)
                        : null,
                    scaleRecommendedReason: decision.reason,
                  })
                  .where(eq(schema.launchedAds.id, ad.id));
              }

              const summary = buildPromptMessage({
                action: decision.action,
                reason: decision.reason,
                metrics: m,
                fromBudgetUsd: Number(ad.dailyBudgetUsd),
                proposedBudgetUsd: decision.proposedBudgetUsd,
                capApplied: decision.scaleCapApplied,
              });

              await step.sendEvent('approval-prompt', {
                name: 'telegram/notify.requested',
                data: {
                  userId,
                  message: summary,
                  inlineButtons: [
                    [
                      {
                        text: decision.action === 'kill' ? '✅ Confirm Kill' : '✅ Confirm Scale',
                        callbackData: `approve:${approvalId}:confirm`,
                      },
                      { text: '⏭ Skip', callbackData: `approve:${approvalId}:skip` },
                    ],
                  ],
                },
              });

              await logAuditEvent({
                userId,
                eventType: 'kill_scale_recommended',
                eventData: {
                  launched_ad_id: ad.id,
                  approval_id: approvalId,
                  action: decision.action,
                  reason: decision.reason,
                  proposed_budget_usd: decision.proposedBudgetUsd ?? null,
                  scale_cap_applied: decision.scaleCapApplied ?? null,
                },
              });

              return { ok: true, decision: decision.action, approvalId };
            }),
          ),
        );
        totalPolled += batch.length;
      }
    }

    return { ok: true, polledUsers: userIds.length, polledAds: totalPolled };
  },
);

async function createPendingApproval(input: {
  userId: string;
  launchedAdId: string;
  actionType: 'kill' | 'scale';
  proposedBudgetUsd: number | null;
  fromBudgetUsd: number;
  reason: string;
}): Promise<string> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const proposedPayload =
    input.actionType === 'scale'
      ? {
          new_budget_usd: input.proposedBudgetUsd,
          from_budget_usd: input.fromBudgetUsd,
        }
      : {};
  const [row] = await db
    .insert(schema.pendingApprovals)
    .values({
      userId: input.userId,
      launchedAdId: input.launchedAdId,
      actionType: input.actionType,
      proposedPayload,
      reason: input.reason,
      expiresAt,
    })
    .returning({ id: schema.pendingApprovals.id });
  return row!.id;
}

function buildPromptMessage(input: {
  action: 'kill' | 'scale';
  reason: string;
  metrics: {
    spendUsd: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctrPct: number;
    cpcUsd: number;
  };
  fromBudgetUsd: number;
  proposedBudgetUsd?: number;
  capApplied:
    | 'first_scales_grace'
    | 'hard_2x'
    | 'settings_max'
    | 'remaining_daily_launch_cap'
    | null
    | undefined;
}): string {
  const { metrics } = input;
  const stats =
    `Spend $${metrics.spendUsd.toFixed(2)} · CTR ${metrics.ctrPct.toFixed(2)}% · ` +
    `CPC $${metrics.cpcUsd.toFixed(2)} · Conv ${metrics.conversions}`;
  if (input.action === 'kill') {
    return `🔻 Recommended: KILL ad\n\n${input.reason}\n${stats}\n\nKill just pauses the ad — reversible in Ads Manager. Tap below.`;
  }
  const capTag = input.capApplied ? ` (capped by ${humanCap(input.capApplied)})` : '';
  return (
    `📈 Recommended: SCALE ad\n\n${input.reason}\n${stats}\n` +
    `Budget: $${input.fromBudgetUsd.toFixed(2)} → $${(input.proposedBudgetUsd ?? input.fromBudgetUsd).toFixed(2)}${capTag}\n\n` +
    `Scale increases daily spend. Tap below.`
  );
}

function humanCap(
  cap: 'first_scales_grace' | 'hard_2x' | 'settings_max' | 'remaining_daily_launch_cap',
): string {
  switch (cap) {
    case 'first_scales_grace':
      return 'first-5-scales +25% cap';
    case 'hard_2x':
      return 'hard 2× per-event cap';
    case 'settings_max':
      return 'your max daily budget';
    case 'remaining_daily_launch_cap':
      return 'remaining daily launch cap';
  }
}
