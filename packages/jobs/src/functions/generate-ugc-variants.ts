import { eq } from 'drizzle-orm';
import {
  HeyGenAvatarNotConfiguredError,
  callClaude,
  checkHeyGenVideoStatus,
  checkKieAiVideoStatus,
  classifyHeyGenError,
  listHeyGenAvatars,
  pickHeyGenAvatar,
  submitHeyGenVideo,
  submitKieAiVideo,
  type HeyGenErrorCategory,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys, type ProviderKey } from '../lib/load-keys';

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

    // Step 2: for each variant, submit to provider + poll. Each step.run
    // does its own retry-on-failure inside; failure of one variant does
    // not crash the whole job.
    const videoOutcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> =
      [];
    const analysisMetadata = (job?.metadata ?? {}) as Record<string, unknown>;
    const liveProvider = providerChoice as 'kie_ai' | 'heygen';

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

    const totalCost = refineResult.costUsd + videoOutcomes.reduce((s, r) => s + r.costUsd, 0);
    const successCount = videoOutcomes.filter((r) => r.ok).length;

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

  // HeyGen Avatar Mode happy path (Phase 3f).
  const apiKey = keys.heygen!;

  let avatarId: string;
  try {
    avatarId = await selectHeyGenAvatar({
      userId: input.userId,
      apiKey,
      analysisMetadata: input.analysisMetadata,
      jobId: input.jobId,
    });
  } catch (err) {
    if (err instanceof HeyGenAvatarNotConfiguredError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  // Use the operator prompt's Dialogue section as the spoken script.
  const script = extractDialogueFromSoraPrompt(input.soraPrompt);

  // Optional voice id from user_settings — if absent HeyGen picks the
  // avatar's default voice automatically.
  const voiceId = await loadDefaultVoiceId(input.userId);

  const submission = await submitHeyGenVideo({
    userId: input.userId,
    apiKey,
    avatarId,
    voiceId: voiceId ?? undefined,
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
 * Phase 3f avatar-selection priority:
 *   1. user_settings.default_heygen_avatar_id (UI-configured per user)
 *   2. process.env.HEYGEN_DEFAULT_AVATAR_ID (platform-wide fallback)
 *   3. SMART_AVATAR_MATCH=true → heuristic match from /v2/avatars
 *   4. throw HeyGenAvatarNotConfiguredError (user-facing copy points
 *      them to /settings)
 *
 * Steps 3 + 4 only run when nothing else matched. Step 3 silently falls
 * through to step 4 if the matcher returns null OR if listAvatars fails.
 */
export async function selectHeyGenAvatar(input: {
  userId: string;
  apiKey: string;
  analysisMetadata: Record<string, unknown>;
  jobId: string;
}): Promise<string> {
  const db = getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, input.userId),
    columns: { defaultHeygenAvatarId: true },
  });
  if (settings?.defaultHeygenAvatarId) {
    return settings.defaultHeygenAvatarId;
  }

  const envFallback = process.env.HEYGEN_DEFAULT_AVATAR_ID;
  if (envFallback && envFallback.trim().length > 0) {
    return envFallback;
  }

  if (process.env.SMART_AVATAR_MATCH === 'true') {
    const avatars = await listHeyGenAvatars({
      userId: input.userId,
      apiKey: input.apiKey,
      generationJobId: input.jobId,
    });
    if (avatars.ok) {
      const matched = pickHeyGenAvatar(
        avatars.avatars,
        extractPersonaFromAnalysis(input.analysisMetadata),
      );
      if (matched) return matched.avatar_id;
    }
  }

  throw new HeyGenAvatarNotConfiguredError();
}

async function loadDefaultVoiceId(userId: string): Promise<string | null> {
  const db = getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { defaultHeygenVoiceId: true },
  });
  return row?.defaultHeygenVoiceId ?? null;
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

function extractPersonaFromAnalysis(analysis: Record<string, unknown>): {
  age?: string;
  gender?: string;
  vibe?: string;
  setting?: string;
} {
  const subj = (analysis.analysis as Record<string, unknown> | undefined)?.subject as
    | Record<string, unknown>
    | undefined;
  const social = (analysis.analysis as Record<string, unknown> | undefined)?.social_context;
  const appearance = subj?.appearance;
  return {
    age: typeof appearance === 'string' ? appearance : undefined,
    gender: typeof appearance === 'string' ? appearance : undefined,
    vibe: typeof appearance === 'string' ? appearance : undefined,
    setting: typeof social === 'string' ? social : undefined,
  };
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
