import { and, eq, inArray } from 'drizzle-orm';
import { createAd, createAdCreative, createAdSet, createCampaign } from '@mbb/meta-api';
import { assertDailyLaunchBudgetCap, getDb, logAuditEvent, schema } from '@mbb/db';
import {
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  type MetaOptimizationGoal,
  type MetaPlacementType,
} from '@mbb/shared';
import { inngest } from '../client';

/**
 * Phase 4a: take approved generated_creatives for a generation_job and
 * push them to Meta as paused ads. In DRY_RUN mode (the only supported
 * mode in Phase 4a) every Meta call is short-circuited at the
 * @mbb/meta-api layer and a `dry_run_<uuid>` id is returned.
 *
 * Pipeline (per approved variant):
 *   campaign  → ad_set  → ad_creative  → ad
 *
 * Each variant gets its own campaign so kill/scale (Phase 5) can act on
 * one variant at a time without touching siblings. Concurrency cap of 3
 * keeps the rate-limiter happy in the eventual live path.
 *
 * Failure isolation: per-variant errors land in launched_ads with
 * status='launch_failed' + error_message; siblings continue. The
 * generation_job's overall status stays 'completed' (the launch
 * pipeline is separate from generation).
 */

const CONCURRENCY = 3;

export const metaAdLauncher = inngest.createFunction(
  { id: 'meta-ad-launcher', name: 'Meta ad launcher', retries: 1 },
  { event: 'meta/launch.requested' },
  async ({ event, step }) => {
    const { userId, generationJobId } = event.data;
    const startedAt = Date.now();
    const dryRun = (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';
    const mode: 'mock' | 'live' = dryRun ? 'mock' : 'live';

    // 1. Load job, settings, concept (for offerUrl), meta connection.
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
        },
      });
      if (!settings) return { ok: false as const, error: 'User settings missing' };

      const conceptId = job.conceptIds?.[0];
      const concept = conceptId
        ? await db.query.concepts.findFirst({
            where: eq(schema.concepts.id, conceptId),
            columns: { id: true, offerUrl: true, nicheTag: true, staticHeadline: true },
          })
        : null;

      const metaConn = await db.query.metaConnections.findFirst({
        where: and(
          eq(schema.metaConnections.userId, userId),
          eq(schema.metaConnections.status, 'active'),
        ),
        columns: { adAccountIds: true, businessManagerId: true },
      });
      const adAccountId = metaConn?.adAccountIds?.[0];
      // In DRY_RUN we tolerate a missing ad account — log a placeholder so
      // the audit trail is still complete. Phase 4b must reject here.
      const effectiveAdAccountId = adAccountId ?? (dryRun ? 'act_dry_run_placeholder' : null);
      if (!effectiveAdAccountId) {
        return { ok: false as const, error: 'No active Meta connection / ad account' };
      }

      // Per-ad daily budget clamped server-side to PLATFORM_HARD_AD_DAILY_BUDGET_USD.
      const rawBudget = Number(settings.defaultAdDailyBudgetUsd);
      const dailyBudgetUsd = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);

      return {
        ok: true as const,
        conceptId: concept?.id ?? null,
        offerUrl: concept?.offerUrl ?? 'https://example.com',
        nicheTag: concept?.nicheTag ?? null,
        adAccountId: effectiveAdAccountId,
        dailyBudgetUsd,
        optimizationGoal: settings.defaultOptimizationGoal as MetaOptimizationGoal,
        placementType: settings.defaultPlacementType as MetaPlacementType,
        // Phase 4a has no page_id column on meta_connections yet. Use a
        // dry-run placeholder. Phase 4b must store the user's page_id.
        pageId: dryRun ? 'dry_run_page_id' : 'PLACEHOLDER_PAGE_ID',
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

    // 3. Daily-launch-cap check — sum of approved * default budget.
    const plannedBudget = approved.length * ctx.dailyBudgetUsd;
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
            try {
              const campaign = await createCampaign({
                userId,
                adAccountId: ctx.adAccountId,
                name: `${baseName} — campaign`,
                objective: ctx.optimizationGoal.startsWith('OUTCOME_')
                  ? ctx.optimizationGoal
                  : 'OUTCOME_SALES',
                generationJobId,
              });
              if (!campaign.ok) throw new Error(campaign.errorMessage ?? 'createCampaign failed');

              const adSet = await createAdSet({
                userId,
                adAccountId: ctx.adAccountId,
                campaignId: campaign.id,
                name: `${baseName} — ad set`,
                dailyBudgetUsd: ctx.dailyBudgetUsd,
                optimizationGoal: ctx.optimizationGoal,
                placementType: ctx.placementType,
                generationJobId,
              });
              if (!adSet.ok) throw new Error(adSet.errorMessage ?? 'createAdSet failed');

              const creative = await createAdCreative({
                userId,
                adAccountId: ctx.adAccountId,
                name: `${baseName} — creative`,
                imageUrl: variant.fileUrl,
                headline: variant.headline ?? '(no headline)',
                primaryText: variant.primaryText ?? '(no body)',
                description: variant.description,
                destinationUrl: ctx.offerUrl,
                pageId: ctx.pageId,
                generationJobId,
              });
              if (!creative.ok) throw new Error(creative.errorMessage ?? 'createAdCreative failed');

              const ad = await createAd({
                userId,
                adAccountId: ctx.adAccountId,
                adSetId: adSet.id,
                creativeId: creative.id,
                name: baseName,
                generationJobId,
              });
              if (!ad.ok) throw new Error(ad.errorMessage ?? 'createAd failed');

              // Persist launched_ads + audit + update variant status.
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
                status: dryRun ? 'dry_run' : 'active',
                mode,
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
                  mode,
                  dry_run: dryRun,
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
              const db = getDb();
              await db.insert(schema.launchedAds).values({
                userId,
                generatedCreativeId: variant.id,
                generationJobId,
                conceptId: ctx.conceptId,
                dailyBudgetUsd: ctx.dailyBudgetUsd.toFixed(2),
                optimizationGoal: ctx.optimizationGoal,
                placementType: ctx.placementType,
                status: 'launch_failed',
                mode,
                errorMessage,
              });
              await logAuditEvent({
                userId,
                eventType: 'ad_launch_failed',
                eventData: {
                  variant_id: variant.id,
                  generation_job_id: generationJobId,
                  error: errorMessage,
                  mode,
                },
              });
              return { variantId: variant.id, ok: false, error: errorMessage };
            }
          });
        }),
      );
      outcomes.push(...batchResults);
    }

    // 5. Update generated_creatives.status to 'launched' / 'launch_failed'.
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

    // 6. Telegram summary. Dispatched via the existing telegram/notify
    // event so the notifier owns the chat-id lookup + send retry.
    const successCount = outcomes.filter((o) => o.ok).length;
    const failedCount = outcomes.length - successCount;
    const totalBudget = successCount * ctx.dailyBudgetUsd;
    const summary =
      `${dryRun ? 'DRY_RUN: ' : ''}` +
      `${successCount} ad${successCount === 1 ? '' : 's'} launched` +
      (failedCount > 0 ? `, ${failedCount} failed` : '') +
      `. Daily budget committed: $${totalBudget.toFixed(2)}. ` +
      `View at /launched.`;
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
        failed: failedCount,
        total_budget_usd: totalBudget,
        mode,
        duration_ms: Date.now() - startedAt,
      },
    });

    return { ok: true, launched: successCount, failed: failedCount, totalBudget };
  },
);

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
