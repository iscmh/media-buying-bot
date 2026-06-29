import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  estimateKieKlingAvatarCostUsd,
  getUniversalUgcMasterPrompt,
  pollKieKlingAvatar,
  submitElevenLabsTts,
  submitKieKlingAvatar,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { inngest } from '../client';
import { buildKlingAvatarReferencePrompt } from '../lib/image-prompts';
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

/**
 * Polish-19.0.5: poll cadence tuned for a long-tail of slow Kling
 * runs that occasionally land 6-12 minutes after submit. The previous
 * 32 × 10s = 5min 20s ceiling let kie.ai finish the generation but
 * the worker had already given up — the $3.45 Kling cost was paid,
 * the deliverable was never collected, and the operator saw a fake
 * "task did not reach terminal state" failure.
 *
 * New ceiling: 80 attempts with gentle exponential backoff (10s →
 * 30s cap). Total wall-clock ≈ 38 minutes — far past every observed
 * Kling run time and still bounded so a genuinely-dead kie.ai task
 * doesn't loop forever.
 *
 * computeKlingAvatarPollIntervalSeconds() is the pure helper that
 * drives the loop; exported so the backoff curve is unit-testable.
 */
const POLL_WARMUP_SECONDS = 20;
const POLL_INITIAL_INTERVAL_SECONDS = 10;
const POLL_MAX_INTERVAL_SECONDS = 30;
const POLL_BACKOFF_GROWTH = 1.15;
const POLL_MAX_ATTEMPTS = 80;

export function computeKlingAvatarPollIntervalSeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return POLL_INITIAL_INTERVAL_SECONDS;
  const raw = POLL_INITIAL_INTERVAL_SECONDS * Math.pow(POLL_BACKOFF_GROWTH, attempt);
  return Math.min(
    Math.max(POLL_INITIAL_INTERVAL_SECONDS, Math.ceil(raw)),
    POLL_MAX_INTERVAL_SECONDS,
  );
}

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
 * Polish-19.0.4: output-format override layered on top of the
 * Universal UGC Master Prompt. The master prompt is tuned for a
 * structured production manual (Section A character sheet + Section
 * B scene + N clips with imagePrompt/videoPrompt); Kling Avatar v2
 * needs ONE continuous plain-text monologue instead. This override
 * forcibly redirects the output shape without throwing away the
 * tuned hook/voice/CTA guidance baked into the master prompt.
 *
 * The {targetWords} / {targetDurationSeconds} placeholders are
 * substituted in at call time so the read length tracks the user's
 * Length picker.
 */
const KLING_AVATAR_CLAUDE_OUTPUT_OVERRIDE = (
  targetWords: number,
  targetDurationSeconds: number,
): string => {
  // Polish-19.0.6: tighten the override after first live retry returned
  // ~2300 words / 11910 chars (over the 10k ElevenLabs TTS cap). The
  // master prompt is 15,869 chars vs the prior 500-char override —
  // Claude was weighting the override at <3%. Hard caps + repeated
  // "MAXIMUM" framing increases the override's authority without
  // making it longer than necessary.
  const safetyTarget = Math.max(1, targetWords - 10);
  return (
    `\n\n===== CRITICAL OUTPUT FORMAT OVERRIDE (Polish-19 Kling Avatar v2) =====\n` +
    `Return PLAIN TEXT monologue only. No JSON, no markdown, no clip structure, no scene labels.\n` +
    `\n` +
    `HARD WORD LIMIT: ${targetWords} words MAXIMUM. This is enforced — going over breaks the downstream TTS. ` +
    `Count your words. A UGC ad is short and punchy, not a long-form script. ` +
    `Aim for ${safetyTarget} words to leave safety margin. ` +
    `If you can't fit the hook + body + CTA in ${targetWords} words, cut the body.\n` +
    `\n` +
    `${targetWords} words = roughly ${targetDurationSeconds}s at 150wpm. ` +
    `First-person conversational delivery. Hook in first 3 seconds. ` +
    `Ends with a clear call-to-action that drives the viewer to act. ` +
    `No multi-clip breakdown — this is ONE continuous monologue.\n` +
    `===== END OUTPUT FORMAT OVERRIDE =====`
  );
};

/**
 * Polish-19.0.6: pre-flight TTS char cap. ElevenLabs rejects bodies
 * longer than 10,000 chars per request with HTTP 422. We cap a little
 * under that so the truncation fallback has breathing room (e.g.
 * trailing punctuation, trim-to-sentence overhead).
 */
const SCRIPT_HARD_CAP_CHARS = 9500;

/**
 * Polish-19.0.6: truncate an over-cap script to the last complete
 * sentence under `capChars`. Pure helper — exported for unit tests.
 *
 * Returns the input unchanged if already under the cap. When the
 * input is over the cap:
 *   - Slice to `capChars`, find the last sentence-ender (. ! ?).
 *   - If that boundary is past the halfway point of the slice, use
 *     it — keeps a clean ending.
 *   - If no boundary lands late enough (Claude wrote one giant
 *     run-on), hard-cut at `capChars` rather than throw away most
 *     of the script trying to find a sentence boundary.
 */
export function truncateScriptToCap(text: string, capChars: number): string {
  if (text.length <= capChars) return text;
  const sliced = text.slice(0, capChars);
  const lastPeriod = sliced.lastIndexOf('.');
  const lastBang = sliced.lastIndexOf('!');
  const lastQuestion = sliced.lastIndexOf('?');
  const lastEnd = Math.max(lastPeriod, lastBang, lastQuestion);
  if (lastEnd > Math.floor(capChars / 2)) {
    return sliced.slice(0, lastEnd + 1).trim();
  }
  return sliced.trim();
}

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
    // Polish-19.0.4: layer the iteratively-tuned UGC Master Prompt
    // (Polish-12.x voice/hook/CTA guidance) with a strict output-
    // format override that forces ONE continuous plain-text monologue.
    // Stops the master prompt's multi-clip production-manual instincts
    // from bleeding into the Kling worker's single-monologue need.
    const systemPrompt =
      getUniversalUgcMasterPrompt() +
      KLING_AVATAR_CLAUDE_OUTPUT_OVERRIDE(targetWords, targetDurationSeconds);
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
      // Polish-19.0.4: bumped 2048 → 8192. Monologue itself stays
      // small (~75-400 chars for 30-60s reads), but Claude often
      // emits a few hundred chars of preamble against the master
      // prompt's voice patterns before settling into the monologue.
      maxTokens: 8192,
      generationJobId: jobId,
    });
    if (!claude.ok) {
      return {
        ok: false as const,
        error: claude.errorMessage ?? 'Claude script generation failed',
        costUsd: claude.costUsd,
      };
    }
    let script = (claude.text ?? '').trim();
    let totalCost = claude.costUsd;
    if (!script) {
      return {
        ok: false as const,
        error: 'Claude returned an empty script',
        costUsd: totalCost,
      };
    }

    // Polish-19.0.6: ElevenLabs TTS hard-caps requests at 10,000 chars
    // and Claude routinely blows past the override's word target
    // because the 15,869-char master prompt overwhelms the override's
    // weight. Retry once with explicit char-count feedback when the
    // first response is over the cap; fall back to last-sentence
    // truncation if the retry is still over.
    if (script.length > SCRIPT_HARD_CAP_CHARS) {
      console.log(
        `[kie-kling-avatar] variant ${variantIndex}: Claude returned ${script.length} chars ` +
          `(over ${SCRIPT_HARD_CAP_CHARS} cap); retrying once with explicit length feedback`,
      );
      const retryUserMessage = JSON.stringify({
        source_analysis: jobMetadata ?? {},
        target_duration_seconds: targetDurationSeconds,
        variant_index: variantIndex,
        previous_attempt_was_too_long_chars: script.length,
        elevenlabs_tts_hard_cap_chars: 10000,
        retry_directive:
          `Your previous response was ${script.length} characters, which exceeds the ` +
          `10000-character ElevenLabs TTS limit. Rewrite the monologue to fit in ` +
          `${targetWords} words / under ${SCRIPT_HARD_CAP_CHARS} characters. ` +
          `Keep the hook + CTA; cut the body. Count your words.`,
      });
      const retry = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt,
        userMessage: retryUserMessage,
        maxTokens: 4096,
        generationJobId: jobId,
      });
      totalCost += retry.costUsd;
      const retryScript = (retry.text ?? '').trim();
      if (retry.ok && retryScript.length > 0 && retryScript.length <= SCRIPT_HARD_CAP_CHARS) {
        console.log(
          `[kie-kling-avatar] variant ${variantIndex}: retry succeeded with ${retryScript.length} chars`,
        );
        script = retryScript;
      } else {
        const truncated = truncateScriptToCap(script, SCRIPT_HARD_CAP_CHARS);
        console.log(
          `[kie-kling-avatar] variant ${variantIndex}: retry returned ${retryScript.length} chars ` +
            `(retry.ok=${retry.ok}); falling back to truncate-to-last-sentence: ${truncated.length} chars`,
        );
        script = truncated;
      }
    }

    return { ok: true as const, script, costUsd: totalCost };
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
    // Polish-19.0.4: reach for the shared Polish-9.x→12.x UGC
    // realism directives (IMAGE_UGC_HARD_DIRECTIVE + UGC_FRAMING)
    // via buildKlingAvatarReferencePrompt — the previous one-liner
    // ("soft natural lighting, plain background") was studio-portrait
    // language, the opposite of UGC realism. The helper composes
    // anti-text/anti-broll + amateur-iPhone-selfie framing + a single
    // anti-celeb line. NO long celebrity exclusion laundry list — per
    // Commit 1 spec, Kling Avatar animates a provided face so the
    // heavy Polish-12.6 scrub chain isn't needed.
    const prompt = buildKlingAvatarReferencePrompt();
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
    // Polish-19.0.5: gentle exponential backoff so a slow Kling run
    // doesn't burn early polls when the task can't possibly be ready
    // yet. Caps at 30s — stays responsive when the result lands
    // inside a single interval window.
    await step.sleep(
      `kie-kling-wait-${variantIndex}-${attempt}`,
      `${computeKlingAvatarPollIntervalSeconds(attempt)}s`,
    );
  }

  if (!outputUrl) {
    // Polish-19.0.5: persist the in-flight kie.ai taskId so the
    // operator can recover the existing task instead of paying for
    // a fresh submit on retry. Three layers of preservation:
    //   1. Loud Inngest log with the recordInfo curl line — copy-
    //      paste recovery for ops.
    //   2. A status='failed' generatedCreatives row carrying
    //      kie_task_id + in_flight=true in generationMetadata so
    //      the /runs/[id] view and any future resume worker can
    //      find it.
    //   3. The variant's error string mentions the taskId so it
    //      surfaces in the job's failure message too.
    console.log(
      `[kie-kling-avatar] variant ${variantIndex} timed out after ${POLL_MAX_ATTEMPTS} polls; ` +
        `kie.ai task ${submitResult.taskId} may still be in flight. ` +
        `Inspect via: curl -H 'Authorization: Bearer <KIE_AI_KEY>' ` +
        `'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${submitResult.taskId}'`,
    );
    await step.run(`insert-in-flight-creative-${variantIndex}`, async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        // Polish-16 Fix 2 convention: empty fileUrl on a failed row.
        // The kie_task_id in generationMetadata is the real audit signal.
        fileUrl: '',
        aspectRatio: '9:16',
        status: 'failed',
        format: 'kie_kling_avatar_v2_standard',
        isClipPart: false,
        generationMetadata: {
          variant_index: variantIndex,
          kie_task_id: submitResult.taskId,
          in_flight: true,
          timed_out_after_polls: POLL_MAX_ATTEMPTS,
          target_duration_seconds: targetDurationSeconds,
          last_error_message: pollError ?? null,
          recoverable: true,
        },
      });
    });
    cost += estimateKieKlingAvatarCostUsd(targetDurationSeconds);
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        `kie.ai task ${submitResult.taskId} did not reach a terminal state within ${POLL_MAX_ATTEMPTS} polls ` +
        `(~${Math.round((POLL_MAX_ATTEMPTS * POLL_MAX_INTERVAL_SECONDS) / 60)}min). ` +
        `Task may still be in flight on kie.ai — taskId saved on the failed creative for recovery. ` +
        (pollError ? `Last poll error: ${pollError}` : ''),
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
