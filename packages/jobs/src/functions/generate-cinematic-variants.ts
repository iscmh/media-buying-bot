import { eq } from 'drizzle-orm';
import {
  buildCinematicPromptFromScript,
  callClaude,
  checkKlingPrediction,
  classifyKlingError,
  submitElevenLabsTts,
  submitKlingVideo,
} from '@mbb/ai-providers';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';

/**
 * Polish-4: cinematic_voiceover variant generator. Pairs Kling 2.5
 * cinematic video with an ElevenLabs voiceover; the script lives as
 * audio, not as on-screen lip-sync.
 *
 * Pipeline per variant:
 *   1. Claude refines the analysis JSON → N variant scripts
 *      (reuses the SORA_PROMPT_OPTIMIZER system prompt — produces a
 *      structured array of { prompt: "..." } entries; we treat each
 *      prompt as the *spoken script* for the cinematic format).
 *   2. For each script: buildCinematicPromptFromScript via Claude
 *      → cinematic prompt for Kling.
 *   3. Submit Kling video + submit ElevenLabs TTS in parallel.
 *   4. Poll Kling until prediction succeeds.
 *   5. Write generated_creatives row with format='cinematic_voiceover',
 *      fileUrl = Kling video URL, generationMetadata = { script,
 *      cinematicPrompt, audioBase64 } so the job-review UI can play
 *      audio + video together (deferred-ffmpeg fallback path).
 *
 * Note: audio is stored as base64 on generationMetadata for Polish-4.
 * Polish-4.5 will swap to a separate storage object + URL once the
 * variant size pushes the row past 1 MB. The current scale (10 variants
 * × ~50 KB audio = 500 KB / job) is fine for jsonb.
 */

const CONCURRENCY = 2; // Kling renders are heavy; smaller batch
const POLL_INTERVAL_SECONDS = 15;
const POLL_MAX_ATTEMPTS = 40; // 15s × 40 = 10 min max wait per Kling clip
const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

export const generateCinematicVariants = inngest.createFunction(
  {
    id: 'generate-cinematic-variants',
    name: 'Generate cinematic voiceover variants',
    retries: 1,
  },
  { event: 'generation/cinematic.requested' },
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
          metadata: true,
        },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    const intensity = (job?.intensity ?? 'medium') as 'small' | 'medium' | 'big';
    if (variantCount <= 0) {
      await markJobFailed(jobId, userId, 'variant_count missing for cinematic job', 0);
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
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-creatives', async () => {
        const db = getDb();
        const rows = Array.from({ length: variantCount }, () => ({
          userId,
          generationJobId: jobId,
          fileUrl: MOCK_VIDEO_URL,
          aspectRatio: '9:16' as const,
          status: 'ready_for_review' as const,
          format: 'cinematic_voiceover',
          generationMetadata: {
            mock: true,
            script: 'Mock cinematic script for dry-run mode.',
          },
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
        provider: 'kling',
        path: 'cinematic',
      });
      return { jobId, mode, generated: variantCount };
    }

    // ---------- live path ----------

    // Step 1: Claude refines analysis JSON → N scripts (reusing the Sora
    // prompt optimizer — its output shape `{ variants: [{ prompt }] }`
    // works for either UGC scripts or cinematic scripts, since the prompts
    // ARE the scripts in voiceover form).
    const refineResult = await step.run('claude-script-variants', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError) {
          return { ok: false as const, error: err.message, costUsd: 0 };
        }
        throw err;
      }
      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt: SORA_PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        userMessage: JSON.stringify({
          analysis: job?.metadata ?? {},
          intensity,
          variant_count: variantCount,
        }),
        maxTokens: 8192,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude refinement failed',
          costUsd: claude.costUsd,
        };
      }
      const variants = parseScriptVariants(claude.json);
      if (!variants.ok) {
        return { ok: false as const, error: variants.error, costUsd: claude.costUsd };
      }
      return { ok: true as const, scripts: variants.scripts, costUsd: claude.costUsd };
    });

    if (!refineResult.ok) {
      await markJobFailed(jobId, userId, refineResult.error, refineResult.costUsd);
      return { jobId, mode, generated: 0 };
    }

    const outcomes: Array<{ index: number; ok: boolean; costUsd: number; error?: string }> = [];

    for (let batchStart = 0; batchStart < refineResult.scripts.length; batchStart += CONCURRENCY) {
      const batch = refineResult.scripts.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (script, idxInBatch) => {
          const variantIndex = batchStart + idxInBatch;

          // 1. Build cinematic prompt + submit Kling + TTS.
          const setupResult = await step.run(`cinematic-setup-${variantIndex}`, async () =>
            setupCinematicVariant({ jobId, userId, variantIndex, script }),
          );
          if (!setupResult.ok) {
            await step.run(`write-failed-${variantIndex}`, async () =>
              writeFailedCinematicVariant(userId, jobId),
            );
            return {
              index: variantIndex,
              ok: false,
              costUsd: setupResult.costUsd,
              error: setupResult.error,
            };
          }

          // 2. Poll Kling until completed/failed.
          let videoUrl: string | undefined;
          let pollError: string | undefined;
          let pollCostUsd = 0;
          for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
            await step.sleep(`kling-poll-${variantIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
            const tick = await step.run(`kling-check-${variantIndex}-${attempt}`, async () =>
              pollKling({ userId, jobId, predictionId: setupResult.predictionId }),
            );
            if (tick.status === 'completed') {
              videoUrl = tick.videoUrl;
              pollCostUsd = tick.costUsd;
              break;
            }
            if (tick.status === 'failed') {
              pollError = tick.errorMessage ?? 'Kling reported failure';
              break;
            }
          }

          if (!videoUrl) {
            await step.run(`write-failed-${variantIndex}`, async () =>
              writeFailedCinematicVariant(userId, jobId),
            );
            return {
              index: variantIndex,
              ok: false,
              costUsd: setupResult.costUsd + pollCostUsd,
              error:
                pollError ??
                `Kling did not finish within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`,
            };
          }

          // 3. Persist the cinematic creative row.
          await step.run(`write-${variantIndex}`, async () => {
            const db = getDb();
            await db.insert(schema.generatedCreatives).values({
              userId,
              generationJobId: jobId,
              fileUrl: videoUrl!,
              aspectRatio: '9:16',
              status: 'ready_for_review',
              format: 'cinematic_voiceover',
              generationMetadata: {
                script,
                cinematic_prompt: setupResult.cinematicPrompt,
                audio_base64: setupResult.audioBase64,
                audio_content_type: setupResult.audioContentType,
                kling_prediction_id: setupResult.predictionId,
              },
            });
          });

          return {
            index: variantIndex,
            ok: true,
            costUsd: setupResult.costUsd + pollCostUsd,
          };
        }),
      );
      outcomes.push(...results);
    }

    const totalCost = refineResult.costUsd + outcomes.reduce((s, r) => s + r.costUsd, 0);
    const successCount = outcomes.filter((r) => r.ok).length;

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successCount,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'cinematic',
      partialFailures: outcomes.filter((r) => !r.ok),
    });

    return { jobId, mode, generated: successCount, totalCost };
  },
);

interface CinematicSetupSuccess {
  ok: true;
  predictionId: string;
  cinematicPrompt: string;
  audioBase64?: string;
  audioContentType?: string;
  costUsd: number;
}
interface CinematicSetupFailure {
  ok: false;
  error: string;
  costUsd: number;
}

async function setupCinematicVariant(input: {
  jobId: string;
  userId: string;
  variantIndex: number;
  script: string;
}): Promise<CinematicSetupSuccess | CinematicSetupFailure> {
  let keys;
  try {
    keys = await loadDecryptedKeys(input.userId, ['claude', 'kling', 'elevenlabs']);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }

  // 1. Script → cinematic prompt (Claude).
  const prompted = await buildCinematicPromptFromScript({
    userId: input.userId,
    apiKey: keys.claude!,
    script: input.script,
    generationJobId: input.jobId,
  });
  if (!prompted.ok || !prompted.prompt) {
    return {
      ok: false,
      error: prompted.errorMessage ?? 'Could not build cinematic prompt',
      costUsd: prompted.costUsd,
    };
  }

  // 2. Submit Kling video + ElevenLabs TTS in parallel — independent
  //    upstream calls. If either fails we surface the error; the audio
  //    can be re-attempted by re-running the job step.
  const [kling, tts] = await Promise.all([
    submitKlingVideo({
      userId: input.userId,
      apiKey: keys.kling!,
      prompt: prompted.prompt,
      generationJobId: input.jobId,
    }),
    submitElevenLabsTts({
      userId: input.userId,
      apiKey: keys.elevenlabs!,
      text: input.script,
      generationJobId: input.jobId,
    }),
  ]);

  if (!kling.ok || !kling.predictionId) {
    return {
      ok: false,
      error:
        friendlyKlingError(kling.httpStatus, kling.errorMessage) ??
        'Kling submission failed without an error message',
      costUsd: prompted.costUsd,
    };
  }
  if (!tts.ok) {
    return {
      ok: false,
      error: tts.errorMessage ?? 'ElevenLabs TTS failed',
      costUsd: prompted.costUsd,
    };
  }

  return {
    ok: true,
    predictionId: kling.predictionId,
    cinematicPrompt: prompted.prompt,
    audioBase64: tts.audioBase64,
    audioContentType: tts.contentType,
    costUsd: prompted.costUsd + tts.costUsd,
  };
}

async function pollKling(input: {
  userId: string;
  jobId: string;
  predictionId: string;
}): Promise<{
  status: 'completed' | 'failed' | 'processing';
  videoUrl?: string;
  costUsd: number;
  errorMessage?: string;
}> {
  const keys = await loadDecryptedKeys(input.userId, ['kling']);
  const r = await checkKlingPrediction({
    userId: input.userId,
    apiKey: keys.kling!,
    predictionId: input.predictionId,
    generationJobId: input.jobId,
  });
  return {
    status: r.status,
    videoUrl: r.videoUrl,
    costUsd: r.costUsd,
    errorMessage: r.errorMessage,
  };
}

function parseScriptVariants(
  json: unknown,
): { ok: true; scripts: string[] } | { ok: false; error: string } {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Claude response missing variants[]' };
  }
  const variants = (json as { variants?: unknown }).variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    return { ok: false, error: 'Claude returned zero variants' };
  }
  const scripts: string[] = [];
  for (const v of variants) {
    if (!v || typeof v !== 'object') continue;
    const prompt = (v as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return { ok: false, error: 'Claude variant missing prompt/script' };
    }
    // Kling prompt limit governs; the SCRIPT is short by nature. Cap to
    // keep the ElevenLabs TTS bill bounded if Claude over-talks.
    scripts.push(prompt.length > 2000 ? prompt.slice(0, 2000) : prompt);
  }
  if (scripts.length === 0) {
    return { ok: false, error: 'No valid scripts in Claude response' };
  }
  return { ok: true, scripts };
}

async function writeFailedCinematicVariant(userId: string, jobId: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.generatedCreatives).values({
    userId,
    generationJobId: jobId,
    fileUrl: '',
    aspectRatio: '9:16',
    status: 'rejected',
    format: 'cinematic_voiceover',
  });
}

function friendlyKlingError(status: number | undefined, message: string | undefined): string {
  const category = classifyKlingError(status, message);
  switch (category) {
    case 'auth':
      return 'Replicate rejected your Kling key. Reconnect from /connections/ai-provider.';
    case 'credits':
      return 'Replicate is rate-limiting or you are out of credits. Wait and retry.';
    case 'model_missing':
      return 'The configured Kling model id is wrong. Check KLING_MODEL_ID.';
    case 'timeout':
      return 'Replicate took too long to respond. Try again.';
    case 'server':
      return 'Replicate had a server error. Try again in a minute.';
    default:
      return message ?? 'Kling reported an unknown failure.';
  }
}

// Keep audit log import alive in case future versions need it.
void logAuditEvent;
