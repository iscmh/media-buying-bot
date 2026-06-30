import { eq } from 'drizzle-orm';
import {
  VEO_MAX_SECONDS_PER_CALL,
  callClaude,
  clampVeoDurationSeconds,
  estimateVeoCostUsd,
  pollVeoOperation,
  submitVeoVideo,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedVideoFromUrl } from '../lib/storage';

/**
 * Polish-19.2: Veo 3.1 Fast single-call native-audio pipeline.
 * Replaces the Polish-19 Kling Avatar v2 pipeline as the default
 * UGC pipeline.
 *
 * Per variant:
 *   1. Claude → combined "ad spec" text: dialogue + visual scene
 *      description + ambient/SFX hints. Veo 3.1 reads everything
 *      from one prompt — no separate character image step, no
 *      separate TTS step, no lipsync step.
 *   2. submitVeoVideo with the prompt + ≤8s duration. Returns a
 *      long-running operation name.
 *   3. Poll the operation until done. Veo emits the video to a
 *      short-lived URI in the response.
 *   4. Re-upload the video to Supabase Storage for a durable URL.
 *   5. Write a generated_creatives row.
 *
 * Polish-19.2 ships single-chunk path only — Veo caps each call at
 * 8 seconds. Multi-chunk chaining for 30s+ ads lands as Polish-19.3
 * once the basic API flow is verified live (either via a true Veo
 * Extend endpoint if Google exposes one on the Developer API, or
 * via independent N×8s submits stitched with the existing
 * Polish-9.12 Replicate ffmpeg-concat helper). The worker clamps
 * any longer request to 8s and logs the clamp.
 *
 * Cost per variant (8s target): $0.05 Claude + $1.20 Veo = $1.25.
 * Substantially cheaper than the $3.67 Kling Avatar v2 baseline
 * because Veo collapses the script + image + TTS + lipsync chain
 * into one model call.
 */

const POLL_WARMUP_SECONDS = 15;
const POLL_INITIAL_INTERVAL_SECONDS = 8;
const POLL_MAX_INTERVAL_SECONDS = 25;
const POLL_BACKOFF_GROWTH = 1.15;
const POLL_MAX_ATTEMPTS = 60; // ~16-20min ceiling with backoff

/**
 * Polish-19.2: exponential-backoff poll cadence for Veo's long-
 * running operations. Veo runs are typically 30-90s; the curve
 * stays responsive for fast finishes and bounds wall-clock for
 * stuck operations.
 */
export function computeVeoPollIntervalSeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return POLL_INITIAL_INTERVAL_SECONDS;
  const raw = POLL_INITIAL_INTERVAL_SECONDS * Math.pow(POLL_BACKOFF_GROWTH, attempt);
  return Math.min(
    Math.max(POLL_INITIAL_INTERVAL_SECONDS, Math.ceil(raw)),
    POLL_MAX_INTERVAL_SECONDS,
  );
}

const DEFAULT_TARGET_DURATION = 8;
const MIN_TARGET_DURATION = 2;

/**
 * Polish-19.2: resolve the worker's target duration. Reads from
 * job.metadata.source_duration_seconds (the simplified-form's
 * Length picker writes here, same field the Kling worker reads)
 * and clamps to Veo's per-call ceiling of 8s. Longer requests are
 * clamped and the worker logs the clamp loudly so the operator
 * sees what they got.
 */
export function resolveVeoTargetDuration(jobMetadata: Record<string, unknown> | null): {
  durationSeconds: number;
  clamped: boolean;
  requestedSeconds: number;
} {
  if (!jobMetadata) {
    return {
      durationSeconds: DEFAULT_TARGET_DURATION,
      clamped: false,
      requestedSeconds: DEFAULT_TARGET_DURATION,
    };
  }
  const raw = jobMetadata['source_duration_seconds'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return {
      durationSeconds: DEFAULT_TARGET_DURATION,
      clamped: false,
      requestedSeconds: DEFAULT_TARGET_DURATION,
    };
  }
  const requestedSeconds = Math.max(MIN_TARGET_DURATION, Math.ceil(raw));
  const durationSeconds = clampVeoDurationSeconds(requestedSeconds);
  return {
    durationSeconds,
    clamped: requestedSeconds > VEO_MAX_SECONDS_PER_CALL,
    requestedSeconds,
  };
}

/**
 * Polish-19.2.4: Veo's output URI on the Gemini Developer API is a
 * private Files API URL (generativelanguage.googleapis.com/v1beta/
 * files/...) that 403s without the same x-goog-api-key the submit
 * call used. Other providers' URIs (kie.ai CDN, Replicate delivery,
 * future Vertex AI gs:// URIs handled separately) are public — those
 * downloads must NOT carry the Gemini key.
 *
 * Pure helper exported so the domain match is unit-testable. Returns
 * the headers map to forward to the upstream fetch, or undefined
 * when the URL doesn't need auth.
 */
export function buildVeoDownloadHeaders(
  remoteUrl: string,
  geminiApiKey: string,
): Record<string, string> | undefined {
  if (!remoteUrl) return undefined;
  let host: string;
  try {
    host = new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  // Only attach the Gemini key on the Files API domain — public CDN
  // URLs (kie.ai, Replicate, Supabase) must NOT receive an unrelated
  // auth header.
  if (host === 'generativelanguage.googleapis.com') {
    return { 'x-goog-api-key': geminiApiKey };
  }
  return undefined;
}

interface VeoVariantResult {
  index: number;
  ok: boolean;
  costUsd: number;
  fileUrl?: string;
  error?: string;
}

export const generateVeo31Fast = inngest.createFunction(
  {
    id: 'generate-veo-3-1-fast',
    name: 'Generate Veo 3.1 Fast native-audio UGC ad',
    retries: 1,
  },
  { event: 'generation/veo-3-1-fast.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, metadata: true },
      });
    });
    if (!job) {
      await markJobFailed(jobId, userId, 'job row not found', 0);
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    const variantCount = Math.max(1, job.variantCount ?? 1);
    const { durationSeconds, clamped, requestedSeconds } = resolveVeoTargetDuration(
      (job.metadata ?? null) as Record<string, unknown> | null,
    );
    if (clamped) {
      console.log(
        `[veo-3-1-fast] job ${jobId}: requested ${requestedSeconds}s clamped to ` +
          `${durationSeconds}s (Veo per-call ceiling). Multi-chunk chaining lands in Polish-19.3.`,
      );
    }

    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-rows', async () => {
        const db = getDb();
        for (let i = 0; i < variantCount; i++) {
          await db.insert(schema.generatedCreatives).values({
            userId,
            generationJobId: jobId,
            fileUrl: 'https://samplelib.com/lib/preview/mp4/sample-10s.mp4',
            aspectRatio: '9:16',
            status: 'ready_for_review',
            format: 'veo_3_1_fast_native_audio',
            isClipPart: false,
            generationMetadata: { mock: true, variant_index: i, duration_seconds: durationSeconds },
          });
        }
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount,
        actualCostUsd: 0,
        provider: 'gemini',
        path: 'veo-3-1-fast',
      });
      return { jobId, mode, generated: variantCount };
    }

    // Live path: N independent variant chains in parallel.
    const variantResults = await Promise.all(
      Array.from({ length: variantCount }, (_, index) =>
        runOneVariant({
          step,
          jobId,
          userId,
          variantIndex: index,
          durationSeconds,
          jobMetadata: (job.metadata ?? null) as Record<string, unknown> | null,
        }),
      ),
    );

    const totalCost = variantResults.reduce((sum, r) => sum + r.costUsd, 0);
    const successes = variantResults.filter((r) => r.ok);
    const failures = variantResults.filter((r) => !r.ok);

    if (successes.length === 0) {
      const firstError = failures[0]?.error ?? 'All variants failed without an error message';
      await markJobFailed(jobId, userId, firstError, totalCost);
      return { jobId, mode, generated: 0, failed: failures.length };
    }

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: successes.length,
      actualCostUsd: totalCost,
      provider: 'gemini',
      path: 'veo-3-1-fast',
      partialFailures: failures.map((f) => ({ index: f.index, error: f.error })),
    });
    return { jobId, mode, generated: successes.length, failed: failures.length };
  },
);

interface RunOneVariantInput {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  durationSeconds: number;
  jobMetadata: Record<string, unknown> | null;
}

async function runOneVariant(input: RunOneVariantInput): Promise<VeoVariantResult> {
  const { step, jobId, userId, variantIndex, durationSeconds, jobMetadata } = input;
  let cost = 0;

  // ---- Claude → combined ad spec (script + scene + ambient) -----
  const adSpecResult = await step.run(`claude-ad-spec-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['claude']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    const systemPrompt =
      `You write Veo 3.1 prompts for short UGC video ads. Output ONE prompt as PLAIN TEXT — ` +
      `no JSON, no markdown, no preamble, no scene labels.\n\n` +
      `STRUCTURE: First describe the visual scene (who, where, lighting, framing — UGC ` +
      `iPhone selfie style, NOT studio, NOT cinematic). Then the spoken dialogue in quotes. ` +
      `Then any ambient sound cues.\n\n` +
      `HARD CONSTRAINTS:\n` +
      `- Target ${durationSeconds}s of video. Dialogue must FIT in that window at natural ` +
      `conversational pace (~150wpm).\n` +
      `- First-person voiceover. Hook in the first second. End with a clear call-to-action.\n` +
      `- Single character, single scene, single camera angle.\n` +
      `- Photoreal amateur smartphone selfie aesthetic — natural lighting, real human skin ` +
      `texture, slight handheld feel. NOT a 3D character, NOT animated, NOT CGI.\n` +
      `- No on-screen text, no captions, no graphics, no watermarks.\n` +
      `- Character is a fictional everyperson with no resemblance to any public figure.`;
    const userMessage = JSON.stringify({
      source_analysis: jobMetadata ?? {},
      target_duration_seconds: durationSeconds,
      variant_index: variantIndex,
    });
    const claude = await callClaude({
      userId,
      apiKey: keys.claude!,
      systemPrompt,
      userMessage,
      maxTokens: 4096,
      generationJobId: jobId,
    });
    if (!claude.ok) {
      return {
        ok: false as const,
        error: claude.errorMessage ?? 'Claude ad-spec call failed',
        costUsd: claude.costUsd,
      };
    }
    const adSpec = (claude.text ?? '').trim();
    if (!adSpec) {
      return {
        ok: false as const,
        error: 'Claude returned an empty ad spec',
        costUsd: claude.costUsd,
      };
    }
    return { ok: true as const, adSpec, costUsd: claude.costUsd };
  });
  cost += adSpecResult.costUsd;
  if (!adSpecResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: adSpecResult.error };
  }

  // ---- Submit Veo ----------------------------------------------
  const submitResult = await step.run(`veo-submit-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const submit = await submitVeoVideo({
      userId,
      apiKey: keys.gemini!,
      prompt: adSpecResult.adSpec,
      durationSeconds,
      aspectRatio: '9:16',
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.operationName) {
      return {
        ok: false as const,
        error: submit.errorMessage ?? 'Veo predictLongRunning failed',
      };
    }
    return { ok: true as const, operationName: submit.operationName };
  });
  if (!submitResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: submitResult.error };
  }

  // ---- Poll Veo operation --------------------------------------
  await step.sleep(`veo-warmup-${variantIndex}`, `${POLL_WARMUP_SECONDS}s`);
  let videoUri: string | undefined;
  let pollError: string | undefined;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await step.run(`veo-poll-${variantIndex}-${attempt}`, async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['gemini']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message };
        throw err;
      }
      return pollVeoOperation({
        userId,
        apiKey: keys.gemini!,
        operationName: submitResult.operationName,
        generationJobId: jobId,
      });
    });
    if (!('done' in poll) && 'error' in poll) {
      pollError = poll.error;
      break;
    }
    if (!poll.ok) {
      pollError = poll.errorMessage ?? 'Veo poll failed';
      break;
    }
    if (poll.done) {
      if (poll.videoUri) {
        videoUri = poll.videoUri;
        break;
      }
      pollError = poll.failMessage ?? 'Veo done without a video URI';
      break;
    }
    await step.sleep(
      `veo-wait-${variantIndex}-${attempt}`,
      `${computeVeoPollIntervalSeconds(attempt)}s`,
    );
  }

  // Veo charges on submit-to-success — bill the clamped seconds
  // either way, the operator can dispute via the audit log if Veo
  // refunds genuine failures.
  cost += estimateVeoCostUsd(durationSeconds);

  if (!videoUri) {
    console.log(
      `[veo-3-1-fast] variant ${variantIndex} timed out / failed after ${POLL_MAX_ATTEMPTS} polls. ` +
        `operation=${submitResult.operationName} last_error=${pollError ?? 'unset'}`,
    );
    // Persist the in-flight operation name for manual recovery
    // (same Polish-19.0.5 pattern as Kling).
    await step.run(`veo-insert-in-flight-${variantIndex}`, async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: '',
        aspectRatio: '9:16',
        status: 'failed',
        format: 'veo_3_1_fast_native_audio',
        isClipPart: false,
        generationMetadata: {
          variant_index: variantIndex,
          veo_operation_name: submitResult.operationName,
          in_flight: true,
          timed_out_after_polls: POLL_MAX_ATTEMPTS,
          duration_seconds: durationSeconds,
          last_error_message: pollError ?? null,
          recoverable: true,
        },
      });
    });
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        `Veo operation ${submitResult.operationName} did not reach a terminal state within ` +
        `${POLL_MAX_ATTEMPTS} polls. Operation name saved on the failed creative for recovery. ` +
        (pollError ? `Last poll error: ${pollError}` : ''),
    };
  }

  // ---- Re-upload final mp4 -------------------------------------
  // Polish-19.2.4: Veo's output URI on the Developer API is a
  // private Files API URL. Re-load the Gemini key inside the step
  // and forward x-goog-api-key on the download fetch so the 403
  // path is closed. The Inngest step boundary means the key
  // reference doesn't cross step boundaries — same defense-in-depth
  // as every other key-using step in this worker.
  const uploadResult = await step.run(`upload-video-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        throw new Error(
          `Cannot download Veo output ${videoUri!}: ${err.message}. ` +
            `The Gemini key is required because Veo's URI is on the private Files API domain.`,
        );
      throw err;
    }
    return uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: videoUri!,
      filename: `veo-${variantIndex}`,
      fetchHeaders: buildVeoDownloadHeaders(videoUri!, keys.gemini!),
    });
  });

  // ---- Persist generated_creatives row -------------------------
  await step.run(`insert-creative-${variantIndex}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: uploadResult.publicUrl,
      aspectRatio: '9:16',
      status: 'ready_for_review',
      format: 'veo_3_1_fast_native_audio',
      isClipPart: false,
      generationMetadata: {
        variant_index: variantIndex,
        duration_seconds: durationSeconds,
        veo_operation_name: submitResult.operationName,
        ad_spec_chars: adSpecResult.adSpec.length,
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: uploadResult.publicUrl };
}
