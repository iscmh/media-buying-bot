import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  estimateKieKlingAvatarCostUsd,
  pollKieKlingAvatar,
  submitElevenLabsTts,
  submitKieKlingAvatar,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import {
  uploadGeneratedAudio,
  uploadGeneratedImage,
  uploadGeneratedVideoFromUrl,
} from '../lib/storage';

/**
 * Polish-19: kie.ai Kling Avatar v2 (Pro) single-call talking-head
 * pipeline. Replaces the Polish-12 multi-segment Omni Flash flow as
 * the default UGC pipeline.
 *
 * Per variant:
 *   1. Claude → monologue script (sized to target duration).
 *   2. Nano Banana → portrait reference image. Single line of
 *      anti-celeb prompting only — Kling Avatar animates a provided
 *      face rather than generating one, so the heavy Polish-12.8
 *      scrub chain is unnecessary here. If users hit specific
 *      character needs that's Polish-19.1 territory.
 *   3. ElevenLabs → TTS audio (default voice from
 *      getDefaultElevenLabsVoiceId, overridable from the UI later).
 *   4. Upload mp3 + portrait to Supabase Storage so kie.ai has
 *      public URLs to fetch.
 *   5. kie.ai createTask with model=kling/ai-avatar-pro,
 *      input={image_url, audio_url, prompt: ''}.
 *   6. Poll recordInfo until state=success (5min ceiling).
 *   7. Re-upload kie.ai's CDN mp4 to Supabase Storage so the
 *      deliverable has a durable URL.
 *   8. Write a generated_creatives row.
 *
 * The job's variantCount field drives a `Promise.all` of N independent
 * variant chains — failures in one variant don't kill the others; the
 * job-completion summary captures partial failures the same way the
 * UGC + cinematic workers do.
 *
 * Cost per variant (30s target):
 *   $0.05 Claude + $0.05 Nano Banana + ~$0.12 ElevenLabs + $3.45 Kling
 *   ≈ $3.67. Scales linearly with target duration.
 */

const POLL_WARMUP_SECONDS = 20;
const POLL_INTERVAL_SECONDS = 10;
const POLL_MAX_ATTEMPTS = 32; // 32 × 10s = 5min 20s ceiling (per kie.ai's max gen length)

const DEFAULT_TARGET_DURATION = 30;
const MIN_TARGET_DURATION = 8;
const MAX_TARGET_DURATION = 300; // 5min hard ceiling matches kie.ai's docs

/**
 * Polish-19 Commit 2: read the optional `voice_id` field from the
 * job's metadata (written by the generation form when the user picks
 * a non-default voice via VoicePicker). Falls back to undefined so
 * the ElevenLabs client uses its built-in getDefaultElevenLabsVoiceId
 * (Rachel) — preserves existing behavior for any job created before
 * the picker shipped.
 *
 * The voice id is a free-form string from the user. We don't validate
 * it against the curated catalog because (a) the catalog is a small
 * subset of ElevenLabs' library — users with their own voices might
 * legitimately pass an id we don't recognize, and (b) if it's invalid
 * ElevenLabs will return a clear 422 that surfaces via the worker's
 * existing error path.
 */
export function resolveVoiceId(jobMetadata: Record<string, unknown> | null): string | undefined {
  if (!jobMetadata) return undefined;
  const raw = jobMetadata['voice_id'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the source-video duration (when known) off job.metadata and
 * clamp to a sane range. Identical contract to the Omni Flash worker
 * so a future cross-pipeline refactor can collapse them.
 */
export function resolveTargetDuration(jobMetadata: Record<string, unknown> | null): number {
  if (!jobMetadata) return DEFAULT_TARGET_DURATION;
  const raw = jobMetadata['source_duration_seconds'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TARGET_DURATION;
  }
  return Math.max(MIN_TARGET_DURATION, Math.min(MAX_TARGET_DURATION, Math.ceil(raw)));
}

/**
 * Polish-19: the only line of anti-celeb guidance. Per spec — Kling
 * Avatar v2 animates a provided face, so we don't need to scrub
 * Claude's character description against a celebrity list or strip
 * proper nouns from the scene prompt. Just steer Nano Banana toward
 * an everyman / everywoman portrait.
 */
const NANO_BANANA_GENERIC_FACE_LINE =
  'fictional everyday person, no resemblance to any public figure.';

/**
 * Polish-19.0.3: kie.ai's Kling Avatar v2 API rejects empty prompts
 * with HTTP 500 ("prompt is required") despite the public docs
 * stating an empty string is the documented default. Pass a generic
 * delivery-style directive that gives the model loose framing without
 * fighting the audio-driven lipsync — the model still drives mouth
 * shapes from audio_url; this prompt only nudges expression and
 * body language.
 *
 * Polish-19.1 will expose this in the Advanced disclosure for per-job
 * overrides (e.g. "energetic, fast-paced" vs "calm, measured"). For
 * now the hardcoded default unblocks the pipeline.
 */
export const KLING_AVATAR_DEFAULT_PROMPT =
  'Natural conversational delivery to camera, subtle expressive movements, realistic lipsync to the provided audio.';

/**
 * Per-variant result. The worker collects N of these into a partial-
 * failures array so the job-completion audit captures variant-level
 * success vs failure even when the overall job is "done".
 */
export interface KlingAvatarVariantResult {
  index: number;
  ok: boolean;
  costUsd: number;
  fileUrl?: string;
  error?: string;
}

export const generateKieKlingAvatarV2 = inngest.createFunction(
  {
    id: 'generate-kie-kling-avatar-v2',
    name: 'Generate Kling Avatar v2 UGC ad',
    retries: 1,
  },
  { event: 'generation/kie-kling-avatar-v2.requested' },
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
    const targetDurationSeconds = resolveTargetDuration(
      (job.metadata ?? null) as Record<string, unknown> | null,
    );

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
            format: 'kie_kling_avatar_v2_standard',
            isClipPart: false,
            generationMetadata: { mock: true, variant_index: i },
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
        provider: 'kling',
        path: 'kie-kling-avatar-v2',
      });
      return { jobId, mode, generated: variantCount };
    }

    // Live path: fan out N variants. Promise.all isolates failures so
    // one variant's blowup doesn't cancel the others — partial-failure
    // bookkeeping captures the per-variant outcome.
    const variantResults = await Promise.all(
      Array.from({ length: variantCount }, (_, index) =>
        runOneVariant({
          step,
          jobId,
          userId,
          variantIndex: index,
          targetDurationSeconds,
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
      provider: 'kling',
      path: 'kie-kling-avatar-v2',
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
  targetDurationSeconds: number;
  jobMetadata: Record<string, unknown> | null;
}

/**
 * Polish-19: one variant's worth of work. Composed of step.run-fenced
 * primitives so Inngest can retry individual stages on transient
 * failures without re-spending the earlier stages' tokens / credits.
 *
 * Returns a KlingAvatarVariantResult — the outer worker aggregates
 * these and decides job completion vs failure based on at-least-one
 * variant succeeding.
 */
async function runOneVariant(input: RunOneVariantInput): Promise<KlingAvatarVariantResult> {
  const { step, jobId, userId, variantIndex, targetDurationSeconds, jobMetadata } = input;
  let cost = 0;

  // ---- Script ----------------------------------------------------
  const scriptResult = await step.run(`claude-script-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['claude']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    const targetWords = Math.round((targetDurationSeconds / 60) * 150);
    const systemPrompt = `You write short, punchy UGC ad monologues. Output PLAIN TEXT only — no JSON, no markdown, no stage directions, no character names. Target ~${targetWords} words for a ${targetDurationSeconds}s read at 150wpm. Conversational, first-person, ends with a clear call-to-action.`;
    const userMessage = JSON.stringify({
      source_analysis: jobMetadata ?? {},
      target_duration_seconds: targetDurationSeconds,
      variant_index: variantIndex,
    });
    const claude = await callClaude({
      userId,
      apiKey: keys.claude!,
      systemPrompt,
      userMessage,
      maxTokens: 2048,
      generationJobId: jobId,
    });
    if (!claude.ok) {
      return {
        ok: false as const,
        error: claude.errorMessage ?? 'Claude script generation failed',
        costUsd: claude.costUsd,
      };
    }
    const script = (claude.text ?? '').trim();
    if (!script) {
      return {
        ok: false as const,
        error: 'Claude returned an empty script',
        costUsd: claude.costUsd,
      };
    }
    return { ok: true as const, script, costUsd: claude.costUsd };
  });
  cost += scriptResult.costUsd;
  if (!scriptResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: scriptResult.error };
  }

  // ---- Reference image -------------------------------------------
  const refResult = await step.run(`nano-banana-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    const prompt = [
      'Portrait photograph of a single person, head and shoulders, facing camera, neutral expression, soft natural lighting, plain background, photorealistic, 9:16 aspect.',
      NANO_BANANA_GENERIC_FACE_LINE,
    ].join(' ');
    const image = await callGeminiImage({
      userId,
      apiKey: keys.gemini!,
      prompt,
      generationJobId: jobId,
    });
    if (!image.ok || !image.imageBase64) {
      return {
        ok: false as const,
        error: image.errorMessage ?? 'Nano Banana reference frame failed',
        costUsd: image.costUsd,
      };
    }
    return {
      ok: true as const,
      imageBase64: image.imageBase64,
      mimeType: image.imageMimeType ?? 'image/png',
      costUsd: image.costUsd,
    };
  });
  cost += refResult.costUsd;
  if (!refResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: refResult.error };
  }

  const imageUploadResult = await step.run(`upload-ref-${variantIndex}`, async () => {
    return uploadGeneratedImage({
      userId,
      jobId,
      variantIndex,
      imageBase64: refResult.imageBase64,
      mimeType: refResult.mimeType,
      filenamePrefix: 'kling-avatar-ref-',
    });
  });

  // ---- TTS -------------------------------------------------------
  const ttsResult = await step.run(`elevenlabs-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['elevenlabs']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    const tts = await submitElevenLabsTts({
      userId,
      apiKey: keys.elevenlabs!,
      text: scriptResult.script,
      voiceId: resolveVoiceId(jobMetadata),
      generationJobId: jobId,
    });
    if (!tts.ok || !tts.audioBase64) {
      return {
        ok: false as const,
        error: tts.errorMessage ?? 'ElevenLabs TTS failed',
        costUsd: tts.costUsd,
      };
    }
    return {
      ok: true as const,
      audioBase64: tts.audioBase64,
      contentType: tts.contentType ?? 'audio/mpeg',
      costUsd: tts.costUsd,
    };
  });
  cost += ttsResult.costUsd;
  if (!ttsResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: ttsResult.error };
  }

  const audioUploadResult = await step.run(`upload-audio-${variantIndex}`, async () => {
    return uploadGeneratedAudio({
      userId,
      jobId,
      audioBase64: ttsResult.audioBase64,
      mimeType: ttsResult.contentType,
      filename: `kling-avatar-voice-${variantIndex}`,
    });
  });

  // ---- Kling Avatar v2 submit ------------------------------------
  const submitResult = await step.run(`kie-kling-submit-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['kie_ai']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    // Polish-19.0.3: kie.ai rejects empty prompts despite documenting
    // empty-string as the default. See KLING_AVATAR_DEFAULT_PROMPT
    // above for the rationale on the chosen string.
    const submit = await submitKieKlingAvatar({
      userId,
      apiKey: keys.kie_ai!,
      imageUrl: imageUploadResult.publicUrl,
      audioUrl: audioUploadResult.publicUrl,
      prompt: KLING_AVATAR_DEFAULT_PROMPT,
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.taskId) {
      return {
        ok: false as const,
        error: submit.errorMessage ?? 'kie.ai createTask failed',
        costUsd: 0,
      };
    }
    return { ok: true as const, taskId: submit.taskId, costUsd: 0 };
  });
  cost += submitResult.costUsd;
  if (!submitResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: submitResult.error };
  }

  // ---- Poll for completion ---------------------------------------
  await step.sleep(`kie-kling-warmup-${variantIndex}`, `${POLL_WARMUP_SECONDS}s`);
  let outputUrl: string | undefined;
  let pollError: string | undefined;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await step.run(`kie-kling-poll-${variantIndex}-${attempt}`, async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['kie_ai']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message };
        throw err;
      }
      return pollKieKlingAvatar({
        userId,
        apiKey: keys.kie_ai!,
        taskId: submitResult.taskId,
        generationJobId: jobId,
      });
    });
    if (!('state' in poll) && 'error' in poll) {
      pollError = poll.error;
      break;
    }
    if (!poll.ok) {
      pollError = poll.errorMessage ?? 'kie.ai poll failed';
      break;
    }
    if (poll.state === 'success' && poll.outputUrl) {
      outputUrl = poll.outputUrl;
      break;
    }
    if (poll.state === 'fail') {
      pollError = poll.failMsg ?? poll.failCode ?? 'kie.ai task failed';
      break;
    }
    await step.sleep(`kie-kling-wait-${variantIndex}-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
  }

  if (!outputUrl) {
    cost += estimateKieKlingAvatarCostUsd(targetDurationSeconds);
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error: pollError ?? `kie.ai did not reach a terminal state within ${POLL_MAX_ATTEMPTS} polls`,
    };
  }
  cost += estimateKieKlingAvatarCostUsd(targetDurationSeconds);

  // ---- Re-upload final mp4 ---------------------------------------
  const uploadResult = await step.run(`upload-video-${variantIndex}`, async () => {
    return uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: outputUrl!,
      filename: `kling-avatar-${variantIndex}`,
    });
  });

  // ---- Persist generated_creatives row ---------------------------
  await step.run(`insert-creative-${variantIndex}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: uploadResult.publicUrl,
      aspectRatio: '9:16',
      status: 'ready_for_review',
      format: 'kie_kling_avatar_v2_standard',
      isClipPart: false,
      generationMetadata: {
        variant_index: variantIndex,
        script_chars: scriptResult.script.length,
        target_duration_seconds: targetDurationSeconds,
        ref_image_url: imageUploadResult.publicUrl,
        audio_url: audioUploadResult.publicUrl,
        kie_task_id: submitResult.taskId,
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: uploadResult.publicUrl };
}
