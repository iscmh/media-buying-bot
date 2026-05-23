import { eq } from 'drizzle-orm';
import {
  HeyGenAvatarNotConfiguredError,
  callClaude,
  checkHeyGenVideoStatus,
  checkKieAiVideoStatus,
  classifyHeyGenError,
  claudeRankAvatars,
  listHeyGenAvatars,
  listHeyGenVoices,
  submitHeyGenVideo,
  submitKieAiVideo,
  type HeyGenAvatar,
  type HeyGenErrorCategory,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys, type ProviderKey } from '../lib/load-keys';
// Polish-4: failover. The UGC worker calls into these on a 0-success
// run to potentially route to the cinematic worker.
import {
  jobAlreadyFailedOver,
  loadFailoverReadyState,
  recordFailoverAttempt,
} from '../lib/job-markers';
import {
  buildAllProvidersFailedMessage,
  failoverEventName,
  pickFailoverFormat,
} from '../lib/failover';

// Avatar pool capped before sending to Claude — keeps the ranking call
// under ~$0.02 even when a HeyGen account has hundreds of stock avatars.
const AVATAR_POOL_CAP = 60;

/**
 * Phase 3f: UGC variant generator — HeyGen Avatar Mode happy path.
 *
 * Live pipeline (HeyGen):
 *   1. mark processing
 *   2. Claude refinement: send analysis JSON + intensity + count → get N
 *      script-shaped prompts back
 *   3. for each variant in batches of CONCURRENCY (3 — videos are slow,
 *      smaller concurrency keeps polling sane):
 *        - load user_settings.default_heygen_avatar_id (or env fallback)
 *        - submit to HeyGen /v2/video/generate
 *        - poll /v1/video_status.get every 10s for up to 20 minutes
 *        - write generated_creatives row pointing at the video URL
 *   4. roll up cost, mark completed (or partially)
 *
 * Kie.ai (Sora 2) and Arcads paths are retained for backward compat with
 * any stale jobs sitting in the queue, but no new UI surfaces them —
 * see actions.ts auto-pick of 'heygen' for ugc concepts. Hold-the-line
 * Phase 3f #1: don't delete, just stop calling.
 */

const CONCURRENCY = 3;

// Polling cadence: 10s × 120 = 20 minutes max wait per HeyGen video.
// Phase 3f bumps from 5 → 20 minutes — HeyGen avatar renders are
// typically 2-7 minutes but queue spikes do happen. Inngest's
// step.sleep + step.run pattern makes this durable across worker restarts.
const POLL_INTERVAL_SECONDS = 10;
const POLL_MAX_ATTEMPTS = 120;

const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateUgcVariants = inngest.createFunction(
  {
    id: 'generate-ugc-variants',
    name: 'Generate UGC variants',
    retries: 1,
  },
  { event: 'generation/ugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: {
          variantCount: true,
          intensity: true,
          providerChoice: true,
          metadata: true,
        },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    const intensity = (job?.intensity ?? 'medium') as 'small' | 'medium' | 'big';
    const providerChoice = (job?.providerChoice ?? '') as 'kie_ai' | 'heygen' | 'arcads' | '';
    if (variantCount <= 0 || !providerChoice) {
      await step.run('mark-failed-validation', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({
            status: 'failed',
            errorMessage: 'variant_count or provider_choice missing',
          })
          .where(eq(schema.generationJobs.id, jobId));
      });
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // ---------- mock path ----------

    if (mode === 'mock') {
      await step.sleep('mock-prompt-refinement', '2s');
      await step.sleep('mock-video-gen', '3s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, () => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
        }));
        await db.insert(schema.generatedCreatives).values(rows);
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: providerChoice,
      });
      return { jobId, mode, generated: variantCount };
    }

    // ---------- live path ----------

    if (providerChoice === 'arcads') {
      await markJobFailed(
        jobId,
        userId,
        'Arcads integration ships in Phase 3.5. Use Kie.ai or HeyGen for now.',
        0,
      );
      return { jobId, mode, generated: 0 };
    }

    // Step 1: Claude refines the analysis JSON into N Sora prompts.
    const refineResult = await step.run('claude-prompt-variants', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }
      const apiKey = keys.claude!;

      const analysis = job?.metadata ?? {};
      const userMessage = JSON.stringify({ analysis, intensity, variant_count: variantCount });

      const claude = await callClaude({
        userId,
        apiKey,
        systemPrompt: SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 8192, // big array of detailed prompts
        generationJobId: jobId,
      });

      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude refinement failed',
          costUsd: claude.costUsd,
        };
      }

      const parsed = parseSoraVariants(claude.json);
      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      return { ok: true as const, variants: parsed.variants, costUsd: claude.costUsd };
    });

    if (!refineResult.ok) {
      await markJobFailed(jobId, userId, refineResult.error, refineResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const videoOutcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> =
      [];
    const analysisMetadata = (job?.metadata ?? {}) as Record<string, unknown>;
    const liveProvider = providerChoice as 'kie_ai' | 'heygen';

    // Phase 3g: pick N different avatars upfront (HeyGen only). One step
    // for durability — Claude ranking is a real API call so it deserves
    // a retry boundary. Kie.ai path skips this entirely; it doesn't take
    // an avatar.
    const avatarPickResult =
      liveProvider === 'heygen'
        ? await step.run('pick-avatars', async () =>
            pickAvatarsForJob({
              userId,
              variantCount: refineResult.variants.length,
              analysisMetadata,
              jobId,
            }),
          )
        : {
            ok: true as const,
            avatarIds: [] as string[],
            voiceIds: [] as string[],
            costUsd: 0,
          };

    if (!avatarPickResult.ok) {
      await markJobFailed(
        jobId,
        userId,
        avatarPickResult.error,
        refineResult.costUsd + (avatarPickResult.costUsd ?? 0),
      );
      return { jobId, mode, generated: 0 };
    }

    // Step 2: for each variant, submit to provider + poll. Each step.run
    // does its own retry-on-failure inside; failure of one variant does
    // not crash the whole job.

    for (let batchStart = 0; batchStart < refineResult.variants.length; batchStart += CONCURRENCY) {
      const batch = refineResult.variants.slice(batchStart, batchStart + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (variant, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;
          const submitInput: GenerateOneVariantInput = {
            jobId,
            userId,
            variantIndex,
            providerChoice: liveProvider,
            soraPrompt: variant.prompt,
            analysisMetadata,
            assignedAvatarId:
              liveProvider === 'heygen' ? avatarPickResult.avatarIds[variantIndex] : undefined,
            assignedVoiceId:
              liveProvider === 'heygen' ? avatarPickResult.voiceIds[variantIndex] : undefined,
          };

          // 1. Submit
          const submitOutcome = await step.run(`submit-${variantIndex}`, async () =>
            submitOne(submitInput),
          );
          if (!submitOutcome.ok) {
            await step.run(`write-failed-${variantIndex}`, () =>
              writeFailedVariant(userId, jobId, variantIndex),
            );
            return {
              index: variantIndex,
              ok: false,
              costUsd: 0,
              error: submitOutcome.error,
            };
          }

          // 2. Poll. step.sleep + step.run lets Inngest pause/resume across
          // worker restarts (videos take minutes).
          let videoUrl: string | undefined;
          let pollError: string | undefined;
          let pollCostUsd = 0;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await step.sleep(`poll-sleep-${variantIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
            const checkOutcome = await step.run(`poll-${variantIndex}-${attempt}`, async () =>
              checkOne(submitInput, submitOutcome.taskId),
            );
            if (checkOutcome.status === 'completed') {
              videoUrl = checkOutcome.videoUrl;
              pollCostUsd = checkOutcome.costUsd;
              break;
            }
            if (checkOutcome.status === 'failed') {
              // Map HeyGen-style errors (httpStatus surfaced by client) to
              // user-facing copy; Kie.ai errors fall through unchanged.
              pollError =
                liveProvider === 'heygen'
                  ? friendlyHeyGenError(
                      classifyHeyGenError(checkOutcome.httpStatus, checkOutcome.errorMessage),
                      checkOutcome.errorMessage,
                    )
                  : (checkOutcome.errorMessage ?? 'Provider reported failure');
              break;
            }
            // status === 'processing' → keep polling
          }

          if (!videoUrl) {
            await step.run(`write-failed-${variantIndex}`, () =>
              writeFailedVariant(userId, jobId, variantIndex),
            );
            const timeoutMessage =
              liveProvider === 'heygen'
                ? 'HeyGen taking too long, try again in a few minutes.'
                : `Provider did not finish within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`;
            return {
              index: variantIndex,
              ok: false,
              costUsd: pollCostUsd,
              error: pollError ?? timeoutMessage,
            };
          }

          // 3. Persist generated_creatives row pointing at the provider URL.
          // Phase 3b skips Storage archival; provider URLs are typically
          // valid for 7+ days. Phase 3.5 can add archival.
          await step.run(`write-${variantIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: videoUrl!,
              aspectRatio: '9:16',
              status: 'ready_for_review',
            });
          });

          return { index: variantIndex, ok: true, costUsd: pollCostUsd };
        }),
      );
      videoOutcomes.push(...batchResults);
    }

    const totalCost =
      refineResult.costUsd +
      (avatarPickResult.costUsd ?? 0) +
      videoOutcomes.reduce((s, r) => s + r.costUsd, 0);
    const successCount = videoOutcomes.filter((r) => r.ok).length;

    // Polish-4: failover. Mirror of the cinematic worker — if zero
    // variants succeeded and we haven't already failed over, route the
    // same job to the cinematic worker (if user has the keys), else
    // notify via Telegram.
    if (mode === 'live' && successCount === 0) {
      const alreadyFailedOver = await step.run('check-failover', async () =>
        jobAlreadyFailedOver(jobId),
      );
      if (!alreadyFailedOver) {
        const ready = await step.run('load-failover-state', async () =>
          loadFailoverReadyState(userId),
        );
        const decision = pickFailoverFormat('avatar_talking_head', ready);
        if (decision.fallback) {
          await step.run('record-failover', async () =>
            recordFailoverAttempt({
              jobId,
              fromFormat: 'avatar_talking_head',
              toFormat: decision.fallback!,
              reason: decision.reason,
            }),
          );
          await step.sendEvent('failover-dispatch', {
            name: failoverEventName(decision.fallback),
            data: { jobId, userId, mode },
          });
          return { jobId, mode, generated: 0, failedOverTo: decision.fallback };
        }
        await step.sendEvent('all-providers-failed-tg', {
          name: 'telegram/notify.requested',
          data: { userId, message: buildAllProvidersFailedMessage(jobId) },
        });
      } else {
        await step.sendEvent('all-providers-failed-tg', {
          name: 'telegram/notify.requested',
          data: { userId, message: buildAllProvidersFailedMessage(jobId) },
        });
      }
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successCount,
      actualCostUsd: totalCost,
      provider: providerChoice,
      partialFailures: videoOutcomes.filter((r) => !r.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

// ----- helpers -----

interface SoraVariant {
  variant_index: number;
  intensity_level: 'small' | 'medium' | 'big';
  summary?: string;
  prompt: string;
}

function parseSoraVariants(
  json: unknown,
): { ok: true; variants: SoraVariant[] } | { ok: false; error: string } {
  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as { variants?: unknown }).variants)
  ) {
    return { ok: false, error: 'Claude response missing variants[]' };
  }
  const variants = (json as { variants: SoraVariant[] }).variants;
  if (variants.length === 0) return { ok: false, error: 'Claude returned zero variants' };
  for (const v of variants) {
    if (!v || typeof v.prompt !== 'string' || v.prompt.length === 0) {
      return { ok: false, error: 'Claude variant missing prompt' };
    }
    // Operator spec caps at 5000 chars per Sora prompt; truncate softly.
    if (v.prompt.length > 5000) v.prompt = v.prompt.slice(0, 5000);
  }
  return { ok: true, variants };
}

interface GenerateOneVariantInput {
  jobId: string;
  userId: string;
  variantIndex: number;
  providerChoice: 'kie_ai' | 'heygen';
  soraPrompt: string;
  analysisMetadata: Record<string, unknown>;
  /** Phase 3g: avatar picked upfront by the pick-avatars step (HeyGen only). */
  assignedAvatarId?: string;
  /** Phase 3i: voice paired with the avatar (gender-matched, English). */
  assignedVoiceId?: string;
}

async function submitOne(
  input: GenerateOneVariantInput,
): Promise<
  { ok: true; taskId: string; provider: 'kie_ai' | 'heygen' } | { ok: false; error: string }
> {
  const required: ProviderKey[] = [input.providerChoice];
  let keys;
  try {
    keys = await loadDecryptedKeys(input.userId, required);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  // DEPRECATED Phase 3f: Kie.ai (Sora 2) branch retained for stale
  // jobs only. New UGC jobs are forced to providerChoice='heygen' by
  // the generation form. Don't delete — safety net for in-flight queues.
  if (input.providerChoice === 'kie_ai') {
    const apiKey = keys.kie_ai!;
    const submission = await submitKieAiVideo({
      userId: input.userId,
      apiKey,
      prompt: input.soraPrompt,
      generationJobId: input.jobId,
    });
    if (!submission.ok || !submission.taskId) {
      return {
        ok: false,
        error: submission.errorMessage ?? 'Kie.ai submit returned no task id',
      };
    }
    return { ok: true, taskId: submission.taskId, provider: 'kie_ai' };
  }

  // HeyGen Avatar Mode happy path (Phase 3f/3g). Avatar was picked by
  // the upstream pick-avatars step — this branch just submits.
  const apiKey = keys.heygen!;
  if (!input.assignedAvatarId) {
    // Defensive: pick-avatars should have failed the job before we got
    // here. If we land here anyway, surface the avatar-config message.
    return {
      ok: false,
      error: new HeyGenAvatarNotConfiguredError().message,
    };
  }

  // Use the operator prompt's Dialogue section as the spoken script.
  const script = extractDialogueFromSoraPrompt(input.soraPrompt);

  // Voice was paired with the avatar by the pick-avatars step (Phase 3i).
  // HeyGen v2 rejects submissions without voice_id; defending against an
  // upstream regression rather than silently falling back.
  if (!input.assignedVoiceId) {
    return {
      ok: false,
      error: 'No HeyGen voice paired with this avatar. Pick a default voice in /settings.',
    };
  }

  const submission = await submitHeyGenVideo({
    userId: input.userId,
    apiKey,
    avatarId: input.assignedAvatarId,
    voiceId: input.assignedVoiceId,
    script,
    generationJobId: input.jobId,
  });
  if (!submission.ok || !submission.videoId) {
    return {
      ok: false,
      error: friendlyHeyGenError(
        classifyHeyGenError(submission.httpStatus, submission.errorMessage),
        submission.errorMessage,
      ),
    };
  }
  return { ok: true, taskId: submission.videoId, provider: 'heygen' };
}

/**
 * Phase 3g avatar-selection priority (returns variantCount different
 * avatars whenever possible):
 *   1. user_settings.default_heygen_avatar_id is a FORCED OVERRIDE —
 *      if set, every variant uses that avatar (consistent branding).
 *   2. Otherwise: Claude ranks the user's HeyGen catalog against the
 *      analysis persona; pipeline takes top N. If fewer strong matches
 *      than variants, fills with shuffled remainder for diversity.
 *   3. On any failure (ranking error, empty catalog, etc.):
 *      HEYGEN_DEFAULT_AVATAR_ID env → array filled with that single id.
 *   4. Last resort: HeyGenAvatarNotConfiguredError pointing at /settings.
 *
 * Same-avatar-twice in a single generation is a Hold-the-Line bug —
 * we de-dup + backfill to guarantee diversity when the pool allows.
 */
export async function selectHeyGenAvatars(input: {
  userId: string;
  heygenApiKey: string;
  claudeApiKey: string;
  variantCount: number;
  analysisMetadata: Record<string, unknown>;
  jobId: string;
}): Promise<{ avatarIds: string[]; voiceIds: string[]; rankingCostUsd: number }> {
  if (input.variantCount <= 0) {
    return { avatarIds: [], voiceIds: [], rankingCostUsd: 0 };
  }

  // User-level overrides — both columns are independent; either can be
  // set without the other.
  const db = getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, input.userId),
    columns: { defaultHeygenAvatarId: true, defaultHeygenVoiceId: true },
  });

  // --- Avatar selection ---
  let avatarIds: string[];
  let rankingCostUsd = 0;
  /** Populated only on the smart-match path; used by voice gender matching. */
  const avatarsById = new Map<string, HeyGenAvatar>();

  if (settings?.defaultHeygenAvatarId) {
    avatarIds = Array(input.variantCount).fill(settings.defaultHeygenAvatarId);
  } else {
    try {
      const fetchResult = await listHeyGenAvatars({
        userId: input.userId,
        apiKey: input.heygenApiKey,
        generationJobId: input.jobId,
      });
      if (!fetchResult.ok) {
        throw new Error(`HeyGen /v2/avatars failed: ${fetchResult.errorMessage ?? 'unknown'}`);
      }
      if (fetchResult.avatars.length === 0) {
        throw new Error('HeyGen catalog is empty');
      }
      for (const a of fetchResult.avatars) avatarsById.set(a.avatar_id, a);

      const pool = buildAvatarPool(fetchResult.avatars, input.analysisMetadata);
      const ranking = await claudeRankAvatars({
        userId: input.userId,
        apiKey: input.claudeApiKey,
        personaDescription: buildPersonaDescription(input.analysisMetadata),
        avatars: pool.map((a) => ({
          id: a.avatar_id,
          name: a.avatar_name,
          gender: a.gender,
        })),
        generationJobId: input.jobId,
      });
      if (!ranking.ok) {
        throw new Error(ranking.errorMessage ?? 'Claude ranking failed');
      }

      // Take top N, then backfill with shuffled remainder so we always
      // return variantCount UNIQUE ids whenever the pool allows it.
      const picked: string[] = [];
      const seen = new Set<string>();
      for (const id of ranking.rankedIds) {
        if (picked.length >= input.variantCount) break;
        if (!seen.has(id)) {
          seen.add(id);
          picked.push(id);
        }
      }
      if (picked.length < input.variantCount) {
        const remainder = pool.map((a) => a.avatar_id).filter((id) => !seen.has(id));
        shuffleInPlace(remainder);
        for (const id of remainder) {
          if (picked.length >= input.variantCount) break;
          picked.push(id);
          seen.add(id);
        }
      }
      // Pool genuinely smaller than variantCount → last resort, repeat the
      // first id rather than fail the whole job. Rare in practice (HeyGen
      // stock catalogs are 50+).
      while (picked.length < input.variantCount) {
        picked.push(picked[0] ?? pool[0]?.avatar_id ?? '');
      }
      avatarIds = picked;
      rankingCostUsd = ranking.costUsd;
    } catch {
      const envFallback = process.env.HEYGEN_DEFAULT_AVATAR_ID;
      if (envFallback && envFallback.trim().length > 0) {
        avatarIds = Array(input.variantCount).fill(envFallback);
      } else {
        throw new HeyGenAvatarNotConfiguredError();
      }
    }
  }

  // --- Voice selection ---
  // Phase 3i: HeyGen v2 rejects submissions without a voice_id. Stock
  // avatars have no default_voice_id, so we pick one per avatar:
  //   1. user_settings.default_heygen_voice_id → forced override for all.
  //   2. listHeyGenVoices once → filter to English → match by avatar
  //      gender → fall back to first English voice (or any if none).
  //   3. listVoices failure with no override → fail the whole pick step
  //      with a copy that points the operator at /settings.
  const voiceIds = await selectVoiceIds({
    variantCount: input.variantCount,
    avatarIds,
    avatarsById,
    forcedVoiceId: settings?.defaultHeygenVoiceId ?? null,
    userId: input.userId,
    apiKey: input.heygenApiKey,
    jobId: input.jobId,
  });

  return { avatarIds, voiceIds, rankingCostUsd };
}

async function selectVoiceIds(input: {
  variantCount: number;
  avatarIds: string[];
  avatarsById: Map<string, HeyGenAvatar>;
  forcedVoiceId: string | null;
  userId: string;
  apiKey: string;
  jobId: string;
}): Promise<string[]> {
  if (input.forcedVoiceId) {
    return Array(input.variantCount).fill(input.forcedVoiceId);
  }

  const fetchResult = await listHeyGenVoices({
    userId: input.userId,
    apiKey: input.apiKey,
    generationJobId: input.jobId,
  });
  if (!fetchResult.ok || fetchResult.voices.length === 0) {
    throw new Error(
      'Could not load HeyGen voices. Set a default voice in /settings or check your HeyGen API quota.',
    );
  }

  const englishVoices = fetchResult.voices.filter(
    (v) => typeof v.language === 'string' && v.language.toLowerCase().startsWith('en'),
  );
  // Prefer English; fall back to any voice if HeyGen surfaced no language
  // tags (the field is optional in their schema).
  const pool = englishVoices.length > 0 ? englishVoices : fetchResult.voices;
  const fallbackId = pool[0]!.voice_id;

  return input.avatarIds.map((avatarId) => {
    const gender = input.avatarsById.get(avatarId)?.gender?.toLowerCase();
    if (!gender) return fallbackId;
    const sameGender = pool.find(
      (v) => typeof v.gender === 'string' && v.gender.toLowerCase() === gender,
    );
    return sameGender?.voice_id ?? fallbackId;
  });
}

/**
 * Pre-filter + cap the avatar pool before sending to Claude. When Gemini
 * gave us a clear gender signal and there are enough same-gender avatars
 * to satisfy the variant count, we restrict the pool — wrong gender is
 * the most visible casting error. Capped at AVATAR_POOL_CAP to keep the
 * Claude prompt cheap.
 */
function buildAvatarPool(
  avatars: HeyGenAvatar[],
  analysisMetadata: Record<string, unknown>,
): HeyGenAvatar[] {
  const genderHint = extractGenderHint(analysisMetadata);
  let pool = avatars;
  if (genderHint) {
    const sameGender = avatars.filter(
      (a) => typeof a.gender === 'string' && a.gender.toLowerCase() === genderHint,
    );
    if (sameGender.length >= AVATAR_POOL_CAP / 2) {
      pool = sameGender;
    }
  }
  return pool.slice(0, AVATAR_POOL_CAP);
}

function extractGenderHint(analysis: Record<string, unknown>): 'male' | 'female' | null {
  const inner = (analysis.analysis as Record<string, unknown> | undefined) ?? analysis;
  const subj = inner.subject as Record<string, unknown> | undefined;
  const g = subj?.gender;
  if (typeof g === 'string') {
    const lower = g.toLowerCase();
    if (lower === 'male' || lower === 'female') return lower;
  }
  return null;
}

function buildPersonaDescription(analysis: Record<string, unknown>): string {
  // Concentrate Claude on persona-relevant fields when the Gemini
  // analysis is structured; fall back to the full blob otherwise so we
  // never starve the model of signal.
  const inner = (analysis.analysis as Record<string, unknown> | undefined) ?? analysis;
  const slice: Record<string, unknown> = {};
  for (const key of ['subject', 'social_context', 'target_demographic', 'tone', 'setting']) {
    if (inner[key] !== undefined) slice[key] = inner[key];
  }
  const body = Object.keys(slice).length > 0 ? slice : inner;
  return JSON.stringify(body, null, 2);
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/**
 * Pipeline-facing wrapper around selectHeyGenAvatars. Handles key
 * loading + maps HeyGenAvatarNotConfiguredError to the Inngest step's
 * `{ ok: false }` shape so the job can fail cleanly without a thrown
 * exception killing the run.
 */
async function pickAvatarsForJob(input: {
  userId: string;
  variantCount: number;
  analysisMetadata: Record<string, unknown>;
  jobId: string;
}): Promise<
  | { ok: true; avatarIds: string[]; voiceIds: string[]; costUsd: number }
  | { ok: false; error: string; costUsd: number }
> {
  let keys;
  try {
    keys = await loadDecryptedKeys(input.userId, ['heygen', 'claude']);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }

  try {
    const result = await selectHeyGenAvatars({
      userId: input.userId,
      heygenApiKey: keys.heygen!,
      claudeApiKey: keys.claude!,
      variantCount: input.variantCount,
      analysisMetadata: input.analysisMetadata,
      jobId: input.jobId,
    });
    return {
      ok: true,
      avatarIds: result.avatarIds,
      voiceIds: result.voiceIds,
      costUsd: result.rankingCostUsd,
    };
  } catch (err) {
    if (err instanceof HeyGenAvatarNotConfiguredError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    if (err instanceof Error) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }
}

export function friendlyHeyGenError(
  category: HeyGenErrorCategory,
  raw: string | undefined,
): string {
  switch (category) {
    case 'auth':
      return 'HeyGen rejected your API key. Reconnect HeyGen in settings.';
    case 'credits':
      return 'HeyGen is out of credits or rate-limited. Top up HeyGen API credits.';
    case 'avatar_missing':
      return 'Selected HeyGen avatar was not found. Pick a different default avatar in /settings.';
    case 'timeout':
      return 'HeyGen took too long to respond. Try again in a few minutes.';
    case 'server':
      return 'HeyGen had a server-side error. Try again shortly.';
    default:
      return raw ?? 'HeyGen submission failed.';
  }
}

async function checkOne(
  input: GenerateOneVariantInput,
  taskId: string,
): Promise<{
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  errorMessage?: string;
  httpStatus?: number;
}> {
  const required: ProviderKey[] = [input.providerChoice];
  let keys;
  try {
    keys = await loadDecryptedKeys(input.userId, required);
  } catch {
    return { status: 'failed', costUsd: 0, errorMessage: 'Provider key missing during poll' };
  }

  if (input.providerChoice === 'kie_ai') {
    return checkKieAiVideoStatus({
      userId: input.userId,
      apiKey: keys.kie_ai!,
      taskId,
      generationJobId: input.jobId,
    });
  }

  return checkHeyGenVideoStatus({
    userId: input.userId,
    apiKey: keys.heygen!,
    videoId: taskId,
    generationJobId: input.jobId,
  });
}

function extractDialogueFromSoraPrompt(prompt: string): string {
  // The operator template has a `Dialogue:\n"<TEXT>"` block. Pull the
  // quoted text; if not found, fall back to the full prompt (HeyGen will
  // truncate as needed).
  const match = /Dialogue:\s*"([\s\S]*?)"/m.exec(prompt);
  return match?.[1]?.trim() || prompt.slice(0, 1000);
}

async function writeFailedVariant(
  userId: string,
  jobId: string,
  variantIndex: number,
): Promise<void> {
  const db = getDb();
  await db.insert(schema.generatedCreatives).values({
    userId,
    generationJobId: jobId,
    fileUrl: '',
    aspectRatio: '9:16',
    status: 'rejected',
  });
  void variantIndex; // included in audit via parent function's metadata
}

async function markJobFailed(
  jobId: string,
  userId: string,
  error: string,
  costUsd: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.generationJobs)
    .set({
      status: 'failed',
      errorMessage: error,
      actualCostUsd: costUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, jobId));
  await logAuditEvent({
    userId,
    eventType: 'generation_job_completed',
    eventData: { job_id: jobId, ok: false, error, cost_usd: costUsd },
  });
}

async function markJobCompleted(input: {
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
  startedAt: number;
  variantCount: number;
  actualCostUsd: number;
  provider: string;
  partialFailures?: Array<{ index: number; error?: string }>;
}): Promise<void> {
  const db = getDb();
  const durationMs = Date.now() - input.startedAt;
  await db
    .update(schema.generationJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      generatedCreativeCount: input.variantCount,
      actualCostUsd: input.actualCostUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, input.jobId));

  await logAuditEvent({
    userId: input.userId,
    eventType: 'generation_job_completed',
    eventData: {
      job_id: input.jobId,
      variant_count: input.variantCount,
      mode: input.mode,
      mock: input.mode === 'mock',
      duration_ms: durationMs,
      path: 'ugc',
      provider: input.provider,
      cost_usd: input.actualCostUsd,
      partial_failures: input.partialFailures ?? [],
    },
  });
}
