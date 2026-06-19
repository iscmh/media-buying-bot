import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkReplicateConcat,
  getUniversalUgcMasterPrompt,
  isVideoConcatEnabled,
  pollKieOmniTask,
  submitKieOmniVideo,
  submitReplicateConcat,
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
]);

/**
 * Polish-12.2.2: defense-in-depth. The kie-omni client already infers
 * failCode from failMsg when kie.ai returns the code inverted (which
 * empirically happens for safety-filter failures). This second check
 * catches any case where the client's pattern miss left failCode
 * undefined but failMsg still carries the bare identifier — including
 * possible future kie.ai response shape drift.
 */
export function isRetryableOmniFailure(
  failCode: string | undefined | null,
  failMsg?: string | undefined | null,
): boolean {
  if (failCode && RETRYABLE_OMNI_FAIL_CODES.has(failCode)) return true;
  if (failMsg) {
    const trimmed = failMsg.trim();
    if (RETRYABLE_OMNI_FAIL_CODES.has(trimmed)) return true;
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

    // 1. Generate ONE shared character reference frame via Nano Banana.
    //    The same URL is reused across every segment so the character
    //    stays identical across the whole stitched ad.
    const referenceResult = await step.run('nano-banana-reference', async () => {
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
          variantIndex: 0,
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
      await markJobFailed(
        jobId,
        userId,
        referenceResult.error,
        totalCost + referenceResult.costUsd,
      );
      return { jobId, mode, generated: 0 };
    }
    totalCost += referenceResult.costUsd;
    const referenceImageUrl = referenceResult.publicUrl;

    // 2. Split clips into 1-3 segments capped at 10s each.
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

    // Polish-12.3: layered scrub before the prompt hits Omni Flash.
    // Master prompt now instructs Claude to avoid public figures up
    // front, but if a celebrity name slipped through (e.g., echoed
    // from the source creative's analysis), strip it here so Gemini's
    // PROMINENT_PEOPLE_FILTER doesn't trip on segment after segment.
    const scrubbedCharacter = scrubCelebrityReferences(
      stripTextCaptionsBroll(stripCharacterSheetPattern(manual.characterPrompt)),
    );
    const scrubbedScene = scrubCelebrityReferences(stripTextCaptionsBroll(manual.setPrompt));

    // 3. Generate each segment in parallel.
    const segmentResults = await Promise.all(
      segments.map((segment) =>
        runOmniSegment({
          step,
          segment: {
            ...segment,
            combinedDialogue: scrubCelebrityReferences(segment.combinedDialogue),
          },
          totalSegments: segments.length,
          referenceImageUrl,
          characterDescription: scrubbedCharacter,
          sceneDescription: scrubbedScene,
          userId,
          jobId,
        }),
      ),
    );

    const failures = segmentResults.filter((r) => !r.ok);
    if (failures.length > 0) {
      const msg = failures.map((f) => `segment ${f.segmentIndex}: ${f.error}`).join('; ');
      console.log(`[kie-omni] segment failure(s): ${msg}`);
      // Tally any costs that did land (segment Omni cost charged on
      // success only; nothing partial here).
      for (const r of segmentResults) totalCost += r.costUsd;
      await markJobFailed(jobId, userId, `Omni segment(s) failed: ${msg}`, totalCost);
      return { jobId, mode, generated: 0 };
    }

    // Narrow to successes — TS doesn't propagate the .length>0 guard
    // through the discriminated union, but at this point every entry
    // is a SegmentSuccess.
    const successes = segmentResults.filter((r): r is SegmentSuccess => r.ok);
    const segmentUrls = successes.map((r) => r.publicUrl);
    for (const r of successes) totalCost += r.costUsd;

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
          character_prompt: manual.characterPrompt,
          set_prompt: manual.setPrompt,
          resolution: KIE_OMNI_RESOLUTION,
          // Polish-12.2: tally retry attempts across segments. Useful
          // for QA: high totals on a single user indicate prompt
          // content triggering Gemini filters frequently.
          total_attempts: successes.reduce((s, x) => s + x.attempts, 0),
          attempts_by_segment: successes.map((x) => x.attempts),
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

export async function runOmniSegment(input: {
  step: InngestStepLike;
  segment: OmniFlashSegment;
  totalSegments: number;
  referenceImageUrl: string;
  characterDescription: string;
  sceneDescription: string;
  userId: string;
  jobId: string;
}): Promise<SegmentResult> {
  const { step, segment, totalSegments, referenceImageUrl, userId, jobId } = input;
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
  };
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
export function splitClipsIntoOmniSegments(clips: OmniManualLike['clips']): OmniFlashSegment[] {
  if (clips.length === 0) return [];

  const augmented = clips.map((c) => {
    const dialogue = pickDialogue(c);
    return {
      clip: c,
      dialogue,
      seconds: estimateDialogueSeconds(dialogue),
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
    const wouldOverflowAbsCap = groupSecs + item.seconds > SEGMENT_MAX_SECONDS;
    const wouldOverflowTarget = groupSecs >= targetPerSegment;
    const canAdvance = currentIdx < segmentCount - 1;
    const groupHasContent = groups[currentIdx]!.length > 0;
    if (groupHasContent && canAdvance && (wouldOverflowAbsCap || wouldOverflowTarget)) {
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
  const parts = [
    KIE_OMNI_FLASH_HARD_DIRECTIVE,
    '',
    `CHARACTER: ${input.characterDescription}`,
    '',
    `SCENE / SET: ${input.sceneDescription}`,
    '',
    dialogue
      ? `DIALOGUE (the character speaks the following lines naturally to camera, in order): ${dialogue}`
      : 'No dialogue — natural ambient sound only.',
    '',
    `PACING: Deliver the dialogue at natural conversational pace (~150 words per minute). The complete dialogue must fit in the ${input.segmentDurationSeconds}-second duration with no dead air at start or end and no long dramatic pauses.`,
  ];
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
