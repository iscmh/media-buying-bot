import { and, eq, inArray } from 'drizzle-orm';
import {
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  deleteAdSet,
  deleteCampaign,
  effectiveLaunchMode,
  fetchMetaVideoThumbnail,
  pollMetaVideoReady,
  uploadAdImage,
  uploadAdVideo,
  type CreativeMedia,
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
import { logInngestFailure } from '../error-hook';
import { sendTelegramAlert } from '../telegram-notify';

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
  {
    id: 'meta-ad-launcher',
    name: 'Meta ad launcher',
    retries: 1,
    // Polish-25.7 Commit 46: post-retry failures land in error_log.
    onFailure: logInngestFailure,
  },
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
            // Polish-3.6: pull contentType so the launch path can route
            // UGC variants through the video creative pipeline instead
            // of the image one.
            columns: { id: true, offerUrl: true, nicheTag: true, contentType: true },
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
          // Polish-3.5: per-account currency + min-budget override drive
          // USD→minor-units conversion inside createAdSet.
          accountCurrency: true,
          minDailyBudgetMinor: true,
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
        // Polish-3.6: drives image-vs-video routing in the per-variant
        // creative builder below.
        conceptContentType: (concept?.contentType ?? 'static') as 'static' | 'ugc' | string,
        offerUrl: event.data.offerUrl ?? concept?.offerUrl ?? 'https://example.com',
        nicheTag: concept?.nicheTag ?? null,
        adAccountId: effectiveAdAccountId,
        accessToken,
        dailyBudgetUsd,
        optimizationGoal: (event.data.optimizationGoal ??
          settings.defaultOptimizationGoal) as MetaOptimizationGoal,
        placementType: settings.defaultPlacementType as MetaPlacementType,
        pageId: pageId ?? 'dry_run_page_id',
        targetingCountries: event.data.targetingCountries ?? settings.defaultTargetingCountries,
        ageMin: event.data.ageMin ?? settings.defaultAgeMin,
        ageMax: event.data.ageMax ?? settings.defaultAgeMax,
        // Polish-3.5: pass currency + per-account min into createAdSet so
        // the daily_budget field reaches Meta in the right currency +
        // minor units.
        accountCurrency: metaConn?.accountCurrency ?? null,
        minDailyBudgetMinor: metaConn?.minDailyBudgetMinor ?? null,
        liveLaunchCount: settings.liveLaunchCount,
        // Polish-28.4.0 Commit 98: full launch config forwarded from
        // the launch UI. All optional — unset fields fall through to
        // the pre-98 defaults inside the Meta API layer.
        campaignName: event.data.campaignName,
        campaignObjective: event.data.campaignObjective,
        specialAdCategories: event.data.specialAdCategories,
        budgetOptimizationEnabled: event.data.budgetOptimizationEnabled,
        campaignDailyBudgetUsd: event.data.campaignDailyBudgetUsd,
        billingEvent: event.data.billingEvent,
        bidStrategy: event.data.bidStrategy,
        bidAmountUsd: event.data.bidAmountUsd,
        startTime: event.data.startTime,
        endTime: event.data.endTime,
        locales: event.data.locales,
        includedCustomAudienceIds: event.data.includedCustomAudienceIds,
        excludedCustomAudienceIds: event.data.excludedCustomAudienceIds,
        publisherPlatforms: event.data.publisherPlatforms,
        facebookPositions: event.data.facebookPositions,
        instagramPositions: event.data.instagramPositions,
        audienceNetworkPositions: event.data.audienceNetworkPositions,
        messengerPositions: event.data.messengerPositions,
        pixelId: event.data.pixelId,
        customEventType: event.data.customEventType,
        callToActionType: event.data.callToActionType,
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
              // Polish-28.4.0 Commit 98: campaign objective now comes
              // from the launch UI (`campaignObjective`). Fall back to
              // the pre-98 coercion when unset so old callers (Telegram
              // bot, API v1) keep working: use optimizationGoal if it's
              // an OUTCOME_* pseudo-goal, else OUTCOME_TRAFFIC.
              const objective =
                ctx.campaignObjective ??
                (ctx.optimizationGoal.startsWith('OUTCOME_')
                  ? ctx.optimizationGoal
                  : 'OUTCOME_TRAFFIC');
              const campaignName = ctx.campaignName ?? `${baseName} — campaign`;
              const campaign = await createCampaign({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                name: campaignName,
                objective,
                mode: callerMode,
                generationJobId,
                specialAdCategories: ctx.specialAdCategories as never,
                budgetOptimizationEnabled: ctx.budgetOptimizationEnabled,
                campaignDailyBudgetUsd: ctx.campaignDailyBudgetUsd,
                accountCurrency: ctx.accountCurrency ?? undefined,
                minDailyBudgetMinor: ctx.minDailyBudgetMinor ?? undefined,
              });
              if (!campaign.ok) {
                throw new MetaCreateError(
                  campaign.errorMessage ?? 'createCampaign failed',
                  campaign.metaErrorCode,
                  campaign.rawResponse,
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
                accountCurrency: ctx.accountCurrency ?? undefined,
                minDailyBudgetMinor: ctx.minDailyBudgetMinor ?? undefined,
                mode: callerMode,
                generationJobId,
                // Polish-28.4.0 Commit 98: full launch config pass-through.
                cboEnabled: ctx.budgetOptimizationEnabled,
                bidStrategy: ctx.bidStrategy as never,
                bidAmountUsd: ctx.bidAmountUsd,
                billingEvent: ctx.billingEvent as never,
                startTime: ctx.startTime,
                endTime: ctx.endTime,
                locales: ctx.locales,
                includedCustomAudienceIds: ctx.includedCustomAudienceIds,
                excludedCustomAudienceIds: ctx.excludedCustomAudienceIds,
                publisherPlatforms: ctx.publisherPlatforms as never,
                facebookPositions: ctx.facebookPositions,
                instagramPositions: ctx.instagramPositions,
                audienceNetworkPositions: ctx.audienceNetworkPositions,
                messengerPositions: ctx.messengerPositions,
                pixelId: ctx.pixelId,
                customEventType: ctx.customEventType,
              });
              if (!adSet.ok) {
                throw new MetaCreateError(
                  adSet.errorMessage ?? 'createAdSet failed',
                  adSet.metaErrorCode,
                  adSet.rawResponse,
                );
              }
              createdAdSetId = adSet.id;

              // Polish-3.6: branch by media kind. UGC variants are
              // HeyGen video URLs (.mp4 or similar); static variants are
              // Supabase-hosted PNG/JPEG. Meta has separate upload paths
              // (/adimages vs /advideos) and different creative shapes.
              const media = inferMediaKind(variant.fileUrl, ctx.conceptContentType);
              if (media === 'unsupported') {
                throw new MetaCreateError(
                  `Unsupported variant content type for ${variant.fileUrl}. Supported: jpg, png, webp, mp4, mov, webm.`,
                );
              }

              let creativeMedia: CreativeMedia;
              if (media === 'image') {
                // Phase 4b hotfix #2: pre-upload to /adimages, reference
                // the returned hash on link_data.image_hash.
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
                creativeMedia = { kind: 'image', imageHash: imageUpload.imageHash };
              } else {
                // Polish-3.6 video path: upload → poll for ready → fetch
                // thumbnail → build a video_data creative.
                // Polish-3.7: per-variant progress beacons removed —
                // sendProgress nested step.sendEvent inside step.run
                // which Inngest rejects (NESTING_STEPS), causing the
                // function to fail silently. The batch-summary message
                // at the end of the launcher already covers the user.
                const videoUpload = await uploadAdVideo({
                  userId,
                  accessToken: ctx.accessToken,
                  adAccountId: ctx.adAccountId,
                  videoUrl: variant.fileUrl,
                  mode: callerMode,
                  generationJobId,
                });
                if (!videoUpload.ok) {
                  throw new MetaCreateError(
                    videoUpload.errorMessage ?? 'uploadAdVideo failed',
                    videoUpload.metaErrorCode,
                  );
                }

                // Mock mode short-circuits poll + thumbnail — both would
                // hit Meta. Build a dry-run media with a placeholder
                // thumbnail URL.
                if (callerMode === 'mock' || videoUpload.dryRun) {
                  creativeMedia = {
                    kind: 'video',
                    videoId: videoUpload.videoId,
                    thumbnailUrl: 'https://placehold.co/720x1280/png?text=dry+run',
                  };
                } else {
                  const ready = await pollMetaVideoReady({
                    userId,
                    accessToken: ctx.accessToken,
                    videoId: videoUpload.videoId,
                  });
                  if (!ready.ok) {
                    throw new MetaCreateError(
                      ready.errorMessage ?? 'Video did not finish processing',
                    );
                  }
                  const thumb = await fetchMetaVideoThumbnail({
                    userId,
                    accessToken: ctx.accessToken,
                    videoId: videoUpload.videoId,
                  });
                  if (!thumb.ok || !thumb.thumbnailUrl) {
                    throw new MetaCreateError(
                      thumb.errorMessage ?? 'Could not fetch Meta video thumbnail',
                    );
                  }
                  creativeMedia = {
                    kind: 'video',
                    videoId: videoUpload.videoId,
                    thumbnailUrl: thumb.thumbnailUrl,
                  };
                }
              }

              const creative = await createAdCreative({
                userId,
                accessToken: ctx.accessToken,
                adAccountId: ctx.adAccountId,
                name: `${baseName} — creative`,
                media: creativeMedia,
                headline: variant.headline ?? '(no headline)',
                primaryText: variant.primaryText ?? '(no body)',
                description: variant.description,
                destinationUrl: ctx.offerUrl,
                pageId: ctx.pageId,
                mode: callerMode,
                generationJobId,
                callToActionType: ctx.callToActionType as never,
              });
              if (!creative.ok) {
                throw new MetaCreateError(
                  creative.errorMessage ?? 'createAdCreative failed',
                  creative.metaErrorCode,
                  creative.rawResponse,
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
                throw new MetaCreateError(
                  ad.errorMessage ?? 'createAd failed',
                  ad.metaErrorCode,
                  ad.rawResponse,
                );
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
              // Polish-3.5: surface the raw Meta body (when we have it)
              // on launched_ads.meta_response_raw so the UI / Telegram
              // can render error_user_msg + fbtrace_id instead of the
              // generic "Invalid parameter".
              const metaResponseRaw =
                err instanceof MetaCreateError && err.rawResponse !== undefined
                  ? (err.rawResponse as Record<string, unknown>)
                  : undefined;

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
                metaResponseRaw,
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
              // Polish-25.8 Commit 48: fire Telegram rejection alert.
              // sendTelegramAlert honors category-enabled + quiet
              // hours + no-op if user isn't linked. Never throws.
              if (rejectedByMeta) {
                try {
                  await sendTelegramAlert({
                    userId,
                    category: 'rejection_alerts_enabled',
                    text: `❌ Ad rejected by Meta.\n\nVariant: ${variant.id.slice(0, 8)}\nError: ${errorMessage.slice(0, 400)}\n\nOpen /launched in the web app for guidance.`,
                  });
                } catch {
                  // ignore
                }
              }
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
    /** Polish-3.5: raw Meta API response body for forensic display. */
    public readonly rawResponse?: unknown,
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

/**
 * Polish-3.6 media-kind detector.
 *  - Filename extension is the primary signal (works for both Supabase-
 *    hosted images and HeyGen CDN URLs).
 *  - Falls back to the concept's contentType when the extension is
 *    missing (e.g. signed URLs without an extension component).
 *  - Returns 'unsupported' so the caller can fail loud with a clear
 *    error before hitting Meta.
 */
function inferMediaKind(
  fileUrl: string,
  conceptContentType: string,
): 'image' | 'video' | 'unsupported' {
  const lower = fileUrl.toLowerCase();
  if (/\.(jpe?g|png|webp)(\?|#|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|webm)(\?|#|$)/.test(lower)) return 'video';
  // Extension absent — trust the concept's type. UGC concepts always
  // produce video variants (HeyGen Avatar Mode); static concepts always
  // produce images.
  if (conceptContentType === 'ugc') return 'video';
  if (conceptContentType === 'static') return 'image';
  return 'unsupported';
}
