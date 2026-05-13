import { and, eq, inArray } from 'drizzle-orm';
import {
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  deleteAdSet,
  deleteCampaign,
  effectiveLaunchMode,
  uploadAdImage,
  type LaunchMode,
} from '@mbb/meta-api';
import {
  assertDailyLaunchBudgetCap,
  assertFirstLiveLaunchCap,
  decryptSecret,
  getDb,
  incrementLiveLaunchCount,
  logAuditEvent,
  schema,
} from '@mbb/db';
import {
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  type MetaOptimizationGoal,
  type MetaPlacementType,
} from '@mbb/shared';
import { inngest } from '../client';

/**
 * Phase 4a → 4b: take approved generated_creatives for a generation_job
 * and push them to Meta as PAUSED ads. Mode precedence:
 *
 *   event.mode='mock'                      → always mock
 *   event.mode='live' + BOT_DRY_RUN=true   → still mock (env override wins)
 *   event.mode='live' + BOT_DRY_RUN=false  → real Meta calls
 *
 * The mode the user picked is recorded on launched_ads.mode for audit
 * even when env downgrades it — so an operator can see "I asked for
 * live but BOT_DRY_RUN was on" by inspecting the row.
 *
 * Pipeline per approved variant:
 *   campaign → ad_set → ad_creative → ad
 *
 * Concurrency 3, retries 1 (Inngest re-runs whole job on transient
 * failure; per-variant errors are isolated inside the step.run).
 *
 * Phase 4b hard safeguards (all enforced server-side):
 *   - Every Meta payload sets status='PAUSED' (in @mbb/meta-api).
 *   - First-ever live launch session capped at $10 total daily exposure
 *     (assertFirstLiveLaunchCap); counter increments on success.
 *   - 30s per-call timeout (in callMeta).
 *   - 4xx from Meta → launched_ads.status='rejected_by_meta'; 5xx →
 *     Inngest retry (one retry, then 'launch_failed').
 */

const CONCURRENCY = 3;

export const metaAdLauncher = inngest.createFunction(
  { id: 'meta-ad-launcher', name: 'Meta ad launcher', retries: 1 },
  { event: 'meta/launch.requested' },
  async ({ event, step }) => {
    const { userId, generationJobId } = event.data;
    const callerMode: LaunchMode = event.data.mode ?? 'mock';
    const effective = effectiveLaunchMode(callerMode);
    const isEnvDowngrade = callerMode === 'live' && effective === 'mock';
    const startedAt = Date.now();

    // 1. Load context — job, settings, concept, meta connection.
    const ctx = await step.run('load-context', async () => {
      const db = getDb();
      const job = await db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, generationJobId),
        columns: { conceptIds: true, mode: true },
      });
      if (!job) return { ok: false as const, error: 'Generation job not found' };

      const settings = await db.query.userSettings.findFirst({
        where: eq(schema.userSettings.userId, userId),
        columns: {
          defaultAdDailyBudgetUsd: true,
          defaultOptimizationGoal: true,
          defaultPlacementType: true,
          defaultPageId: true,
          defaultTargetingCountries: true,
          defaultAgeMin: true,
          defaultAgeMax: true,
          liveLaunchCount: true,
        },
      });
      if (!settings) return { ok: false as const, error: 'User settings missing' };

      const conceptId = job.conceptIds?.[0];
      const concept = conceptId
        ? await db.query.concepts.findFirst({
            where: eq(schema.concepts.id, conceptId),
            columns: { id: true, offerUrl: true, nicheTag: true },
          })
        : null;

      const metaConn = await db.query.metaConnections.findFirst({
        where: and(
          eq(schema.metaConnections.userId, userId),
          eq(schema.metaConnections.status, 'active'),
        ),
        columns: {
          adAccountIds: true,
          accessTokenEncrypted: true,
        },
      });
      const adAccountId = metaConn?.adAccountIds?.[0];

      // For live mode we need the access token AND a real ad account.
      // For mock mode the placeholder is fine — keeps the audit trail
      // populated in dev.
      let accessToken = '';
      let effectiveAdAccountId = adAccountId;
      if (effective === 'live') {
        if (!adAccountId) {
          return { ok: false as const, error: 'No active Meta connection / ad account' };
        }
        if (!metaConn?.accessTokenEncrypted) {
          return { ok: false as const, error: 'Meta access token not stored — reconnect Meta.' };
        }
        try {
          accessToken = await decryptSecret(metaConn.accessTokenEncrypted);
        } catch (err) {
          return {
            ok: false as const,
            error: `Failed to decrypt Meta access token: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        effectiveAdAccountId = effectiveAdAccountId ?? 'act_dry_run_placeholder';
      }
      if (!effectiveAdAccountId) {
        return { ok: false as const, error: 'No ad account available' };
      }

      // Per-ad daily budget — event-supplied override takes precedence
      // over user defaults, both clamped to the platform ceiling.
      const eventBudget = event.data.perAdBudgetUsd;
      const rawBudget = eventBudget ?? Number(settings.defaultAdDailyBudgetUsd);
      const dailyBudgetUsd = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);

      // pageId: event override > settings default > placeholder.
      const pageId =
        event.data.pageId ??
        settings.defaultPageId ??
        (effective === 'live' ? null : 'dry_run_page_id');
      if (effective === 'live' && !pageId) {
        return {
          ok: false as const,
          error: 'No Meta Page selected. Pick one in the launch dialog or in Settings.',
        };
      }

      return {
        ok: true as const,
        conceptId: concept?.id ?? null,
        offerUrl: event.data.offerUrl ?? concept?.offerUrl ?? 'https://example.com',
        nicheTag: concept?.nicheTag ?? null,
        adAccountId: effectiveAdAccountId,
        accessToken,
        dailyBudgetUsd,
        optimizationGoal: settings.defaultOptimizationGoal as MetaOptimizationGoal,
        placementType: settings.defaultPlacementType as MetaPlacementType,
        pageId: pageId ?? 'dry_run_page_id',
        targetingCountries: event.data.targetingCountries ?? settings.defaultTargetingCountries,
        ageMin: event.data.ageMin ?? settings.defaultAgeMin,
        ageMax: event.data.ageMax ?? settings.defaultAgeMax,
        liveLaunchCount: settings.liveLaunchCount,
      };
    });

    if (!ctx.ok) {
      await markJobFailed(userId, generationJobId, ctx.error);
      return { ok: false, reason: ctx.error };
    }

    // 2. Fetch approved variants.
    const approved = await step.run('fetch-approved-variants', async () => {
      const db = getDb();
      return db.query.generatedCreatives.findMany({
        where: and(
          eq(schema.generatedCreatives.generationJobId, generationJobId),
          eq(schema.generatedCreatives.userId, userId),
          eq(schema.generatedCreatives.status, 'approved'),
        ),
        columns: {
          id: true,
          fileUrl: true,
          headline: true,
          primaryText: true,
          description: true,
          aspectRatio: true,
        },
      });
    });

    if (approved.length === 0) {
      await logAuditEvent({
        userId,
        eventType: 'ad_launch_no_approved_variants',
        eventData: { generation_job_id: generationJobId },
      });
      return { ok: true, launched: 0, failed: 0, reason: 'no approved variants' };
    }

    const plannedBudget = approved.length * ctx.dailyBudgetUsd;

    // 3a. Phase-4b first-launch cap (only fires for true-live first session).
    if (effective === 'live') {
      const firstCap = await step.run('check-first-live-launch-cap', async () =>
        assertFirstLiveLaunchCap(userId, plannedBudget),
      );
      if (!firstCap.allowed) {
        await markJobFailed(userId, generationJobId, firstCap.reason);
        return { ok: false, reason: firstCap.reason };
      }
    }

    // 3b. Regular daily-launch-cap (TZ-aware).
    const cap = await step.run('check-launch-cap', async () =>
      assertDailyLaunchBudgetCap(userId, plannedBudget),
    );
    if (!cap.allowed) {
      await markJobFailed(userId, generationJobId, cap.reason);
      return { ok: false, reason: cap.reason };
    }

    // 4. Per-variant launch pipeline.
    const outcomes: Array<{
      variantId: string;
      ok: boolean;
      rejectedByMeta?: boolean;
      campaignId?: string;
      adSetId?: string;
      creativeId?: string;
      adId?: string;
      error?: string;
    }> = [];

    for (let batchStart = 0; batchStart < approved.length; batchStart += CONCURRENCY) {
      const batch = approved.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (variant, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;
          const baseName = `MBB ${ctx.nicheTag ?? 'concept'} v${variantIndex} ${shortId(variant.id)}`;

          return step.run(`launch-${variant.id}`, async () => {
            // Phase 4b hotfix #2: track which Meta objects we've created
            // so a mid-pipeline failure can roll them back instead of
            // leaving orphans on the user's ad account.
            let createdCampaignId: string | null = null;
            let createdAdSetId: string | null = null;
            try {
              const campaign = await createCampaign({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                name: `${baseName} — campaign`,
                objective: ctx.optimizationGoal.startsWith('OUTCOME_')
                  ? ctx.optimizationGoal
                  : 'OUTCOME_TRAFFIC',
                mode: callerMode,
                generationJobId,
              });
              if (!campaign.ok) {
                throw new MetaCreateError(
                  campaign.errorMessage ?? 'createCampaign failed',
                  campaign.metaErrorCode,
                );
              }
              createdCampaignId = campaign.id;

              const adSet = await createAdSet({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                campaignId: campaign.id,
                name: `${baseName} — ad set`,
                dailyBudgetUsd: ctx.dailyBudgetUsd,
                optimizationGoal: ctx.optimizationGoal,
                placementType: ctx.placementType,
                targetingCountries: ctx.targetingCountries,
                ageMin: ctx.ageMin,
                ageMax: ctx.ageMax,
                mode: callerMode,
                generationJobId,
              });
              if (!adSet.ok) {
                throw new MetaCreateError(
                  adSet.errorMessage ?? 'createAdSet failed',
                  adSet.metaErrorCode,
                );
              }
              createdAdSetId = adSet.id;

              // Phase 4b hotfix #2: pre-upload image to /adimages and
              // pass the returned hash to createAdCreative. Meta rejects
              // image_url inside link_data.
              const imageUpload = await uploadAdImage({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                imageUrl: variant.fileUrl,
                mode: callerMode,
                generationJobId,
              });
              if (!imageUpload.ok) {
                throw new MetaCreateError(
                  imageUpload.errorMessage ?? 'uploadAdImage failed',
                  imageUpload.metaErrorCode,
                );
              }

              const creative = await createAdCreative({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                name: `${baseName} — creative`,
                imageHash: imageUpload.imageHash,
                headline: variant.headline ?? '(no headline)',
                primaryText: variant.primaryText ?? '(no body)',
                description: variant.description,
                destinationUrl: ctx.offerUrl,
                pageId: ctx.pageId,
                mode: callerMode,
                generationJobId,
              });
              if (!creative.ok) {
                throw new MetaCreateError(
                  creative.errorMessage ?? 'createAdCreative failed',
                  creative.metaErrorCode,
                );
              }

              const ad = await createAd({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                adSetId: adSet.id,
                creativeId: creative.id,
                name: baseName,
                mode: callerMode,
                generationJobId,
              });
              if (!ad.ok) {
                throw new MetaCreateError(ad.errorMessage ?? 'createAd failed', ad.metaErrorCode);
              }

              // Persist row + audit.
              const db = getDb();
              await db.insert(schema.launchedAds).values({
                userId,
                generatedCreativeId: variant.id,
                generationJobId,
                conceptId: ctx.conceptId,
                metaCampaignId: campaign.id,
                metaAdSetId: adSet.id,
                metaCreativeId: creative.id,
                metaAdId: ad.id,
                dailyBudgetUsd: ctx.dailyBudgetUsd.toFixed(2),
                optimizationGoal: ctx.optimizationGoal,
                placementType: ctx.placementType,
                // Status mirrors effective: dry_run (mock or env-downgraded
                // live) vs active (real-live; ad is still PAUSED on Meta,
                // 'active' here means it exists on Meta's side).
                status: effective === 'mock' ? 'dry_run' : 'active',
                mode: callerMode,
              });
              await logAuditEvent({
                userId,
                eventType: 'ad_launched',
                eventData: {
                  variant_id: variant.id,
                  generation_job_id: generationJobId,
                  daily_budget_usd: ctx.dailyBudgetUsd,
                  optimization_goal: ctx.optimizationGoal,
                  placement_type: ctx.placementType,
                  meta_campaign_id: campaign.id,
                  meta_ad_set_id: adSet.id,
                  meta_creative_id: creative.id,
                  meta_ad_id: ad.id,
                  caller_mode: callerMode,
                  effective_mode: effective,
                  env_downgrade: isEnvDowngrade,
                },
              });
              return {
                variantId: variant.id,
                ok: true,
                campaignId: campaign.id,
                adSetId: adSet.id,
                creativeId: creative.id,
                adId: ad.id,
              };
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              const rejectedByMeta = err instanceof MetaCreateError && err.metaErrorCode != null;

              // Phase 4b hotfix #2: best-effort orphan cleanup. If we
              // created a campaign and/or ad set before the failure,
              // delete them so the user doesn't see dangling rows in
              // Ads Manager. Each delete is wrapped — cleanup failures
              // are logged but never crash the per-variant outcome.
              const cleanup: {
                attempted: boolean;
                campaign: { id: string; ok: boolean; error?: string } | null;
                adSet: { id: string; ok: boolean; error?: string } | null;
              } = { attempted: false, campaign: null, adSet: null };
              if (createdAdSetId || createdCampaignId) {
                cleanup.attempted = true;
                // Delete ad set first — campaign delete is more likely
                // to succeed once children are gone.
                if (createdAdSetId) {
                  const r = await deleteAdSet({
                    userId,
                    accessToken: ctx.accessToken,
                    objectId: createdAdSetId,
                    mode: callerMode,
                    generationJobId,
                  });
                  cleanup.adSet = { id: createdAdSetId, ok: r.ok, error: r.errorMessage };
                }
                if (createdCampaignId) {
                  const r = await deleteCampaign({
                    userId,
                    accessToken: ctx.accessToken,
                    objectId: createdCampaignId,
                    mode: callerMode,
                    generationJobId,
                  });
                  cleanup.campaign = { id: createdCampaignId, ok: r.ok, error: r.errorMessage };
                }
                await logAuditEvent({
                  userId,
                  eventType: 'meta_orphan_cleanup',
                  eventData: {
                    variant_id: variant.id,
                    generation_job_id: generationJobId,
                    triggering_error: errorMessage,
                    campaign_cleanup: cleanup.campaign,
                    adset_cleanup: cleanup.adSet,
                    caller_mode: callerMode,
                    effective_mode: effective,
                  },
                });
              }

              // Decide which Meta IDs to record on the row. If cleanup
              // succeeded the IDs are gone from Meta — null them out so
              // /launched doesn't link to a nonexistent campaign. If
              // cleanup failed we keep the IDs as a forensic breadcrumb.
              const persistCampaignId =
                createdCampaignId && cleanup.campaign?.ok ? null : createdCampaignId;
              const persistAdSetId = createdAdSetId && cleanup.adSet?.ok ? null : createdAdSetId;

              const db = getDb();
              await db.insert(schema.launchedAds).values({
                userId,
                generatedCreativeId: variant.id,
                generationJobId,
                conceptId: ctx.conceptId,
                metaCampaignId: persistCampaignId,
                metaAdSetId: persistAdSetId,
                dailyBudgetUsd: ctx.dailyBudgetUsd.toFixed(2),
                optimizationGoal: ctx.optimizationGoal,
                placementType: ctx.placementType,
                status: rejectedByMeta ? 'rejected_by_meta' : 'launch_failed',
                mode: callerMode,
                errorMessage,
              });
              await logAuditEvent({
                userId,
                eventType: rejectedByMeta ? 'ad_rejected_by_meta' : 'ad_launch_failed',
                eventData: {
                  variant_id: variant.id,
                  generation_job_id: generationJobId,
                  error: errorMessage,
                  caller_mode: callerMode,
                  effective_mode: effective,
                  cleanup_attempted: cleanup.attempted,
                },
              });
              return { variantId: variant.id, ok: false, rejectedByMeta, error: errorMessage };
            }
          });
        }),
      );
      outcomes.push(...batchResults);
    }

    // 5. Update generated_creatives.status.
    await step.run('update-creative-statuses', async () => {
      const db = getDb();
      const launchedIds = outcomes.filter((o) => o.ok).map((o) => o.variantId);
      const failedIds = outcomes.filter((o) => !o.ok).map((o) => o.variantId);
      if (launchedIds.length > 0) {
        await db
          .update(schema.generatedCreatives)
          .set({ status: 'launched' })
          .where(inArray(schema.generatedCreatives.id, launchedIds));
      }
      if (failedIds.length > 0) {
        await db
          .update(schema.generatedCreatives)
          .set({ status: 'launch_failed' })
          .where(inArray(schema.generatedCreatives.id, failedIds));
      }
    });

    const successCount = outcomes.filter((o) => o.ok).length;
    const rejectedCount = outcomes.filter((o) => o.rejectedByMeta).length;
    const failedCount = outcomes.filter((o) => !o.ok && !o.rejectedByMeta).length;
    const totalBudget = successCount * ctx.dailyBudgetUsd;

    // 6. Increment live-launch counter — per session, on any live success.
    if (effective === 'live' && successCount > 0) {
      await step.run('increment-live-launch-count', () => incrementLiveLaunchCount(userId));
    }

    // 7. Telegram summary.
    const summary = buildSummaryMessage({
      callerMode,
      effective,
      successCount,
      rejectedCount,
      failedCount,
      totalBudget,
      firstErrors: outcomes
        .filter((o) => !o.ok)
        .slice(0, 3)
        .map((o) => o.error ?? 'unknown')
        .filter(Boolean),
    });
    await step.sendEvent('telegram-summary', {
      name: 'telegram/notify.requested',
      data: { userId, message: summary },
    });

    await logAuditEvent({
      userId,
      eventType: 'ad_launch_batch_completed',
      eventData: {
        generation_job_id: generationJobId,
        launched: successCount,
        rejected_by_meta: rejectedCount,
        failed: failedCount,
        total_budget_usd: totalBudget,
        caller_mode: callerMode,
        effective_mode: effective,
        env_downgrade: isEnvDowngrade,
        duration_ms: Date.now() - startedAt,
      },
    });

    return {
      ok: true,
      launched: successCount,
      failed: failedCount,
      rejectedByMeta: rejectedCount,
      totalBudget,
    };
  },
);

class MetaCreateError extends Error {
  constructor(
    message: string,
    public readonly metaErrorCode?: number,
  ) {
    super(message);
    this.name = 'MetaCreateError';
  }
}

function buildSummaryMessage(input: {
  callerMode: LaunchMode;
  effective: LaunchMode;
  successCount: number;
  rejectedCount: number;
  failedCount: number;
  totalBudget: number;
  firstErrors: string[];
}): string {
  const { callerMode, effective, successCount, rejectedCount, failedCount, totalBudget } = input;
  const adsLaunched = `${successCount} ad${successCount === 1 ? '' : 's'} launched`;
  const failsClause =
    rejectedCount + failedCount > 0
      ? `, ${rejectedCount} rejected${failedCount > 0 ? ` + ${failedCount} failed` : ''}`
      : '';
  const budgetClause = `Daily budget if all activated: $${totalBudget.toFixed(2)}`;

  if (effective === 'live') {
    let msg = `LIVE: ${adsLaunched} and PAUSED in Meta${failsClause}. ${budgetClause}. Activate them at business.facebook.com/adsmanager.`;
    if (input.firstErrors.length > 0) {
      msg += `\nErrors: ${input.firstErrors.join(' | ')}`;
    }
    return msg;
  }
  if (callerMode === 'live' && effective === 'mock') {
    return `MOCK (BOT_DRY_RUN active) — would have launched ${successCount} ad${
      successCount === 1 ? '' : 's'
    } live. ${budgetClause}. View at /launched.`;
  }
  return `MOCK: ${adsLaunched}${failsClause}. ${budgetClause}. View at /launched.`;
}

async function markJobFailed(
  userId: string,
  generationJobId: string,
  reason: string,
): Promise<void> {
  await logAuditEvent({
    userId,
    eventType: 'ad_launch_rejected',
    eventData: { generation_job_id: generationJobId, reason },
  });
}

function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 6);
}
