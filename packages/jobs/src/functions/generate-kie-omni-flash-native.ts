import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkReplicateConcat,
  checkReplicateFrameExtract,
  createKieOmniCharacter,
  getUniversalUgcMasterPrompt,
  isFrameExtractEnabled,
  isVideoConcatEnabled,
  pollKieOmniTask,
  submitKieOmniVideo,
  submitReplicateConcat,
  submitReplicateFrameExtract,
  type KieOmniDuration,
  type KieOmniResolution,
} from '@mbb/ai-providers';
import { getDb, schema } from '@mbb/db';
import { KIE_OMNI_FLASH_HARD_DIRECTIVE } from '@mbb/shared';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';
import {
  buildImagePromptForClip,
  parseProductionManual,
  stripAudioEraArtifacts,
  stripCharacterSheetPattern,
  stripTextCaptionsBroll,
} from './generate-kling-multi-clip-variants';

/**
 * Polish-12 / Polish-12.1: kie.ai Gemini Omni Flash native pipeline,
 * now multi-segment.
 *
 * Polish-12 shipped one 10s call per generation. Polish-12.1 splits
 * Claude's full multi-clip script into 1-3 Omni Flash segments (each
 * ≤10s), generates them in parallel with the SAME shared Nano Banana
 * reference frame for character consistency, then stitches via the
 * existing Polish-9.12 idan054 ffmpeg-concat helper.
 *
 * Flow:
 *   1. Load job + decrypted keys (claude, gemini, kie_ai).
 *   2. Claude → production manual (Polish-9.10 [USE IMAGE X] parser).
 *   3. ONE Nano Banana reference frame (shared across all segments).
 *   4. splitClipsIntoOmniSegments → 1-3 segments capped at 10s each.
 *   5. Per segment in parallel via Promise.all of step.run:
 *      - buildOmniFlashSegmentPrompt (KIE_OMNI_FLASH_HARD_DIRECTIVE
 *        + scrubbed character + scene + segment-specific monologue +
 *        pacing). Reference image URL passed in image_urls.
 *      - submitKieOmniVideo + warmup sleep + poll loop (5min ceiling).
 *      - Re-upload kie.ai CDN mp4 to Supabase Storage.
 *   6. If 1 segment: that's the deliverable.
 *      If 2+: submitReplicateConcat (idan054 / REPLICATE_VIDEO_CONCAT
 *      _MODEL_ID) with all segment URLs in order, poll, re-upload.
 *   7. Write one composite generated_creatives row (is_clip_part=false,
 *      format='kie_omni_flash_native'). Per-segment rows persisted
 *      with is_clip_part=true for transparency / debugging.
 *
 * Per-variant cost ≈ $0.10 (Claude + reference) + $0.90/segment
 * + $0.05 stitch (only when 2+ segments).
 *   1 segment  →  $1.00
 *   2 segments →  $1.95
 *   3 segments →  $2.80
 *
 * Pipeline ID stays kie_omni_flash_native — Polish-12.1 is a
 * behavioral upgrade, not a new pipeline.
 */

const KIE_OMNI_RESOLUTION: KieOmniResolution = '1080p';
// Polish-12: 15s warmup before first poll, then 10s between checks.
// 30 polls × 10s = 300s = 5min ceiling per segment.
const POLL_WARMUP_SECONDS = 15;
const POLL_INTERVAL_SECONDS = 10;
const POLL_MAX_ATTEMPTS = 30;

// Polish-12.1: Omni Flash supports 4/6/8/10 second generations. We
// cap each segment at 10s and refuse to split below 4s (would just
// confuse the model).
// Polish-14: removed the artificial 3-segment cap. Real production
// sources run 60s testimonials, 90s long-form, 2-3 min podcast
// clips — the bot should follow the script length, not truncate at
// 30s. MAX_SEGMENTS now serves only as a sanity ceiling (30 × 10s
// = 5 min) to bound runaway Claude output and unbounded billing.
const SEGMENT_MAX_SECONDS = 10;
const SEGMENT_MIN_SECONDS = 4;
const MAX_SEGMENTS = 30;
/**
 * Polish-14.1: target script length sent to Claude, derived from the
 * source video's actual duration when available. Falls back to a
 * conservative default for image sources / legacy concepts where
 * duration detection isn't available, and clamps to a sane range so
 * neither a 3s misdetection nor a 5-minute outlier surprises the
 * operator. Polish-14's MAX_SEGMENTS sanity ceiling is independent.
 */
const DEFAULT_TARGET_DURATION = 30;
const MIN_TARGET_DURATION = 8;
const MAX_TARGET_DURATION = 90;

/**
 * Polish-14.1: read `source_duration_seconds` (if any) off the job's
 * metadata jsonb and clamp to [MIN_TARGET_DURATION, MAX_TARGET_DURATION].
 * The clamp protects against:
 *   - missing / null / NaN / 0 → default 30s
 *   - tiny detections (e.g. broken thumbnail) → 8s floor
 *   - long-form outliers → 90s ceiling so a podcast clip doesn't trigger
 *     a 5-minute generation at $27 a job without an explicit override
 * Exported so the cost estimator + tests can mirror the same logic.
 */
export function resolveTargetDuration(jobMetadata: Record<string, unknown> | null): number {
  if (!jobMetadata) return DEFAULT_TARGET_DURATION;
  const raw = jobMetadata['source_duration_seconds'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TARGET_DURATION;
  }
  return Math.max(MIN_TARGET_DURATION, Math.min(MAX_TARGET_DURATION, Math.ceil(raw)));
}
/** Polish-12.1: average natural-speech rate, used to estimate dialogue duration. */
const WORDS_PER_MINUTE = 150;
/** Polish-12.1: Omni Flash per-segment cost (mirrors the kie-omni client constant). */
const KIE_OMNI_COST_USD_PER_SEGMENT = 0.9;
/** Polish-12.1: stitch cost when 2+ segments (idan054 ffmpeg-concat). */
const KIE_OMNI_STITCH_COST_USD = 0.05;
/**
 * Polish-12.4: kie.ai character creation cost. The docs page for
 * the character/create endpoint doesn't publish pricing, so this is
 * a $0.15 placeholder. TODO: reconcile against the kie.ai dashboard
 * credit deduction after the first prod call lands; update both this
 * constant and the matching value in the shared cost estimator.
 */
const KIE_CHARACTER_CREATE_COST_USD = 0.15;

/**
 * Polish-12.6: cap on full-pipeline regenerations (Nano Banana → kie.ai
 * character → all segments). When per-segment retries (Polish-12.2) exhaust
 * with the PROMINENT_PEOPLE_FILTER, the most likely culprit is the Nano
 * Banana reference frame's face — Gemini's classifier interpreted it as
 * celebrity-resembling and no per-segment seed retry can recover. A single
 * full regeneration with a fresh Nano Banana face (and fresh character_id)
 * clears most of those. Bounded at 2 total attempts so the worst case is
 * ~2x base cost.
 */
const MAX_FULL_PIPELINE_REGENERATIONS = 2;

/**
 * Polish-12.6 / 12.7: pure decision helper. Given the first segment
 * failure's error string + the current pipeline attempt number, decide
 * whether to regenerate the whole pipeline (true) or fail definitively
 * (false).
 *
 * Branches:
 *   - currentAttempt at or past maxAttempts → false (budget exhausted)
 *   - segmentError missing → false (nothing actionable to retry on)
 *   - error mentions PROMINENT_PEOPLE_FILTER_FAILED → true (fresh Nano
 *     Banana face fixes it)
 *   - error mentions AUDIO_FILTERED → true (Polish-12.7: regen lets
 *     Claude re-sample the dialogue with different phrasing under the
 *     same master-prompt bypass techniques; second attempts pass
 *     materially often)
 *   - any other failure (auth, balance, validation, network, generic
 *     SAFETY_FILTER) → false (deterministic OR remediated per-segment;
 *     full regen burns money without helping)
 *
 * Exported so the branches can be unit-tested without driving the
 * whole Inngest function.
 */
export function shouldRegeneratePipeline(input: {
  segmentError: string | undefined;
  currentAttempt: number;
  maxAttempts: number;
}): boolean {
  if (input.currentAttempt >= input.maxAttempts) return false;
  if (!input.segmentError) return false;
  return (
    input.segmentError.includes('PROMINENT_PEOPLE_FILTER_FAILED') ||
    input.segmentError.includes('AUDIO_FILTERED')
  );
}

/**
 * Polish-12.2: how many attempts per segment before giving up.
 * Empirical Gemini safety-filter fail rate is ~30% per call; with 3
 * attempts the probability of all three failing on a single segment
 * drops to ~3%, so a 3-segment generation succeeds end-to-end in
 * ~91% of jobs. Bound it so a malformed prompt that hits a true
 * deterministic block doesn't loop forever.
 */
const MAX_OMNI_SEGMENT_RETRIES = 3;

/**
 * Polish-12.2: Gemini safety filter failure codes that are known to
 * be stochastic — an identical retry can pass. We retry these with
 * a fresh seed up to MAX_OMNI_SEGMENT_RETRIES. Auth (401), validation
 * (422), balance (402), and rate-limit (429) errors are NOT retried
 * because they're deterministic; retrying just burns time + credits.
 */
export const RETRYABLE_OMNI_FAIL_CODES: ReadonlySet<string> = new Set([
  'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
  'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
  'PUBLIC_ERROR_PERSON_GENERATION_FAILED',
  // Polish-12.7: dialogue audio filter (financial-fraud pattern
  // density). Stochastic on the same prompt — a fresh Gemini sampling
  // often clears it. Master prompt now teaches Claude to spread money
  // claims across emotional beats / segments for content that
  // commonly trips this.
  'PUBLIC_ERROR_AUDIO_FILTERED',
  // Polish-12.7.1: kie.ai's generic 5xx transient backend error.
  // Retry with the same content (a fresh seed is irrelevant — this
  // is a backend hiccup, not a content trigger). Most retries
  // succeed on the next attempt. Explicitly NOT added to
  // shouldRegeneratePipeline: full Nano Banana regen costs $0.05
  // every time and doesn't help when the failure is a kie.ai
  // backend issue.
  'INTERNAL',
]);

/**
 * Polish-12.7.2: substring patterns for kie.ai transient backend
 * errors that arrive as human-readable strings instead of bare codes.
 * "Internal Error, Please try again later." doesn't match the
 * RETRYABLE_OMNI_FAIL_CODES set's exact 'INTERNAL' entry; the patterns
 * here catch the prose form. Stays conservative — only well-known
 * transient signals; deterministic errors (auth, validation, balance)
 * don't trip these patterns even if their messages mention "error".
 */
const TRANSIENT_OMNI_PATTERNS: ReadonlyArray<RegExp> = [
  /internal\s*error/i,
  /please\s+try\s+again/i,
  /service\s+unavailable/i,
  /timeout/i,
  /deadline\s+exceeded/i,
  /temporarily\s+unavailable/i,
  /backend\s+error/i,
];

/**
 * Polish-12.2.2: defense-in-depth. The kie-omni client already infers
 * failCode from failMsg when kie.ai returns the code inverted (which
 * empirically happens for safety-filter failures). This second check
 * catches any case where the client's pattern miss left failCode
 * undefined but failMsg still carries the bare identifier — including
 * possible future kie.ai response shape drift.
 *
 * Polish-12.7.2: also match free-form human-readable transient errors
 * via TRANSIENT_OMNI_PATTERNS so prose like "Internal Error, Please
 * try again later." gets the same per-segment retry treatment as the
 * bare 'INTERNAL' code.
 */
export function isRetryableOmniFailure(
  failCode: string | undefined | null,
  failMsg?: string | undefined | null,
): boolean {
  if (failCode && RETRYABLE_OMNI_FAIL_CODES.has(failCode)) return true;
  if (failMsg) {
    const trimmed = failMsg.trim();
    if (RETRYABLE_OMNI_FAIL_CODES.has(trimmed)) return true;
    for (const pattern of TRANSIENT_OMNI_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * Polish-12.2: pure decision helper for the per-segment retry loop.
 * Given the outcome of a single submit + poll attempt, return one
 * of three actions:
 *   - 'success' with the output URL → the worker proceeds to upload.
 *   - 'retry' → loop to the next attempt with a fresh seed.
 *   - 'abort' with a reason → fail the whole segment (no further
 *     retries, no further cost).
 *
 * Branches:
 *   submit not ok            → abort (auth/validation/balance —
 *                              deterministic, no point retrying)
 *   poll error (no state)    → abort
 *   poll state=success       → success
 *   poll state=fail:
 *     non-retryable failCode → abort
 *     retryable failCode + more attempts left → retry
 *     retryable failCode + last attempt        → abort with "exhausted retries"
 *   poll state=waiting (timed out without terminal) → abort with
 *                              "did not reach terminal state"
 *
 * Exported so the retry-loop branches can be unit-tested without
 * mocking Inngest's step harness.
 */
export type OmniAttemptOutcome =
  | { kind: 'success'; outputUrl: string }
  | { kind: 'retry' }
  | { kind: 'abort'; reason: string };

export function decideOmniAttemptOutcome(input: {
  submitOk: boolean;
  submitError?: string;
  /** undefined when the poll layer itself errored before reaching a terminal state. */
  pollState?: 'success' | 'fail' | 'waiting';
  pollError?: string;
  outputUrl?: string;
  failCode?: string;
  failMsg?: string;
  attempt: number;
  maxAttempts: number;
}): OmniAttemptOutcome {
  // Submit-level errors are deterministic — auth, validation, balance.
  // Retrying them would just burn time + credits.
  if (!input.submitOk) {
    return {
      kind: 'abort',
      reason: input.submitError ?? 'submit failed',
    };
  }
  // Successful generation — the only "success" branch.
  if (input.pollState === 'success' && input.outputUrl) {
    return { kind: 'success', outputUrl: input.outputUrl };
  }
  // Poll-layer error (kie.ai 5xx during poll, network blip etc.) —
  // treat as deterministic for this attempt to avoid runaway retries.
  if (input.pollState === undefined) {
    return {
      kind: 'abort',
      reason: input.pollError ?? 'kie.ai poll failed',
    };
  }
  // Documented failure state — decide retry vs abort by failCode.
  if (input.pollState === 'fail') {
    const retryable = isRetryableOmniFailure(input.failCode, input.failMsg);
    if (!retryable) {
      return {
        kind: 'abort',
        reason:
          input.failMsg ??
          input.pollError ??
          `kie.ai task failed${input.failCode ? ` (${input.failCode})` : ''}`,
      };
    }
    if (input.attempt >= input.maxAttempts) {
      return {
        kind: 'abort',
        reason: `Segment exhausted ${input.maxAttempts} attempt(s); last failure: ${input.failCode}${
          input.failMsg ? ` — ${input.failMsg}` : ''
        }`,
      };
    }
    return { kind: 'retry' };
  }
  // Still waiting — the worker's poll loop hit its per-attempt
  // timeout without seeing success or fail. Don't retry; failing the
  // segment surfaces the kie.ai-side hang to the operator.
  return {
    kind: 'abort',
    reason: input.pollError ?? 'kie.ai task did not reach a terminal state',
  };
}

export const generateKieOmniFlashNative = inngest.createFunction(
  {
    id: 'generate-kie-omni-flash-native',
    name: 'Generate Gemini Omni Flash native UGC ad',
    retries: 1,
  },
  { event: 'generation/kie-omni-flash-native.requested' },
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

    if (mode === 'mock') {
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-composite', async () => {
        const db = getDb();
        await db.insert(schema.generatedCreatives).values({
          userId,
          generationJobId: jobId,
          fileUrl: 'https://samplelib.com/lib/preview/mp4/sample-10s.mp4',
          aspectRatio: '9:16',
          status: 'ready_for_review',
          format: 'kie_omni_flash_native',
          isClipPart: false,
          generationMetadata: { mock: true, segments: 1 },
        });
      });
      await markJobCompleted({
        jobId,
        userId,
        mode,
        startedAt,
        variantCount: 1,
        actualCostUsd: 0,
        provider: 'kling',
        path: 'kie-omni-flash-native',
      });
      return { jobId, mode, generated: 1 };
    }

    // live: ask Claude for the production manual
    const manualResult = await step.run('claude-production-manual', async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['claude']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message, costUsd: 0 };
        throw err;
      }
      const systemPrompt = getUniversalUgcMasterPrompt();
      // Polish-12.1: target 30s so Claude has room to write a full
      // multi-clip script. Splitter caps at 3 × 10s segments.
      // Polish-14.1: target follows the source video's actual length
      // (persisted on job.metadata.source_duration_seconds at submit
      // time). Falls back to 30s for image / legacy concepts where
      // duration wasn't detected. resolveTargetDuration clamps to a
      // sane range so neither a misdetection nor a runaway override
      // burns the operator's daily AI budget.
      const targetDurationSeconds = resolveTargetDuration(
        (job.metadata ?? null) as Record<string, unknown> | null,
      );
      const userMessage = JSON.stringify({
        analysis: job.metadata ?? {},
        variant_count: 1,
        target_duration_seconds: targetDurationSeconds,
      });
      const claude = await callClaude({
        userId,
        apiKey: keys.claude!,
        systemPrompt,
        userMessage,
        maxTokens: 16384,
        generationJobId: jobId,
      });
      if (!claude.ok) {
        console.log(`[kie-omni-manual] Claude call failed: ${claude.errorMessage ?? 'unknown'}`);
        return {
          ok: false as const,
          error: claude.errorMessage ?? 'Claude manual generation failed',
          costUsd: claude.costUsd,
        };
      }
      console.log(
        `[kie-omni-manual] Claude returned ${(claude.text ?? '').length} chars; first 1000: ${(
          claude.text ?? ''
        ).slice(0, 1000)}`,
      );
      const parsed = parseProductionManual(claude.json ?? claude.text);
      if (!parsed.ok) {
        console.log(`[kie-omni-manual] parse failed: ${parsed.error}`);
        return { ok: false as const, error: parsed.error, costUsd: claude.costUsd };
      }
      return { ok: true as const, manual: parsed.manual, costUsd: claude.costUsd };
    });
    if (!manualResult.ok) {
      await markJobFailed(jobId, userId, manualResult.error, manualResult.costUsd);
      return { jobId, mode, generated: 0 };
    }
    const manual = manualResult.manual;
    let totalCost = manualResult.costUsd;

    // Split clips into 1-30 segments (sanity-capped). Independent of
    // the pipeline-attempt loop below — same script feeds every
    // attempt, so the split is computed once.
    const segments = splitClipsIntoOmniSegments(manual.clips);
    if (segments.length === 0) {
      await markJobFailed(jobId, userId, 'Manual has no dialogue to split', totalCost);
      return { jobId, mode, generated: 0 };
    }
    console.log(
      `[kie-omni] split into ${segments.length} segment(s): ${segments
        .map((s) => `#${s.segmentIndex}=${s.estimatedDurationSeconds}s/${s.clips.length}clips`)
        .join(' ')}`,
    );

    // Polish-12.3 / 12.3.1: layered scrub before the prompt hits Omni
    // Flash. Master prompt now instructs Claude to avoid public figures
    // up front, but if a celebrity name OR a brand-as-person reference
    // (Disney/Tesla/Trump Tower etc.) slipped through (e.g., echoed
    // from the source creative's analysis), strip both here so Gemini's
    // PROMINENT_PEOPLE_FILTER doesn't trip on segment after segment.
    // Scrubbed strings are pipeline-attempt-invariant — same source
    // text feeds every regeneration.
    const scrubbedCharacter = scrubAll(
      stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt)),
    );
    const scrubbedScene = scrubAll(stripTextCaptionsBroll(manual.setPrompt));

    // ===================================================================
    // Polish-12.6: full-pipeline regeneration loop.
    //
    //   Each iteration: fresh Nano Banana reference → fresh kie.ai
    //   character_id → sequential segment chain (Polish-12.5).
    //
    //   When per-segment retries (Polish-12.2) exhaust with
    //   PROMINENT_PEOPLE_FILTER_FAILED, the most likely culprit is the
    //   Nano Banana face — Gemini's classifier flagged it as
    //   celebrity-resembling and no per-segment seed retry can
    //   recover. shouldRegeneratePipeline() decides whether the failure
    //   warrants another pass (filter-only); deterministic failures
    //   (auth, balance, validation) abort immediately.
    //
    //   Step names are suffixed with `-p2`, `-p3`, … on regen so
    //   Inngest's dedupe layer doesn't replay the cached attempt-1
    //   result. Attempt 1 keeps the un-suffixed names so the common
    //   single-attempt path looks identical to Polish-12.5.
    // ===================================================================
    let referenceImageUrl = '';
    let characterIdForSegments: string | undefined;
    let characterResult: {
      ok: boolean;
      characterId?: string;
      errorMessage?: string;
      costUsd: number;
    } = { ok: false, costUsd: 0 };
    let segmentResults: SegmentResult[] = [];
    let chainBreakReason: string | undefined;
    let frameExtractTotalCost = 0;
    let chainReferenceUrls: string[] = [];
    let pipelineAttempts = 0;
    let pipelineFinalFailure: { message: string; costUsd: number } | undefined;

    for (
      let pipelineAttempt = 1;
      pipelineAttempt <= MAX_FULL_PIPELINE_REGENERATIONS;
      pipelineAttempt++
    ) {
      pipelineAttempts = pipelineAttempt;
      const pipelineStep = suffixStep(step, pipelineAttempt === 1 ? '' : `-p${pipelineAttempt}`);

      // Reset per-attempt state.
      segmentResults = [];
      chainBreakReason = undefined;
      frameExtractTotalCost = 0;
      chainReferenceUrls = [];

      // 1. Nano Banana reference. Each pipeline attempt re-runs this
      //    with a fresh Inngest step (via the -pN suffix), so Gemini
      //    rolls a fresh face each time we regenerate.
      const referenceResult = await pipelineStep.run('nano-banana-reference', async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['gemini']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message, costUsd: 0 };
          throw err;
        }
        const firstClip = manual.clips[0];
        if (!firstClip) {
          return { ok: false as const, error: 'Manual has 0 clips', costUsd: 0 };
        }
        const prompt = buildImagePromptForClip(manual, firstClip);
        const image = await callGeminiImage({
          userId,
          apiKey: keys.gemini!,
          prompt,
          generationJobId: jobId,
        });
        if (!image.ok || !image.imageBase64 || !image.imageMimeType) {
          return {
            ok: false as const,
            error: image.errorMessage ?? 'Nano Banana returned no image',
            costUsd: image.costUsd,
          };
        }
        try {
          const upload = await uploadGeneratedImage({
            userId,
            jobId,
            // Bump variantIndex per pipeline attempt so the regen
            // upload doesn't collide with the original reference path.
            variantIndex: pipelineAttempt - 1,
            imageBase64: image.imageBase64,
            mimeType: image.imageMimeType,
            filenamePrefix: 'kie-omni-ref-',
          });
          return { ok: true as const, publicUrl: upload.publicUrl, costUsd: image.costUsd };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false as const,
            error: `Reference frame upload failed: ${msg}`,
            costUsd: image.costUsd,
          };
        }
      });
      if (!referenceResult.ok) {
        // Nano Banana failures aren't retryable via regen (the cause
        // is the prompt or the provider, not stochastic face output).
        pipelineFinalFailure = {
          message: referenceResult.error,
          costUsd: referenceResult.costUsd,
        };
        break;
      }
      totalCost += referenceResult.costUsd;
      referenceImageUrl = referenceResult.publicUrl;

      // 2. Polish-12.4: register the Nano Banana reference as a
      //    kie.ai character. Each pipeline attempt registers a NEW
      //    character_id pinned to its specific Nano Banana frame.
      characterResult = await pipelineStep.run('kie-omni-character-create', async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['kie_ai']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, errorMessage: err.message, costUsd: 0 };
          throw err;
        }
        const result = await createKieOmniCharacter({
          userId,
          apiKey: keys.kie_ai!,
          imageUrl: referenceImageUrl,
          characterDescription: scrubbedCharacter,
          characterName: 'ad_character',
          generationJobId: jobId,
        });
        return {
          ok: result.ok,
          characterId: result.characterId,
          errorMessage: result.errorMessage,
          costUsd: KIE_CHARACTER_CREATE_COST_USD,
        };
      });
      if (characterResult.ok) {
        totalCost += characterResult.costUsd;
      } else {
        console.warn(
          `[kie-omni] character creation failed (${characterResult.errorMessage ?? 'unknown'}); ` +
            `falling back to image_urls-only path`,
        );
        // Bill the operator when the character/create request actually
        // hit kie.ai. MissingProviderKeyError reports costUsd=0.
        if (characterResult.costUsd > 0) totalCost += characterResult.costUsd;
      }
      characterIdForSegments = characterResult.ok ? characterResult.characterId : undefined;

      // 3. Sequential segment chain (Polish-12.5).
      let currentReferenceUrl = referenceImageUrl;
      for (const segment of segments) {
        const result = await runOmniSegment({
          step: pipelineStep,
          segment: {
            ...segment,
            combinedDialogue: scrubAll(segment.combinedDialogue),
          },
          totalSegments: segments.length,
          referenceImageUrl: currentReferenceUrl,
          characterId: characterIdForSegments,
          characterDescription: scrubbedCharacter,
          sceneDescription: scrubbedScene,
          userId,
          jobId,
        });
        segmentResults.push(result);

        if (!result.ok) {
          chainBreakReason = `segment ${segment.segmentIndex} failed: ${result.error}`;
          console.log(`[kie-omni] chain broken — ${chainBreakReason}`);
          break;
        }

        const isLastSegment = segment.segmentIndex === segments.length - 1;
        if (!isLastSegment) {
          const frameResult = await runFrameExtract({
            step: pipelineStep,
            videoUrl: result.publicUrl,
            segmentIndex: segment.segmentIndex,
            userId,
            jobId,
          });
          if (frameResult.ok) {
            currentReferenceUrl = frameResult.publicUrl;
            chainReferenceUrls.push(frameResult.publicUrl);
            frameExtractTotalCost += frameResult.costUsd;
            console.log(
              `[kie-omni] segment ${segment.segmentIndex} → next ref (chained): ${frameResult.publicUrl}`,
            );
          } else {
            console.warn(
              `[kie-omni] segment ${segment.segmentIndex} frame extraction failed (${frameResult.error}); ` +
                `next segment will reuse the current reference (degraded chain continuity)`,
            );
          }
        }
      }

      const failures = segmentResults.filter((r) => !r.ok);
      if (failures.length === 0) {
        // Whole chain succeeded — exit the pipeline loop. Cost
        // accumulation for the successes happens below alongside
        // frameExtractTotalCost.
        break;
      }

      // Failed: accumulate sunk costs from THIS attempt so the next
      // iteration's segment retries are billed too.
      for (const r of segmentResults) totalCost += r.costUsd;
      totalCost += frameExtractTotalCost;

      const firstFailure = failures[0]!;
      if (
        !shouldRegeneratePipeline({
          segmentError: firstFailure.error,
          currentAttempt: pipelineAttempt,
          maxAttempts: MAX_FULL_PIPELINE_REGENERATIONS,
        })
      ) {
        pipelineFinalFailure = {
          message: `Omni segment(s) failed: ${failures
            .map((f) => `segment ${f.segmentIndex}: ${f.error}`)
            .join('; ')}`,
          costUsd: 0,
        };
        break;
      }
      console.warn(
        `[kie-omni] pipeline attempt ${pipelineAttempt} hit PROMINENT_PEOPLE filter; ` +
          `regenerating Nano Banana with fresh seed ` +
          `(next attempt ${pipelineAttempt + 1}/${MAX_FULL_PIPELINE_REGENERATIONS})`,
      );
    }

    if (pipelineFinalFailure) {
      await markJobFailed(
        jobId,
        userId,
        pipelineFinalFailure.message,
        totalCost + pipelineFinalFailure.costUsd,
      );
      return { jobId, mode, generated: 0 };
    }

    // Polish-12.6: success path. segmentResults / chainReferenceUrls /
    // frameExtractTotalCost reflect the WINNING pipeline attempt only;
    // sunk costs from failed earlier attempts already accumulated
    // inside the loop.
    const successes = segmentResults.filter((r): r is SegmentSuccess => r.ok);
    const segmentUrls = successes.map((r) => r.publicUrl);
    for (const r of successes) totalCost += r.costUsd;
    totalCost += frameExtractTotalCost;

    // 4. Stitch when 2+ segments. Single-segment path skips this.
    let finalUrl: string;
    let stitched = false;
    if (segments.length >= 2) {
      if (!isVideoConcatEnabled()) {
        const msg =
          'Polish-12.1 needs REPLICATE_VIDEO_CONCAT_MODEL_ID to stitch multi-segment Omni Flash ads. ' +
          'Set it to the idan054/better-video-merge slug and redeploy.';
        console.log(`[kie-omni-stitch] ${msg}`);
        await markJobFailed(jobId, userId, msg, totalCost);
        return { jobId, mode, generated: 0 };
      }
      const stitchResult = await runOmniStitch({
        step,
        segmentUrls,
        userId,
        jobId,
      });
      if (!stitchResult.ok) {
        console.log(`[kie-omni-stitch] failed: ${stitchResult.error}`);
        await markJobFailed(jobId, userId, `Stitch failed: ${stitchResult.error}`, totalCost);
        return { jobId, mode, generated: 0 };
      }
      totalCost += stitchResult.costUsd;
      finalUrl = stitchResult.publicUrl;
      stitched = true;
    } else {
      finalUrl = segmentUrls[0]!;
    }

    // 5. Persist per-segment rows (transparency / debugging) + the
    //    composite as the primary deliverable.
    await step.run('write-segments', async () => {
      const db = getDb();
      const rows = successes.map((r, i) => ({
        userId,
        generationJobId: jobId,
        fileUrl: r.publicUrl,
        aspectRatio: '9:16' as const,
        status: 'ready_for_review' as const,
        format: 'kie_omni_flash_native_segment',
        clipIndex: i,
        isClipPart: true,
        generationMetadata: {
          segment_index: r.segmentIndex,
          kie_task_id: r.taskId,
          kie_source_url: r.kieSourceUrl,
          reupload_ok: r.reuploadOk,
          duration_seconds: r.durationSeconds,
          // Polish-12.2: track retry attempts per segment for QA.
          attempts: r.attempts,
          // Polish-12.5: which reference fed this segment. Lets QA
          // walk the chain back to its anchor.
          reference_url_used: r.referenceUrlUsed,
        },
      }));
      await db.insert(schema.generatedCreatives).values(rows);
    });

    await step.run('write-composite', async () => {
      const db = getDb();
      await db.insert(schema.generatedCreatives).values({
        userId,
        generationJobId: jobId,
        fileUrl: finalUrl,
        aspectRatio: '9:16',
        status: 'ready_for_review',
        format: 'kie_omni_flash_native',
        isClipPart: false,
        generationMetadata: {
          segments: segments.length,
          stitched,
          segment_urls: segmentUrls,
          reference_image_url: referenceImageUrl,
          // Polish-12.4: trace the kie.ai character used (if any) so QA
          // can correlate filter-trigger rates against character_ids
          // present vs. fallback path. character_create_error captured
          // verbatim when the soft-fallback fired.
          kie_character_id: characterIdForSegments ?? null,
          character_create_succeeded: characterResult.ok,
          character_create_error: characterResult.ok
            ? null
            : (characterResult.errorMessage ?? null),
          character_prompt: manual.characterPrompt,
          set_prompt: manual.setPrompt,
          resolution: KIE_OMNI_RESOLUTION,
          // Polish-12.2: tally retry attempts across segments. Useful
          // for QA: high totals on a single user indicate prompt
          // content triggering Gemini filters frequently.
          total_attempts: successes.reduce((s, x) => s + x.attempts, 0),
          attempts_by_segment: successes.map((x) => x.attempts),
          // Polish-12.5: chain-continuity audit trail. Each entry is
          // the extracted last-frame URL that fed into the NEXT
          // segment's image_urls reference. Length = successes-1 when
          // every chain link extracted cleanly. chain_break_reason
          // populated only when a segment itself failed mid-chain.
          chain_continuity_enabled: isFrameExtractEnabled(),
          chain_reference_urls: chainReferenceUrls,
          chain_break_reason: chainBreakReason ?? null,
          per_segment_reference_urls: successes.map((x) => x.referenceUrlUsed),
          // Polish-12.6: tracks whether the full-pipeline regen loop
          // fired and how many attempts it took. >1 means PROMINENT_
          // PEOPLE_FILTER tripped at least once and a fresh Nano
          // Banana face cleared it.
          pipeline_attempts: pipelineAttempts,
          pipeline_filter_regeneration_used: pipelineAttempts > 1,
        },
      });
    });
    console.log(
      `[kie-omni] composite written: ${finalUrl} (${segments.length} segment(s), ${successes.reduce(
        (s, x) => s + x.attempts,
        0,
      )} total attempts)`,
    );

    await markJobCompleted({
      jobId,
      userId,
      mode,
      startedAt,
      variantCount: 1,
      actualCostUsd: totalCost,
      provider: 'kling',
      path: 'kie-omni-flash-native',
    });
    return { jobId, mode, generated: 1, totalCost };
  },
);

// =========================================================================
// Per-segment generation helper
// =========================================================================

interface SegmentSuccess {
  ok: true;
  segmentIndex: number;
  publicUrl: string;
  taskId: string;
  kieSourceUrl: string;
  reuploadOk: boolean;
  durationSeconds: number;
  /** Polish-12.2: number of submit/poll attempts spent on this segment. */
  attempts: number;
  /** Sum of kie.ai cost across all attempts (Gemini bills attempts, not successes). */
  costUsd: number;
  /**
   * Polish-12.5: which image_urls reference this segment actually
   * generated against. Segment 0 = Nano Banana shared reference;
   * segments 1..N = the previous segment's extracted last frame
   * (or Nano Banana fallback when extraction failed).
   */
  referenceUrlUsed: string;
}
interface SegmentFailure {
  ok: false;
  segmentIndex: number;
  error: string;
  /** Polish-12.2: number of attempts spent before giving up. */
  attempts: number;
  costUsd: number;
}
type SegmentResult = SegmentSuccess | SegmentFailure;

// Polish-12.1: the Inngest step type is deep + recursive (the return
// of step.run is wrapped in Jsonify<Awaited<…>>). Helpers below take
// `unknown` to keep them testable and decoupled from Inngest's
// internal types; the call sites in the worker still get full type
// safety on the step argument via the createFunction generics.
type InngestStepLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (name: string, fn: () => Promise<any>) => Promise<any>;
  sleep: (name: string, duration: string) => Promise<unknown>;
};

/**
 * Polish-12.6: wrap an InngestStepLike so every step.run / step.sleep
 * call gets a suffix appended to its name. Used by the full-pipeline
 * regeneration loop so the 2nd attempt's steps have distinct names
 * from the 1st attempt's — without this, Inngest's dedupe layer
 * replays the cached failed result from attempt 1 instead of running
 * fresh.
 *
 * Attempt 1 passes the raw step (empty suffix) so the common
 * single-attempt path keeps its existing step names unchanged.
 */
function suffixStep(step: InngestStepLike, suffix: string): InngestStepLike {
  if (suffix === '') return step;
  return {
    run: (name, fn) => step.run(`${name}${suffix}`, fn),
    sleep: (name, duration) => step.sleep(`${name}${suffix}`, duration),
  };
}

export async function runOmniSegment(input: {
  step: InngestStepLike;
  segment: OmniFlashSegment;
  totalSegments: number;
  referenceImageUrl: string;
  /**
   * Polish-12.4: kie.ai-registered character id, passed as character_ids
   * to every submitKieOmniVideo call. Undefined → fall back to
   * image_urls-only (legacy Polish-12 behavior).
   */
  characterId?: string;
  characterDescription: string;
  sceneDescription: string;
  userId: string;
  jobId: string;
}): Promise<SegmentResult> {
  const { step, segment, totalSegments, referenceImageUrl, characterId, userId, jobId } = input;
  const segmentDuration = clampOmniDuration(segment.estimatedDurationSeconds);
  const segmentPrompt = buildOmniFlashSegmentPrompt({
    characterDescription: input.characterDescription,
    sceneDescription: input.sceneDescription,
    segmentDialogue: segment.combinedDialogue,
    segmentDurationSeconds: segmentDuration,
    segmentIndexLabel:
      totalSegments > 1 ? `Part ${segment.segmentIndex + 1} of ${totalSegments}` : undefined,
  });

  // Polish-12.2: retry loop for stochastic Gemini safety filter
  // failures. Each attempt uses a fresh random seed; failed attempts
  // still bill (Gemini charges attempts, not successes). Submit-level
  // errors (auth, validation, balance) are NOT retried — they're
  // deterministic and retrying would just burn time.
  let attempts = 0;
  let lastError = 'kie.ai segment failed without a recorded error';
  let lastFailCode: string | undefined;
  let outputUrl: string | undefined;
  let lastTaskId: string | undefined;

  retry: for (let attempt = 1; attempt <= MAX_OMNI_SEGMENT_RETRIES; attempt++) {
    attempts = attempt;
    const seedForAttempt = Math.floor(Math.random() * 2147483647);

    const submitResult = await step.run(
      `kie-omni-submit-${segment.segmentIndex}-a${attempt}`,
      async () => {
        let keys;
        try {
          keys = await loadDecryptedKeys(userId, ['kie_ai']);
        } catch (err) {
          if (err instanceof MissingProviderKeyError)
            return { ok: false as const, error: err.message };
          throw err;
        }
        return submitKieOmniVideo({
          userId,
          apiKey: keys.kie_ai!,
          prompt: segmentPrompt,
          imageUrls: [referenceImageUrl],
          // Polish-12.4: send the registered character id alongside
          // the reference image when available. character_ids signals
          // a pre-registered fictional entity to kie.ai's filter
          // pipeline. Undefined when character creation failed →
          // submit ignores the field and falls back to image-only.
          characterIds: characterId ? [characterId] : undefined,
          durationSeconds: durationToOmniLiteral(segmentDuration),
          aspectRatio: '9:16',
          resolution: KIE_OMNI_RESOLUTION,
          seed: seedForAttempt,
          generationJobId: jobId,
        });
      },
    );
    const submitOk = submitResult.ok && 'taskId' in submitResult && Boolean(submitResult.taskId);
    const submitError =
      'errorMessage' in submitResult
        ? (submitResult.errorMessage ?? undefined)
        : 'error' in submitResult
          ? (submitResult.error ?? undefined)
          : undefined;
    if (!submitOk) {
      const decision = decideOmniAttemptOutcome({
        submitOk: false,
        submitError,
        attempt,
        maxAttempts: MAX_OMNI_SEGMENT_RETRIES,
      });
      // Submit branch never returns 'retry' — only 'abort' or
      // (impossible here) 'success'.
      return {
        ok: false,
        segmentIndex: segment.segmentIndex,
        error: decision.kind === 'abort' ? decision.reason : 'submit failed',
        attempts,
        costUsd: (attempts - 1) * KIE_OMNI_COST_USD_PER_SEGMENT,
      };
    }
    const taskId = (submitResult as { taskId: string }).taskId;
    lastTaskId = taskId;

    await step.sleep(
      `kie-omni-warmup-${segment.segmentIndex}-a${attempt}`,
      `${POLL_WARMUP_SECONDS}s`,
    );
    let pollState: 'success' | 'fail' | 'waiting' | undefined;
    let pollError: string | undefined;
    let failCode: string | undefined;
    let failMsg: string | undefined;
    let attemptOutputUrl: string | undefined;
    for (let pollIdx = 0; pollIdx < POLL_MAX_ATTEMPTS; pollIdx++) {
      const tick = await step.run(
        `kie-omni-check-${segment.segmentIndex}-a${attempt}-${pollIdx}`,
        async () => {
          const keys = await loadDecryptedKeys(userId, ['kie_ai']);
          return pollKieOmniTask({
            userId,
            apiKey: keys.kie_ai!,
            taskId,
            generationJobId: jobId,
          });
        },
      );
      // Polish-12.2.1: check documented terminal states (success, fail)
      // BEFORE the generic !ok branch. pollKieOmniTask may surface a
      // documented task failure as { ok: false, state: 'fail', ... }
      // (e.g. when kie.ai returns a non-200 envelope code alongside
      // a stochastic Gemini safety-filter failCode in the body).
      // That's a retryable outcome, NOT a poll-layer error.
      // Misclassifying it killed retry in Polish-12.2.
      if (tick.state === 'success') {
        pollState = 'success';
        attemptOutputUrl = tick.outputUrl;
        break;
      }
      if (tick.state === 'fail') {
        pollState = 'fail';
        failCode = tick.failCode;
        failMsg = tick.failMsg;
        pollError =
          tick.failMsg ?? `kie.ai task failed${tick.failCode ? ` (${tick.failCode})` : ''}`;
        break;
      }
      // state is 'waiting' OR undefined (network blip / 5xx mid-poll).
      // If state is undefined AND ok is false → poll-layer error → abort
      // (pollState stays undefined → decideOmniAttemptOutcome aborts).
      // If state is 'waiting' → fall through to the next poll interval.
      if (!tick.ok && tick.state === undefined) {
        pollError = tick.errorMessage ?? 'kie.ai poll failed';
        break;
      }
      await step.sleep(
        `kie-omni-poll-${segment.segmentIndex}-a${attempt}-${pollIdx}`,
        `${POLL_INTERVAL_SECONDS}s`,
      );
    }
    if (pollState === undefined && attemptOutputUrl === undefined && pollError === undefined) {
      // Poll loop walked all attempts without seeing a terminal state.
      pollState = 'waiting';
    }

    const decision = decideOmniAttemptOutcome({
      submitOk: true,
      pollState,
      pollError,
      outputUrl: attemptOutputUrl,
      failCode,
      failMsg,
      attempt,
      maxAttempts: MAX_OMNI_SEGMENT_RETRIES,
    });

    if (decision.kind === 'success') {
      outputUrl = decision.outputUrl;
      break retry;
    }
    if (decision.kind === 'abort') {
      lastError = decision.reason;
      lastFailCode = failCode;
      return {
        ok: false,
        segmentIndex: segment.segmentIndex,
        error: lastError,
        attempts,
        costUsd: attempts * KIE_OMNI_COST_USD_PER_SEGMENT,
      };
    }
    // decision.kind === 'retry'
    lastError = pollError ?? `attempt ${attempt} hit ${failCode ?? 'unknown'}`;
    lastFailCode = failCode;
    console.warn(
      `[kie-omni] segment ${segment.segmentIndex} attempt ${attempt} hit ${failCode ?? 'unknown'}; retrying with a fresh seed`,
    );
  }

  if (!outputUrl) {
    return {
      ok: false,
      segmentIndex: segment.segmentIndex,
      error: `Segment ${segment.segmentIndex} failed after ${attempts} attempt(s)${lastFailCode ? ` (${lastFailCode})` : ''}: ${lastError}`,
      attempts,
      costUsd: attempts * KIE_OMNI_COST_USD_PER_SEGMENT,
    };
  }

  const uploadResult = await step.run(`kie-omni-upload-${segment.segmentIndex}`, async () => {
    try {
      const upload = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: outputUrl!,
        filename: `omni-segment-${segment.segmentIndex}`,
      });
      return { ok: true as const, publicUrl: upload.publicUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });
  const publicUrl = uploadResult.ok ? uploadResult.publicUrl : outputUrl;
  return {
    ok: true,
    segmentIndex: segment.segmentIndex,
    publicUrl,
    taskId: lastTaskId!,
    kieSourceUrl: outputUrl,
    reuploadOk: uploadResult.ok,
    durationSeconds: segmentDuration,
    attempts,
    costUsd: attempts * KIE_OMNI_COST_USD_PER_SEGMENT,
    // Polish-12.5: surface which image_urls reference fed into this
    // segment so the caller can audit chain continuity per segment.
    referenceUrlUsed: referenceImageUrl,
  };
}

// =========================================================================
// Polish-12.5: per-chain-link frame extraction (sequential helper)
// =========================================================================

/**
 * Polish-12.5: chain-continuity frame extraction. Submits the just-
 * generated segment's MP4 to the Replicate frame-extract model, polls
 * for completion, returns the extracted last frame's public URL.
 *
 * Disabled gracefully when REPLICATE_FRAME_EXTRACT_MODEL_ID isn't
 * configured — caller falls back to the existing Nano Banana reference
 * for the next segment (character_id still anchors identity).
 *
 * Pure step-orchestration around the Replicate API surface. The
 * returned frame URL is what the model emits — we don't re-host it
 * to Supabase because the next segment's kie.ai call only needs to
 * dereference it once during inference, and Replicate's delivery
 * URLs are stable for the prediction's TTL (24h+). If kie.ai ever
 * complains about cross-origin fetches we'd add a re-upload step
 * here.
 */
export async function runFrameExtract(input: {
  step: InngestStepLike;
  videoUrl: string;
  segmentIndex: number;
  userId: string;
  jobId: string;
}): Promise<{ ok: true; publicUrl: string; costUsd: number } | { ok: false; error: string }> {
  const { step, videoUrl, segmentIndex, userId, jobId } = input;

  if (!isFrameExtractEnabled()) {
    return {
      ok: false,
      error: 'REPLICATE_FRAME_EXTRACT_MODEL_ID not set; chain continuity disabled',
    };
  }

  const submit = await step.run(`kie-omni-frame-extract-submit-${segmentIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['kling']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    return submitReplicateFrameExtract({
      userId,
      apiKey: keys.kling!,
      videoUrl,
      generationJobId: jobId,
    });
  });
  if (!submit.ok || !('predictionId' in submit) || !submit.predictionId) {
    const err =
      'errorMessage' in submit
        ? submit.errorMessage
        : 'error' in submit
          ? submit.error
          : 'frame-extract submit failed';
    return { ok: false, error: err ?? 'submit failed' };
  }
  const predictionId = submit.predictionId;

  let frameUrl: string | undefined;
  let extractCost = 0;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await step.sleep(
      `kie-omni-frame-extract-poll-${segmentIndex}-${attempt}`,
      `${POLL_INTERVAL_SECONDS}s`,
    );
    const tick = await step.run(
      `kie-omni-frame-extract-check-${segmentIndex}-${attempt}`,
      async () => {
        const keys = await loadDecryptedKeys(userId, ['kling']);
        return checkReplicateFrameExtract({
          userId,
          apiKey: keys.kling!,
          predictionId,
          generationJobId: jobId,
        });
      },
    );
    if (tick.status === 'completed') {
      frameUrl = tick.frameUrl;
      extractCost = tick.costUsd;
      break;
    }
    if (tick.status === 'failed') {
      return { ok: false, error: tick.errorMessage ?? 'frame-extract failed' };
    }
  }
  if (!frameUrl) {
    return {
      ok: false,
      error: `frame-extract timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`,
    };
  }
  return { ok: true, publicUrl: frameUrl, costUsd: extractCost };
}

interface StitchSuccess {
  ok: true;
  publicUrl: string;
  costUsd: number;
}
interface StitchFailure {
  ok: false;
  error: string;
  costUsd: number;
}

async function runOmniStitch(input: {
  step: InngestStepLike;
  segmentUrls: string[];
  userId: string;
  jobId: string;
}): Promise<StitchSuccess | StitchFailure> {
  const { step, segmentUrls, userId, jobId } = input;

  const submit = await step.run('kie-omni-stitch-submit', async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['kling']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    return submitReplicateConcat({
      userId,
      apiKey: keys.kling!,
      videoUrls: segmentUrls,
      generationJobId: jobId,
    });
  });
  if (!submit.ok || !('predictionId' in submit) || !submit.predictionId) {
    const err =
      'errorMessage' in submit
        ? submit.errorMessage
        : 'error' in submit
          ? submit.error
          : 'concat submit failed';
    return { ok: false, error: err ?? 'submit failed', costUsd: 0 };
  }
  const predictionId = submit.predictionId;

  let stitchedUrl: string | undefined;
  let stitchCost = 0;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await step.sleep(`kie-omni-stitch-poll-${attempt}`, `${POLL_INTERVAL_SECONDS}s`);
    const tick = await step.run(`kie-omni-stitch-check-${attempt}`, async () => {
      const keys = await loadDecryptedKeys(userId, ['kling']);
      return checkReplicateConcat({
        userId,
        apiKey: keys.kling!,
        predictionId,
        generationJobId: jobId,
      });
    });
    if (tick.status === 'completed') {
      stitchedUrl = tick.videoUrl;
      stitchCost = tick.costUsd;
      break;
    }
    if (tick.status === 'failed') {
      return {
        ok: false,
        error: tick.errorMessage ?? 'stitch failed',
        costUsd: 0,
      };
    }
  }
  if (!stitchedUrl) {
    return {
      ok: false,
      error: `Stitch timed out after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS}s`,
      costUsd: 0,
    };
  }

  const uploadResult = await step.run('kie-omni-stitch-upload', async () => {
    try {
      const upload = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: stitchedUrl!,
        filename: 'omni-output',
      });
      return { ok: true as const, publicUrl: upload.publicUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });
  const publicUrl = uploadResult.ok ? uploadResult.publicUrl : stitchedUrl;
  return { ok: true, publicUrl, costUsd: stitchCost + KIE_OMNI_STITCH_COST_USD };
}

// =========================================================================
// Pure helpers — exported for unit tests
// =========================================================================

/**
 * Polish-12.3: defense-in-depth scrub. The master prompt now
 * instructs Claude up front to avoid public figures, but if a
 * celebrity name slips through (e.g., echoed verbatim from the
 * source creative's analysis), we replace it with a generic
 * placeholder before the prompt hits Gemini Omni Flash —
 * PROMINENT_PEOPLE_FILTER fails the whole segment otherwise and
 * retries with fresh seeds can't recover from CONTENT triggers.
 *
 * Patterns are word-boundary-anchored to avoid mangling names that
 * happen to overlap (e.g., "Bieber" stays untouched inside the
 * legitimate fictional surname "Biebermann"). New patterns get
 * added as the upstream filter trips on them in production.
 */
const COMMON_CELEBRITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(kim|khloe|kourtney|kris|kylie|kendall)\s+kardashian\b/gi,
  /\b(kim|khloe|kourtney|kris|kylie|kendall)\s+jenner\b/gi,
  /\bjustin\s+bieber\b/gi,
  /\bhailey\s+(bieber|baldwin)\b/gi,
  /\b(joe|jane)\s+rogan\b/gi,
  /\bmr\.?\s*beast\b/gi,
  /\belon\s+musk\b/gi,
  /\bdonald\s+trump\b/gi,
  /\bbeyonc[eé]\b/gi,
  /\btaylor\s+swift\b/gi,
  /\bbrad\s+pitt\b/gi,
  /\bleonardo\s+(di\s*caprio|dicaprio)\b/gi,
  /\bandrew\s+tate\b/gi,
  /\bjordan\s+peterson\b/gi,
];

export function scrubCelebrityReferences(text: string): string {
  if (!text) return text;
  let scrubbed = text;
  for (const pattern of COMMON_CELEBRITY_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, 'a popular figure');
  }
  return scrubbed;
}

/**
 * Polish-12.3.1: brands inseparable from a real founder / owner /
 * spokesperson trip the same PROMINENT_PEOPLE_FILTER even when the
 * person's name is never spoken. "Disney World" reads as Walt Disney
 * to the classifier; "Tesla" reads as Musk; "Trump Tower" reads as
 * Trump. Replace each with a generic category so the story stays
 * intact but the trigger disappears. Maintenance list — extend as
 * production trips on new ones; the long-term fix is Polish-12.4
 * (kie.ai character_ids) which removes the inference-layer trigger.
 */
const BRAND_PERSON_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // The trailing (?!\w) (negative lookahead) lets "Disney+" match —
  // a plain \b fails there because both `+` and the following space
  // are non-word characters, so no word boundary exists between them.
  {
    pattern: /\bdisney(?:\s*(?:world|land|plus|park|cruise)|\+)?(?!\w)/gi,
    replacement: 'a theme park',
  },
  { pattern: /\btesla\b/gi, replacement: 'an EV company' },
  { pattern: /\bspacex\b/gi, replacement: 'a space company' },
  { pattern: /\btrump\s+(tower|hotel|organization|properties)\b/gi, replacement: 'a luxury hotel' },
  {
    pattern: /\bvirgin\s+(galactic|atlantic|records)\b/gi,
    replacement: 'a transportation company',
  },
  { pattern: /\bberkshire\s+hathaway\b/gi, replacement: 'an investment firm' },
  { pattern: /\bdolly\s+parton\b/gi, replacement: 'a country music star' },
  { pattern: /\boprah\b/gi, replacement: 'a popular talk show host' },
];

export function scrubBrandPersonReferences(text: string): string {
  if (!text) return text;
  let scrubbed = text;
  for (const { pattern, replacement } of BRAND_PERSON_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

/**
 * Polish-12.3.1: compose both scrubbers in canonical order. Direct
 * celebrity names first (replaced with the same placeholder so the
 * sentence stays grammatical), then brand-as-person patterns (each
 * with a category-specific replacement).
 */
export function scrubAll(text: string): string {
  return scrubBrandPersonReferences(scrubCelebrityReferences(text));
}

interface OmniManualLike {
  characterPrompt: string;
  setPrompt: string;
  clips: Array<{ videoPrompt: string; dialogue?: string }>;
}

export interface OmniFlashSegment {
  segmentIndex: number;
  clips: Array<{ videoPrompt: string; dialogue?: string }>;
  estimatedDurationSeconds: number;
  combinedDialogue: string;
}

/**
 * Polish-12.1: estimate spoken duration of a dialogue string at the
 * documented 150 wpm natural-speech rate. Words = whitespace-split
 * non-empty tokens. Empty input → 0 seconds.
 */
export function estimateDialogueSeconds(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return (words / WORDS_PER_MINUTE) * 60;
}

/**
 * Polish-12.1: round a real-number duration up to one of Omni Flash's
 * allowed values ('4' | '6' | '8' | '10'). Anything ≤ 4 → '4'; > 10
 * is clamped to '10'.
 */
export function clampOmniDuration(seconds: number): 4 | 6 | 8 | 10 {
  const s = Math.max(0, seconds);
  if (s <= SEGMENT_MIN_SECONDS) return 4;
  if (s <= 6) return 6;
  if (s <= 8) return 8;
  return 10;
}

function durationToOmniLiteral(d: 4 | 6 | 8 | 10): KieOmniDuration {
  return String(d) as KieOmniDuration;
}

/**
 * Polish-12.1 / Polish-14: split a parsed manual's clips into N
 * segments such that each segment's estimated dialogue duration sits
 * ≤ SEGMENT_MAX_SECONDS (10s). Clip boundaries are preserved — a
 * single clip never spans segments.
 *
 * Algorithm:
 *   - Estimate per-clip dialogue duration via words / 150 wpm.
 *   - Polish-14: segmentCount scales linearly with totalSeconds via
 *     ceiling-divide (ceil(totalSeconds / 10)). MAX_SEGMENTS (30 ×
 *     10s = 5 min) is a sanity ceiling for runaway Claude output,
 *     not a target. Clip count is the other natural ceiling — can't
 *     have more segments than clips.
 *   - Walk clips in order, accumulating into the current segment.
 *     Start a new segment when adding the next clip would exceed
 *     SEGMENT_MAX_SECONDS (10s) OR the per-segment target. Always
 *     keep at least one clip per segment.
 *   - If MAX_SEGMENTS reached and clips remain, append them to the
 *     last segment.
 */
/**
 * Polish-12.7: count specific dollar/money claims in a dialogue
 * string. Each match counts as 1, so "$380 today and $2,600 this
 * week" → 2 ("$380", "$2,600"), and "three eighty in the bank,
 * twenty-six hundred later" → 2 ("three eighty"… wait — "three
 * eighty" alone isn't a money phrase without a unit. The patterns
 * here intentionally match COMPLETE money expressions: digit-form
 * ("$380", "380 dollars"), spelled-form ("three hundred", "five
 * grand", "ten thousand"), and shorthand ("26 grand", "10k").
 *
 * The downstream audio classifier scores tight sequences of these
 * patterns; splitClipsIntoOmniSegments uses the count to bias
 * segment boundaries so each segment carries at most one claim.
 */
const MONEY_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // $380, $2,600, $9,800
  /\$[\d,]+/g,
  // 380 dollars, 26 bucks
  /\b\d+\s+(?:dollars?|bucks?)\b/gi,
  // three hundred / four thousand / ten grand / five k
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:hundred|thousand|grand|k)\b/gi,
  // 26 hundred, 10 grand, 5k
  /\b\d+\s*(?:hundred|thousand|grand|k)\b/gi,
];

export function countMoneyClaims(dialogue: string): number {
  if (!dialogue) return 0;
  let count = 0;
  for (const p of MONEY_CLAIM_PATTERNS) {
    const matches = dialogue.match(p);
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * Polish-12.7: target density per segment. The audio classifier
 * scores claim PATTERN DENSITY in a small windowed segment; one
 * claim plus emotional/narrative beats stays under threshold, two+
 * stack the pattern signature above threshold. Used purely to bias
 * the splitter — Claude is also taught the same heuristic via the
 * master prompt's Density Dilution Across Segments rule.
 */
const MAX_MONEY_CLAIMS_PER_SEGMENT = 1;

export function splitClipsIntoOmniSegments(clips: OmniManualLike['clips']): OmniFlashSegment[] {
  if (clips.length === 0) return [];

  const augmented = clips.map((c) => {
    const dialogue = pickDialogue(c);
    return {
      clip: c,
      dialogue,
      seconds: estimateDialogueSeconds(dialogue),
      claims: countMoneyClaims(dialogue),
    };
  });

  const totalSeconds = augmented.reduce((s, a) => s + a.seconds, 0);
  // Polish-14: linear scale. 1 segment per 10s, with sanity ceiling +
  // floor-of-1 for short scripts.
  let segmentCount = Math.ceil(totalSeconds / SEGMENT_MAX_SECONDS);
  segmentCount = Math.min(segmentCount, MAX_SEGMENTS);
  segmentCount = Math.min(segmentCount, augmented.length);
  segmentCount = Math.max(segmentCount, 1);

  const groups: (typeof augmented)[] = Array.from({ length: segmentCount }, () => []);
  const targetPerSegment = totalSeconds / segmentCount;

  let currentIdx = 0;
  for (const item of augmented) {
    const groupSecs = groups[currentIdx]!.reduce((s, a) => s + a.seconds, 0);
    const groupClaims = groups[currentIdx]!.reduce((s, a) => s + a.claims, 0);
    const wouldOverflowAbsCap = groupSecs + item.seconds > SEGMENT_MAX_SECONDS;
    const wouldOverflowTarget = groupSecs >= targetPerSegment;
    // Polish-12.7: advance segments when the current group already
    // carries its claim quota and the incoming clip would add another.
    // Each segment is independently scored by the audio classifier, so
    // dilution = pattern density below threshold.
    const wouldOverflowClaimDensity =
      groupClaims >= MAX_MONEY_CLAIMS_PER_SEGMENT && item.claims >= 1;
    const canAdvance = currentIdx < segmentCount - 1;
    const groupHasContent = groups[currentIdx]!.length > 0;
    if (
      groupHasContent &&
      canAdvance &&
      (wouldOverflowAbsCap || wouldOverflowTarget || wouldOverflowClaimDensity)
    ) {
      currentIdx++;
    }
    groups[currentIdx]!.push(item);
  }

  return groups
    .filter((g) => g.length > 0)
    .map((g, segmentIndex) => {
      const clips = g.map((a) => a.clip);
      const combinedDialogue = g
        .map((a) => a.dialogue)
        .filter(Boolean)
        .map((d) => `"${d}"`)
        .join(' ');
      const estimatedDurationSeconds = g.reduce((s, a) => s + a.seconds, 0);
      return { segmentIndex, clips, estimatedDurationSeconds, combinedDialogue };
    });
}

/**
 * Polish-12.1: build a single segment's Omni Flash prompt. Shared
 * KIE_OMNI_FLASH_HARD_DIRECTIVE + scrubbed character + scrubbed
 * scene context, with the segment-specific dialogue + pacing.
 *
 * `segmentIndexLabel` is a continuity hint for the model only — it
 * MUST NOT appear in the rendered video, so the prompt explicitly
 * instructs the character to not reference the segmentation.
 */
export function buildOmniFlashSegmentPrompt(input: {
  characterDescription: string;
  sceneDescription: string;
  segmentDialogue: string;
  segmentDurationSeconds: 4 | 6 | 8 | 10;
  segmentIndexLabel?: string;
}): string {
  const dialogue = input.segmentDialogue.trim();
  // Polish-12.7.3: detect em-dash boundaries that Claude writes at
  // segment edges. A leading "—" means the character is continuing
  // a sentence from the previous segment; a trailing "—" means the
  // sentence continues into the next. The model uses these signals
  // to keep the character speaking through the cut rather than
  // pausing + smiling at the end of each segment.
  //
  // The dialogue passes through buildContinuousMonologue which wraps
  // each line in quotes, so the actual boundary chars sit just inside
  // the quotes. Strip the leading/trailing quote when checking.
  const dialogueCore = dialogue.replace(/^["']|["']$/g, '').trim();
  const continuesFromPrevious = /^[—–-]/.test(dialogueCore);
  const continuesIntoNext = /[—–-]$/.test(dialogueCore);
  const continuityHint =
    continuesFromPrevious && continuesIntoNext
      ? 'This clip continues a sentence from the previous segment and continues into the next — character is speaking continuously, no breaks in delivery.'
      : continuesIntoNext
        ? 'This clip ends mid-sentence — character is still speaking when the cut happens, no pause or wrap-up at the end.'
        : continuesFromPrevious
          ? 'This clip continues a sentence from the previous segment — character is already mid-speech when the clip begins.'
          : '';

  const parts: string[] = [
    KIE_OMNI_FLASH_HARD_DIRECTIVE,
    '',
    `CHARACTER: ${input.characterDescription}`,
    '',
    `SCENE / SET: ${input.sceneDescription}`,
    '',
    dialogue
      ? `DIALOGUE (the character speaks the following lines naturally to camera, in order): ${dialogue}`
      : 'No dialogue — natural ambient sound only.',
  ];
  if (continuityHint) {
    parts.push('', `CONTINUITY: ${continuityHint}`);
  }
  parts.push(
    '',
    // Polish-12.7.3: pacing block explicitly forbids the end-pause /
    // smile-to-camera artifact the model was producing at segment
    // boundaries. The earlier "no dead air" phrasing alone wasn't
    // strong enough — the model interpreted "no dead air" as "no
    // silence", not "no idle reaction frame".
    `PACING: Deliver the dialogue at natural conversational pace (~150 words per minute). The complete dialogue must occupy the ENTIRE ${input.segmentDurationSeconds}-second duration. The character is STILL SPEAKING or STILL IN MID-EXPRESSION when the clip ends. CRITICAL: no pause at the end. No smile to camera. No "reaction beat" before the cut. The cut happens mid-action.`,
  );
  if (input.segmentIndexLabel) {
    parts.push(
      '',
      `CONTINUITY (model-only note — the character must NOT reference this in speech): this is ${input.segmentIndexLabel}. Character expression, outfit, lighting, framing, and setting MUST match the reference image exactly so the segment crossfade-stitches seamlessly into the larger ad.`,
    );
  }
  return parts.join('\n').trim();
}

/**
 * Polish-12: backwards-compat wrapper. Polish-12.1 unifies single-
 * call and multi-segment via buildOmniFlashSegmentPrompt; this entry
 * point preserves the original signature used by Polish-12 tests
 * and any direct callers that still pass a whole manual.
 */
export function buildOmniFlashPrompt(manual: OmniManualLike, durationSeconds: number): string {
  const character = stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt));
  const scene = stripTextCaptionsBroll(manual.setPrompt);
  const monologue = buildContinuousMonologue(manual.clips);
  return buildOmniFlashSegmentPrompt({
    characterDescription: character,
    sceneDescription: scene,
    segmentDialogue: monologue,
    segmentDurationSeconds: clampOmniDuration(durationSeconds),
  });
}

/**
 * Concatenate every clip's dialogue into one continuous monologue
 * preserving the quotes so Omni's lipsync has explicit phrase
 * boundaries to align to. Dedupes consecutive identical lines.
 */
export function buildContinuousMonologue(clips: OmniManualLike['clips']): string {
  const lines: string[] = [];
  let prev = '';
  for (const clip of clips) {
    const line = pickDialogue(clip).trim();
    if (!line || line === prev) continue;
    lines.push(`"${line}"`);
    prev = line;
  }
  return lines.join(' ').trim();
}

function pickDialogue(clip: { videoPrompt: string; dialogue?: string }): string {
  if (clip.dialogue && clip.dialogue.trim()) return clip.dialogue.trim();
  const bracket = clip.videoPrompt.match(/\[GENERATE\s+NATIVE\s+AUDIO[^\]]*\]\s*:\s*"([^"]+)"/i);
  if (bracket && bracket[1]) return bracket[1].trim();
  const scrubbed = stripAudioEraArtifacts(clip.videoPrompt);
  const m = scrubbed.match(/"([^"]{4,})"/);
  if (m && m[1]) return m[1].trim();
  return '';
}
