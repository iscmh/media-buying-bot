'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { checkMakeugcVideoStatus, estimateMakeugcVideoCostUsd } from '@mbb/ai-providers';
import {
  assertDailyLaunchBudgetCap,
  assertFirstLiveLaunchCap,
  decryptSecret,
  getDb,
  logAuditEvent,
  schema,
} from '@mbb/db';
import { resolveMakeugcKey } from '@mbb/jobs';
import { fetchUserPages } from '@mbb/meta-api';
import {
  OfferUrlSchema,
  POLISH_VERSION,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  checkBudgetMeetsMetaMinimum,
} from '@mbb/shared';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { sendMetaLaunchEvent } from '@/lib/inngest/send';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { withErrorLogging } from '@/lib/with-error-logging';

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

  revalidatePath(`/runs/${variant.generationJobId}`);
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

  revalidatePath(`/runs/${jobId}`);
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
 * Phase 4b: first-time live launch acknowledgment. Idempotent. The
 * triple-confirm dialog calls this AFTER all three checkboxes are
 * checked; we trust the client to gate but server side audits the
 * intent and persists the timestamp.
 */
export async function acknowledgeLiveLaunchAction(): Promise<{
  ok: boolean;
  errorMessage?: string;
}> {
  const user = await requireUser();
  const db = getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.id),
    columns: { liveLaunchAcknowledgedAt: true },
  });
  if (existing?.liveLaunchAcknowledgedAt) {
    return { ok: true };
  }
  await db
    .update(schema.userSettings)
    .set({ liveLaunchAcknowledgedAt: new Date() })
    .where(eq(schema.userSettings.userId, user.id));
  await logAuditEvent({
    userId: user.id,
    eventType: 'live_launch_first_acknowledged',
    eventData: { _meta: await auditMetaFromHeaders() },
  });
  return { ok: true };
}

/**
 * Phase 4b: refresh the user's Facebook Pages from /me/accounts and
 * upsert into meta_pages. Returns the freshly fetched list so the
 * caller can update the dropdown. Falls back to cached rows on error.
 */
export async function refreshMetaPagesAction(): Promise<{
  ok: boolean;
  pages: Array<{ pageId: string; pageName: string }>;
  errorMessage?: string;
}> {
  const user = await requireUser();
  const db = getDb();
  const metaConn = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, user.id),
      eq(schema.metaConnections.status, 'active'),
    ),
    columns: { accessTokenEncrypted: true },
  });
  if (!metaConn?.accessTokenEncrypted) {
    return { ok: false, pages: [], errorMessage: 'No active Meta connection.' };
  }
  let accessToken: string;
  try {
    accessToken = await decryptSecret(metaConn.accessTokenEncrypted);
  } catch (err) {
    return {
      ok: false,
      pages: [],
      errorMessage: `Failed to decrypt Meta access token: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = await fetchUserPages({ userId: user.id, accessToken });
  return {
    ok: result.ok,
    pages: result.pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName })),
    errorMessage: result.errorMessage,
  };
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
export interface LaunchApprovedInput {
  jobId: string;
  /** Phase 4b — 'live' triggers extra ack + first-launch cap. */
  mode?: 'mock' | 'live';
  pageId?: string;
  offerUrl?: string;
  targetingCountries?: string[];
  ageMin?: number;
  ageMax?: number;
  /** Per-ad daily budget override; clamped server-side. */
  perAdBudgetUsd?: number;
  // Polish-28.4.0 Commit 98: full launch config from the sectioned
  // launch UI. All optional — pre-98 callers keep working with the
  // old shape and get the same behavior as before.
  campaignName?: string;
  campaignObjective?: string;
  specialAdCategories?: string[];
  budgetOptimizationEnabled?: boolean;
  campaignDailyBudgetUsd?: number;
  optimizationGoal?: string;
  /** Polish-28.4.1 Commit 99: 'advantage_plus' | 'manual'. */
  placementType?: string;
  billingEvent?: string;
  bidStrategy?: string;
  bidAmountUsd?: number;
  startTime?: string;
  endTime?: string;
  locales?: number[];
  includedCustomAudienceIds?: string[];
  excludedCustomAudienceIds?: string[];
  publisherPlatforms?: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
  audienceNetworkPositions?: string[];
  messengerPositions?: string[];
  pixelId?: string;
  customEventType?: string;
  callToActionType?: string;
  advantageAudienceEnabled?: boolean;
}

// Polish-25.7 Commit 46: wrapped below via withErrorLogging so any
// unexpected throw lands in error_log with source='server_action' +
// sourceName='launchApprovedAction'. Expected user-facing failures
// return `{ ok: false, errorMessage }` and are NOT logged.
async function launchApprovedActionImpl(input: LaunchApprovedInput): Promise<LaunchApprovedResult> {
  const user = await requireUser();
  const db = getDb();
  // Polish-3.5: UI no longer surfaces a mode toggle on launch. Default
  // is 'live'; the 'mock' branch survives for CLI/test callers that
  // explicitly post it.
  const mode: 'mock' | 'live' = input.mode ?? 'live';

  // 1. Verify ownership.
  const job = await db.query.generationJobs.findFirst({
    where: and(
      eq(schema.generationJobs.id, input.jobId),
      eq(schema.generationJobs.userId, user.id),
    ),
    columns: { id: true },
  });
  if (!job) return { ok: false, errorMessage: 'Job not found.' };

  // 2. Phase-4a launch ack must be set (any mode).
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.id),
    columns: {
      launchAcknowledgedAt: true,
      liveLaunchAcknowledgedAt: true,
      defaultAdDailyBudgetUsd: true,
    },
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
  // Phase-4b: live mode requires the additional triple-confirm ack.
  if (mode === 'live' && !settings.liveLaunchAcknowledgedAt) {
    return {
      ok: false,
      errorMessage:
        'You must complete the first-time live-launch confirmation before launching live.',
    };
  }
  if (mode === 'live' && !input.pageId) {
    return { ok: false, errorMessage: 'Pick a Facebook Page for the ad creative.' };
  }

  // Polish-25.2 Commit 15: server-side URL validation. Client already
  // gates the Launch button on OfferUrlSchema.safeParse, but a caller
  // that skips the client (CLI, direct action invocation, browser
  // extension) still needs to hit this. Malformed URLs would be
  // caught by Meta and land as launched_ads.status='rejected_by_meta'
  // — cleaner to bounce here with a clear message.
  if (mode === 'live') {
    const parsed = OfferUrlSchema.safeParse(input.offerUrl ?? '');
    if (!parsed.success) {
      return {
        ok: false,
        errorMessage: `Offer URL is invalid: ${parsed.error.issues[0]?.message ?? 'malformed URL'}`,
      };
    }
  }

  // Polish-3.5: validate the picked page against the snapshot we stored
  // at connect time. Catches stale UI state (page deleted from Meta,
  // user revoked admin) BEFORE the launch hits Meta with a generic
  // "Invalid parameter".
  if (mode === 'live' && input.pageId) {
    const conn = await db.query.metaConnections.findFirst({
      where: and(
        eq(schema.metaConnections.userId, user.id),
        eq(schema.metaConnections.status, 'active'),
      ),
      columns: { pages: true, accountCurrency: true, minDailyBudgetMinor: true },
    });
    const pages = (conn?.pages ?? []) as Array<{ id: string; tasks?: string[] }>;
    if (pages.length === 0) {
      return {
        ok: false,
        errorMessage:
          'No Facebook Pages on your Meta connection. Reconnect Meta in /connections/meta. The bot needs at least one Page you admin to create ads.',
      };
    }
    const match = pages.find((p) => p.id === input.pageId);
    if (!match) {
      return {
        ok: false,
        errorMessage: `Page ${input.pageId} is not in your Meta connection. Pick one from the dropdown or reconnect to refresh.`,
      };
    }
    // Optional but actionable: warn if the user can't post on this page.
    if (match.tasks && !match.tasks.includes('CREATE_CONTENT')) {
      return {
        ok: false,
        errorMessage: `You don't have CREATE_CONTENT permission on this Page in Meta. Pick a different Page or update your role at business.facebook.com.`,
      };
    }

    // Polish-3.5: pre-flight the budget against the account's currency
    // minimum. Surfaces a clear message BEFORE the Inngest worker hits
    // Meta with a 4xx.
    if (conn?.accountCurrency) {
      const rawBudget = input.perAdBudgetUsd ?? Number(settings.defaultAdDailyBudgetUsd);
      const perAd = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);
      const budgetCheck = checkBudgetMeetsMetaMinimum({
        usdAmount: perAd,
        currency: conn.accountCurrency,
        connectionMin: conn.minDailyBudgetMinor ?? null,
      });
      if (!budgetCheck.ok) {
        return { ok: false, errorMessage: budgetCheck.reason };
      }
    }
  }

  // 3. Count approved variants.
  const approved = await db.query.generatedCreatives.findMany({
    where: and(
      eq(schema.generatedCreatives.generationJobId, input.jobId),
      eq(schema.generatedCreatives.userId, user.id),
      eq(schema.generatedCreatives.status, 'approved'),
    ),
    columns: { id: true },
  });
  if (approved.length === 0) {
    return { ok: false, errorMessage: 'No approved variants to launch.' };
  }

  // 4. Daily cap math (server-side).
  const rawBudget = input.perAdBudgetUsd ?? Number(settings.defaultAdDailyBudgetUsd);
  const perAdBudget = Math.min(rawBudget, PLATFORM_HARD_AD_DAILY_BUDGET_USD);
  const plannedBudgetUsd = approved.length * perAdBudget;

  // 4a. Phase-4b first-launch hard cap (live only, real-live path: the
  // launch job will re-check too — defense in depth).
  if (mode === 'live') {
    const firstCap = await assertFirstLiveLaunchCap(user.id, plannedBudgetUsd);
    if (!firstCap.allowed) {
      return {
        ok: false,
        errorMessage: firstCap.reason,
        plannedBudgetUsd,
      };
    }
  }

  // 4b. Regular daily-launch-cap.
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
      job_id: input.jobId,
      approved_count: approved.length,
      planned_budget_usd: plannedBudgetUsd,
      mode,
      _meta: await auditMetaFromHeaders(),
    },
  });
  await sendMetaLaunchEvent({
    userId: user.id,
    generationJobId: input.jobId,
    mode,
    pageId: input.pageId,
    offerUrl: input.offerUrl,
    targetingCountries: input.targetingCountries,
    ageMin: input.ageMin,
    ageMax: input.ageMax,
    perAdBudgetUsd: perAdBudget,
    // Polish-28.4.0 Commit 98: forward the full launch config to the
    // worker. Everything optional — worker falls back to pre-98
    // defaults per field.
    campaignName: input.campaignName,
    campaignObjective: input.campaignObjective,
    specialAdCategories: input.specialAdCategories,
    budgetOptimizationEnabled: input.budgetOptimizationEnabled,
    campaignDailyBudgetUsd: input.campaignDailyBudgetUsd,
    optimizationGoal: input.optimizationGoal,
    placementType: input.placementType,
    billingEvent: input.billingEvent,
    bidStrategy: input.bidStrategy,
    bidAmountUsd: input.bidAmountUsd,
    startTime: input.startTime,
    endTime: input.endTime,
    locales: input.locales,
    includedCustomAudienceIds: input.includedCustomAudienceIds,
    excludedCustomAudienceIds: input.excludedCustomAudienceIds,
    publisherPlatforms: input.publisherPlatforms,
    facebookPositions: input.facebookPositions,
    instagramPositions: input.instagramPositions,
    audienceNetworkPositions: input.audienceNetworkPositions,
    messengerPositions: input.messengerPositions,
    pixelId: input.pixelId,
    customEventType: input.customEventType,
    callToActionType: input.callToActionType,
    advantageAudienceEnabled: input.advantageAudienceEnabled,
  });

  revalidatePath(`/runs/${input.jobId}`);
  revalidatePath('/launched');
  return {
    ok: true,
    committedTodayUsd: cap.committedTodayUsd,
    capUsd: cap.capUsd,
    plannedBudgetUsd,
  };
}

export const launchApprovedAction = withErrorLogging(
  'launchApprovedAction',
  launchApprovedActionImpl,
);

// ============================================================================
// Polish-25.6 Commit 37: recover Polish-25 jobs stuck in the
// processing_timeout state.
//
// The worker's poll loop caps at 60 min (MAKEUGC_POLL_MAX_ATTEMPTS=360).
// When the cap fires while MakeUGC's status is still non-terminal, the
// worker now stamps `metadata.polish25_processing_timeout=true` +
// `metadata.polish25_stuck_video_id=<id>` and marks the job failed
// (backward-compat for consumers reading the enum). The run detail UI
// spots the flag and renders a Recheck button instead of the red
// error UI; this action is what that button fires.
//
// Three outcomes when the operator clicks Recheck:
//   1. MakeUGC returns status=completed → we mirror the worker's
//      Step J (insert generated_creatives + patch metadata) + flip
//      the job back to 'completed'. Cost is stamped identically to
//      the worker path so /dashboard + /launched aggregates match.
//   2. MakeUGC returns status=failed → we clear the timeout flag +
//      stamp the real error message. The UI flips to normal red
//      error state.
//   3. MakeUGC still processing → no-op on the DB; return "still
//      processing" so the client can render "check back later".
// ============================================================================

export interface RecheckPolish25Result {
  ok: boolean;
  status: 'completed' | 'failed' | 'still_processing';
  message: string;
}

export async function recheckPolish25MakeugcAction(jobId: string): Promise<RecheckPolish25Result> {
  const user = await requireUser();
  const db = getDb();

  const job = await db.query.generationJobs.findFirst({
    where: and(eq(schema.generationJobs.id, jobId), eq(schema.generationJobs.userId, user.id)),
    columns: {
      id: true,
      userId: true,
      status: true,
      metadata: true,
    },
  });
  if (!job) {
    return { ok: false, status: 'failed', message: 'Job not found.' };
  }
  const meta = (job.metadata ?? {}) as Record<string, unknown>;
  const timeoutFlag = meta['polish25_processing_timeout'] === true;
  const videoId =
    typeof meta['polish25_stuck_video_id'] === 'string'
      ? (meta['polish25_stuck_video_id'] as string)
      : typeof meta['polish25_makeugc_video_id'] === 'string'
        ? (meta['polish25_makeugc_video_id'] as string)
        : null;
  if (!timeoutFlag) {
    return {
      ok: false,
      status: 'failed',
      message: 'This job is not in the processing-timeout state.',
    };
  }
  if (!videoId) {
    return {
      ok: false,
      status: 'failed',
      message: 'No Instant UGC videoId on the job. Nothing to recheck.',
    };
  }

  let apiKey: string;
  try {
    const resolved = await resolveMakeugcKey({ userId: job.userId });
    apiKey = resolved.apiKey;
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message:
        err instanceof Error
          ? err.message
          : 'Instant UGC key resolution failed (env + BYOK both missing).',
    };
  }

  const poll = await checkMakeugcVideoStatus({
    userId: job.userId,
    apiKey,
    videoId,
    generationJobId: job.id,
  });

  // MakeUGC's own status=failed OR our call failed non-transiently.
  if (!poll.ok || poll.status === 'failed') {
    const errMsg =
      poll.reason ?? poll.errorMessage ?? 'Instant UGC returned failed with no reason.';
    // Clear the timeout flag so the UI stops offering Recheck; stamp
    // the real reason so translateGenerationError can surface it.
    await db
      .update(schema.generationJobs)
      .set({
        errorMessage: errMsg,
        metadata: { ...meta, polish25_processing_timeout: false },
      })
      .where(eq(schema.generationJobs.id, job.id));
    await logAuditEvent({
      userId: user.id,
      eventType: 'generation_job_completed',
      eventData: { job_id: job.id, ok: false, error: errMsg, recovered_via: 'recheck' },
    });
    revalidatePath(`/runs/${job.id}`);
    return { ok: true, status: 'failed', message: errMsg };
  }

  // Still processing on MakeUGC — nothing to do server-side.
  if (poll.status !== 'completed' || !poll.url) {
    return {
      ok: true,
      status: 'still_processing',
      message: 'Instant UGC still reports the video as processing. Come back in a few minutes.',
    };
  }

  // Completed — mirror the worker's Step J + Step K. Insert one
  // generated_creatives row (ready_for_review) and flip the job back
  // to 'completed' with the correct actualCostUsd.
  const videoUrl = poll.url;
  const costUsd = estimateMakeugcVideoCostUsd('starter');

  // Match metadata written by the worker so downstream code + logs
  // read the same shape whether the job completed inline or via
  // recheck. Preserve any existing avatarId/avatarName written earlier
  // by the successful match step (metadata.polish25_makeugc_avatar_*).
  const nextMeta: Record<string, unknown> = {
    ...meta,
    polish25_video_url: videoUrl,
    polish25_makeugc_credits_used: {
      creditsUsed: 1,
      costUsd,
      tier: 'starter',
      at: new Date().toISOString(),
      recovered_via: 'recheck',
    },
    polish25_progress: { step: 'video-ready', pct: 100, at: new Date().toISOString() },
    polish25_processing_timeout: false,
  };

  await db.transaction(async (tx) => {
    await tx.insert(schema.generatedCreatives).values({
      userId: job.userId,
      generationJobId: job.id,
      fileUrl: videoUrl,
      aspectRatio: '9:16',
      status: 'ready_for_review',
      format: 'polish25_makeugc',
      generationMetadata: {
        polish_version: POLISH_VERSION,
        recovered_via: 'recheck',
        costUsd,
      },
    });
    await tx
      .update(schema.generationJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        generatedCreativeCount: 1,
        actualCostUsd: costUsd.toFixed(4),
        errorMessage: null,
        metadata: nextMeta,
      })
      .where(eq(schema.generationJobs.id, job.id));
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'generation_job_completed',
    eventData: {
      job_id: job.id,
      variant_count: 1,
      mode: 'live',
      recovered_via: 'recheck',
      cost_usd: costUsd,
      video_id: videoId,
    },
  });

  revalidatePath(`/runs/${job.id}`);
  revalidatePath('/pending');
  revalidatePath('/dashboard');
  return {
    ok: true,
    status: 'completed',
    message: 'Recovered. The variant landed. Refresh to review + launch.',
  };
}
