import { eq } from 'drizzle-orm';
import {
  VEO_MAX_SECONDS_PER_CALL,
  callClaude,
  checkReplicateConcat,
  clampVeoDurationSeconds,
  estimateVeoCostUsd,
  isVideoConcatEnabled,
  pollVeoOperation,
  submitReplicateConcat,
  submitVeoVideo,
} from '@mbb/ai-providers';
import { computeAutoVeoSegmentCount, computeVeoSegmentCount } from '@mbb/shared';
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
/**
 * Polish-19.3.1: auto-resolve the variant's segment count from the
 * source video's duration. Fallback chain (first hit wins):
 *
 *   1. job.metadata.analysis.video_duration_seconds — what
 *      analyze-concept's Gemini Vision step captured. Future-
 *      proofing: vision doesn't currently emit this field, but the
 *      Polish-19.3.1 store-analysis merge writes the vision payload
 *      under `metadata.analysis.*` so when vision adds the field
 *      this path lights up without a worker change.
 *   2. job.metadata.source_duration_seconds — the legacy Polish-14.1
 *      path. Action handler writes this when the form provides a
 *      length picker value (Advanced form, or the old simplified
 *      form before Polish-19.3.1 removed the picker).
 *   3. Default → 30s (4 segments) per computeAutoVeoSegmentCount's
 *      "missing source" branch. Sensible UGC default.
 *
 * Returns the chosen total duration (segments × 8s) + the resolved
 * segment count + the source we hit. Source label is logged so
 * operators can see which path fired per variant.
 */
export function resolveAutoVeoDuration(jobMetadata: Record<string, unknown> | null): {
  segmentCount: number;
  durationSeconds: number;
  source: 'analysis' | 'form' | 'default';
  sourceDurationSeconds: number | null;
} {
  if (jobMetadata) {
    const analysis = jobMetadata['analysis'];
    if (analysis && typeof analysis === 'object') {
      const a = analysis as Record<string, unknown>;
      const visionDuration = a['video_duration_seconds'];
      if (typeof visionDuration === 'number' && visionDuration > 0) {
        const segmentCount = computeAutoVeoSegmentCount(visionDuration);
        return {
          segmentCount,
          durationSeconds: segmentCount * VEO_MAX_SECONDS_PER_CALL,
          source: 'analysis',
          sourceDurationSeconds: visionDuration,
        };
      }
    }
    const formPersisted = jobMetadata['source_duration_seconds'];
    if (typeof formPersisted === 'number' && formPersisted > 0) {
      const segmentCount = computeAutoVeoSegmentCount(formPersisted);
      return {
        segmentCount,
        durationSeconds: segmentCount * VEO_MAX_SECONDS_PER_CALL,
        source: 'form',
        sourceDurationSeconds: formPersisted,
      };
    }
  }
  const segmentCount = computeAutoVeoSegmentCount(null);
  return {
    segmentCount,
    durationSeconds: segmentCount * VEO_MAX_SECONDS_PER_CALL,
    source: 'default',
    sourceDurationSeconds: null,
  };
}

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

/**
 * Polish-19.3: Claude returns the full segments[] array for a variant
 * in ONE call. Each segment is a self-contained Veo prompt for an 8s
 * chunk; Polish-19.3 Commit 2 generates them in parallel + stitches.
 * Commit 1 (this file) reads segments[] but only runs segments[0] —
 * structural-only change, runtime behavior identical to Polish-19.2
 * for the 8s/1-segment case.
 */
export interface VeoAdSegment {
  /** 0-indexed position in the chain. */
  index: number;
  /** Self-contained Veo prompt for this 8s chunk. */
  prompt: string;
}

export interface VeoAdSpec {
  segments: VeoAdSegment[];
}

/**
 * Polish-19.3: pure parser for the Claude segments[] response.
 * Tolerant to bare JSON, fenced ```json blocks, prose-wrapped JSON
 * (same shape as parseStructuredCharacter from Polish-19.0.7). Returns
 * null on shape mismatch — caller falls back to plain-text mode.
 */
export function parseVeoAdSpec(raw: string | unknown): VeoAdSpec | null {
  if (typeof raw !== 'string') {
    return validateVeoAdSpec(raw);
  }
  let candidate = raw.trim();
  const fenceMatch = candidate.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch && fenceMatch[1]) {
    candidate = fenceMatch[1].trim();
  }
  try {
    return validateVeoAdSpec(JSON.parse(candidate));
  } catch {
    /* fall through */
  }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return validateVeoAdSpec(JSON.parse(candidate.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

function validateVeoAdSpec(value: unknown): VeoAdSpec | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.segments) || v.segments.length === 0) return null;
  const segments: VeoAdSegment[] = [];
  for (let i = 0; i < v.segments.length; i++) {
    const s = v.segments[i] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') return null;
    if (typeof s.prompt !== 'string' || s.prompt.length === 0) return null;
    // Accept either numeric index or default to array position.
    const idx = typeof s.index === 'number' && Number.isFinite(s.index) ? s.index : i;
    segments.push({ index: idx, prompt: s.prompt });
  }
  return { segments };
}

/**
 * Polish-19.3: synthetic single-segment fallback used when Claude
 * returns plain text (e.g. ignored the JSON instruction) or the
 * parser fails. Wraps the raw text as segments[0].prompt so the
 * downstream worker path stays identical regardless of whether
 * Claude honored the schema. Polish-19.3 Commit 1 only uses
 * segments[0], so the fallback degrades gracefully even for 30s/60s
 * picks — operator sees an 8s output (acknowledged temporary state
 * until Commit 2 wires the parallel generation + stitch).
 */
export function fallbackToSingleSegment(rawText: string): VeoAdSpec {
  return { segments: [{ index: 0, prompt: rawText }] };
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
    // Polish-19.3.1: switch from resolveVeoTargetDuration (per-call
    // clamp, designed for the pre-19.3 single-segment path) to
    // resolveAutoVeoDuration (fallback chain → segments-per-variant).
    // The fallback-chain log line surfaces which source the duration
    // came from per job so the operator can SEE whether the form's
    // length picker, the Vision analysis, or the 30s default fired.
    const autoDuration = resolveAutoVeoDuration(
      (job.metadata ?? null) as Record<string, unknown> | null,
    );
    const durationSeconds = autoDuration.durationSeconds;
    console.log(
      `[veo-3-1-fast] job ${jobId}: auto-duration resolved → ${durationSeconds}s ` +
        `(${autoDuration.segmentCount} segment${autoDuration.segmentCount === 1 ? '' : 's'}) ` +
        `via ${autoDuration.source}` +
        (autoDuration.sourceDurationSeconds != null
          ? ` from source ${autoDuration.sourceDurationSeconds}s`
          : ' (no source duration available)'),
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

  // ---- Claude → segments[] ad spec ------------------------------
  // Polish-19.3: Claude now returns a structured segments[] array,
  // one entry per 8s chunk. For the 8s (single-segment) case the
  // array has one element and behavior is identical to Polish-19.2.
  // For multi-segment picks (15s/30s/60s) the array carries N entries
  // — Polish-19.3 Commit 1 still only consumes segments[0]; Commit 2
  // will fan out the parallel generation + concat stitch.
  const segmentCount = computeVeoSegmentCount(durationSeconds);
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
      `You write Veo 3.1 prompts for short UGC video ads. Output ONLY valid JSON ` +
      `matching the schema below — no markdown fences, no preamble, no trailing prose.\n\n` +
      `REQUIRED SCHEMA:\n` +
      `{\n` +
      `  "segments": [\n` +
      `    { "index": 0, "prompt": "Self-contained Veo prompt for the first 8s..." },\n` +
      `    { "index": 1, "prompt": "Continuation Veo prompt for the next 8s..." }\n` +
      `    // ... one entry per 8s segment\n` +
      `  ]\n` +
      `}\n\n` +
      `STRUCTURE PER segment.prompt:\n` +
      `1. Visual scene (who, where, lighting, framing — UGC iPhone selfie style, NOT studio, NOT cinematic).\n` +
      `2. Spoken dialogue in quotes.\n` +
      `3. Ambient sound cues.\n\n` +
      `HARD CONSTRAINTS (apply to every segment):\n` +
      `- Each segment covers exactly 8s of video; dialogue must FIT at natural pace (~150wpm = ~20 words).\n` +
      `- Single character, single scene, single camera angle — consistent across all segments.\n` +
      `- Photoreal amateur smartphone selfie aesthetic. NOT a 3D character, NOT animated, NOT CGI.\n` +
      `- Character is a fictional everyperson with no resemblance to any public figure.\n` +
      `- No on-screen text, no captions, no graphics, no watermarks.\n\n` +
      `MULTI-SEGMENT RULES (only when segments.length > 1):\n` +
      `- segments[0] hooks the viewer in the first second.\n` +
      `- Middle segments deepen the story / build the pitch.\n` +
      `- The FINAL segment ends with a clear call-to-action.\n` +
      `- Maintain character + setting continuity across segments (same person, same outfit, same room).\n\n` +
      `THIS REQUEST: return EXACTLY ${segmentCount} segment${segmentCount === 1 ? '' : 's'} ` +
      `for a ${durationSeconds}s ad.`;
    const userMessage = JSON.stringify({
      source_analysis: jobMetadata ?? {},
      target_duration_seconds: durationSeconds,
      target_segment_count: segmentCount,
      variant_index: variantIndex,
    });
    const claude = await callClaude({
      userId,
      apiKey: keys.claude!,
      systemPrompt,
      userMessage,
      maxTokens: 8192,
      generationJobId: jobId,
    });
    if (!claude.ok) {
      return {
        ok: false as const,
        error: claude.errorMessage ?? 'Claude ad-spec call failed',
        costUsd: claude.costUsd,
      };
    }
    const rawText = (claude.text ?? '').trim();
    if (!rawText) {
      return {
        ok: false as const,
        error: 'Claude returned an empty ad spec',
        costUsd: claude.costUsd,
      };
    }
    // Try the structured path first; degrade to single-segment
    // plain-text wrap if Claude ignored the JSON instruction.
    const parsed = parseVeoAdSpec(rawText);
    if (parsed) {
      return { ok: true as const, adSpec: parsed, costUsd: claude.costUsd };
    }
    console.log(
      `[veo-3-1-fast] variant ${variantIndex}: segments[] JSON failed to parse; ` +
        `falling back to single-segment wrap. Claude returned: ${rawText.slice(0, 500)}`,
    );
    return {
      ok: true as const,
      adSpec: fallbackToSingleSegment(rawText),
      costUsd: claude.costUsd,
    };
  });
  cost += adSpecResult.costUsd;
  if (!adSpecResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: adSpecResult.error };
  }
  const adSpec = adSpecResult.adSpec;
  // Polish-19.3 Commit 2: fan out all segments[] in parallel via
  // Promise.all, then stitch with the Polish-9.12 Replicate ffmpeg-
  // concat helper. For single-segment (8s) the worker still does
  // one submit → poll → upload chain and writes a composite row
  // identical to Polish-19.2's output (no stitch step, no per-
  // segment rows). For N>1 the worker writes per-segment rows
  // (isClipPart: true, format='..._segment') AND a composite row
  // (isClipPart: false, format='veo_3_1_fast_native_audio'). The
  // /runs/[id] grid filters on isClipPart to show one card per
  // variant by default; ops can inspect per-segment by drilling in.

  console.log(
    `[veo-3-1-fast] variant ${variantIndex}: fanning out ${adSpec.segments.length} segment(s) ` +
      `for ${durationSeconds}s ad. ${
        adSpec.segments.length > 1 ? 'Will stitch via Replicate ffmpeg-concat after all land.' : ''
      }`,
  );

  // Multi-segment guard: if N>1, stitching is required. If the
  // operator hasn't set REPLICATE_VIDEO_CONCAT_MODEL_ID, fail
  // upfront with a clear message rather than burning Veo cost on
  // segments we'll have no way to stitch.
  if (adSpec.segments.length > 1 && !isVideoConcatEnabled()) {
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        `Polish-19.3 multi-segment Veo requires REPLICATE_VIDEO_CONCAT_MODEL_ID env to be set ` +
        `(Replicate ffmpeg-concat model slug). 8s/single-segment Veo works without it; ` +
        `15s/30s/60s presets need the env. Set on Vercel + redeploy, or pick 8s preset.`,
    };
  }

  // ---- Generate each segment in parallel -----------------------
  const segmentResults = await Promise.all(
    adSpec.segments.map((seg: VeoAdSegment) =>
      runOneSegment({
        step,
        jobId,
        userId,
        variantIndex,
        segmentIndex: seg.index,
        segmentPrompt: seg.prompt,
      }),
    ),
  );
  // Sum per-segment cost regardless of pass/fail (Veo charges on
  // submit-to-success and we conservatively bill).
  for (const s of segmentResults) cost += s.costUsd;

  const allOk = segmentResults.every((s) => s.ok);
  if (!allOk) {
    // Persist per-segment rows for the successes + record the
    // first failure on the variant. Operator gets the partial
    // success URLs + a clear failure message for the broken one(s).
    const firstFailure = segmentResults.find((s) => !s.ok);
    console.log(
      `[veo-3-1-fast] variant ${variantIndex}: ${
        segmentResults.filter((s) => s.ok).length
      }/${segmentResults.length} segments succeeded; aborting before stitch. ` +
        `First failure: ${firstFailure?.error ?? 'unknown'}`,
    );
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error: `Segment ${firstFailure?.segmentIndex ?? '?'} failed: ${firstFailure?.error ?? 'unknown'}`,
    };
  }

  // All segments good — collect the URLs in segment-index order.
  const successSegments = [...segmentResults]
    .filter((s): s is SegmentSuccess => s.ok)
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
  const segmentUrls = successSegments.map((s) => s.publicUrl);

  // ---- Stitch when N > 1 ---------------------------------------
  let compositeUrl = segmentUrls[0]!;
  let stitched = false;
  if (successSegments.length > 1) {
    const stitchResult = await runVeoStitch({
      step,
      segmentUrls,
      userId,
      jobId,
      variantIndex,
    });
    cost += stitchResult.costUsd;
    if (!stitchResult.ok) {
      return {
        index: variantIndex,
        ok: false,
        costUsd: cost,
        error: `Stitch failed: ${stitchResult.error}`,
      };
    }
    compositeUrl = stitchResult.publicUrl;
    stitched = true;
  }

  // ---- Persist per-segment rows (when N > 1) + composite row ---
  if (successSegments.length > 1) {
    await step.run(`insert-segment-rows-${variantIndex}`, async () => {
      const db = getDb();
      const rows = successSegments.map((s) => ({
        userId,
        generationJobId: jobId,
        fileUrl: s.publicUrl,
        aspectRatio: '9:16' as const,
        status: 'ready_for_review' as const,
        format: 'veo_3_1_fast_native_audio_segment',
        clipIndex: s.segmentIndex,
        isClipPart: true,
        generationMetadata: {
          variant_index: variantIndex,
          segment_index: s.segmentIndex,
          veo_operation_name: s.veoOperationName,
          duration_seconds: VEO_MAX_SECONDS_PER_CALL,
          prompt_chars: s.promptChars,
        },
      }));
      await db.insert(schema.generatedCreatives).values(rows);
    });
  }
  await step.run(`insert-composite-${variantIndex}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: compositeUrl,
      aspectRatio: '9:16',
      status: 'ready_for_review',
      format: 'veo_3_1_fast_native_audio',
      isClipPart: false,
      generationMetadata: {
        variant_index: variantIndex,
        duration_seconds: successSegments.length * VEO_MAX_SECONDS_PER_CALL,
        segment_count_requested: segmentCount,
        segment_count_generated: successSegments.length,
        segment_urls: segmentUrls,
        veo_operation_names: successSegments.map((s) => s.veoOperationName),
        segments: adSpec.segments,
        stitched,
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: compositeUrl };
}

// =========================================================================
// Polish-19.3 Commit 2: per-segment runner + stitch helper
// =========================================================================

interface SegmentSuccess {
  ok: true;
  segmentIndex: number;
  videoUri: string;
  publicUrl: string;
  veoOperationName: string;
  promptChars: number;
  costUsd: number;
}
interface SegmentFailure {
  ok: false;
  segmentIndex: number;
  error: string;
  costUsd: number;
  veoOperationName?: string;
}
type SegmentResult = SegmentSuccess | SegmentFailure;

/**
 * Polish-19.3 Commit 2: one 8s Veo segment — submit → poll → download.
 * Identical step structure to the pre-19.3 single-segment runner but
 * step names suffixed with `-${segmentIndex}` so all N parallel
 * segments live cleanly in Inngest's durable execution tree.
 *
 * Veo charges on submit-to-success, so the cost is added either way
 * (poll-timeout-but-Veo-finished case is the same gap we documented
 * in Polish-19.0.5 for Kling — recoverable via the persisted
 * veo_operation_name on the failed segment row).
 */
async function runOneSegment(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  segmentIndex: number;
  segmentPrompt: string;
}): Promise<SegmentResult> {
  const { step, jobId, userId, variantIndex, segmentIndex, segmentPrompt } = input;
  const segLabel = `${variantIndex}-${segmentIndex}`;
  let cost = 0;

  const submitResult = await step.run(`veo-submit-${segLabel}`, async () => {
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
      prompt: segmentPrompt,
      durationSeconds: VEO_MAX_SECONDS_PER_CALL,
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
    return { ok: false, segmentIndex, costUsd: cost, error: submitResult.error };
  }

  await step.sleep(`veo-warmup-${segLabel}`, `${POLL_WARMUP_SECONDS}s`);
  let videoUri: string | undefined;
  let pollError: string | undefined;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await step.run(`veo-poll-${segLabel}-${attempt}`, async () => {
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
      `veo-wait-${segLabel}-${attempt}`,
      `${computeVeoPollIntervalSeconds(attempt)}s`,
    );
  }

  cost += estimateVeoCostUsd(VEO_MAX_SECONDS_PER_CALL);

  if (!videoUri) {
    console.log(
      `[veo-3-1-fast] segment ${segLabel} timed out / failed after ${POLL_MAX_ATTEMPTS} polls. ` +
        `operation=${submitResult.operationName} last_error=${pollError ?? 'unset'}`,
    );
    return {
      ok: false,
      segmentIndex,
      costUsd: cost,
      veoOperationName: submitResult.operationName,
      error:
        `Veo operation ${submitResult.operationName} (segment ${segmentIndex}) did not reach ` +
        `terminal state within ${POLL_MAX_ATTEMPTS} polls. ` +
        (pollError ? `Last error: ${pollError}` : ''),
    };
  }

  const uploadResult = await step.run(`upload-video-${segLabel}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        throw new Error(
          `Cannot download Veo segment ${segLabel} output: ${err.message}. ` +
            `Gemini key required for the private Files API URI.`,
        );
      throw err;
    }
    return uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: videoUri!,
      filename: `veo-${variantIndex}-seg-${segmentIndex}`,
      fetchHeaders: buildVeoDownloadHeaders(videoUri!, keys.gemini!),
    });
  });

  return {
    ok: true,
    segmentIndex,
    videoUri,
    publicUrl: uploadResult.publicUrl,
    veoOperationName: submitResult.operationName,
    promptChars: segmentPrompt.length,
    costUsd: cost,
  };
}

const STITCH_POLL_INTERVAL_SECONDS = 8;
const STITCH_POLL_MAX_ATTEMPTS = 45; // ~6 min ceiling

/**
 * Polish-19.3 Commit 2: clone of generate-kie-omni-flash-native's
 * runOmniStitch — submit Replicate ffmpeg-concat, poll until ready,
 * re-upload the stitched mp4 to Supabase Storage for a durable URL.
 *
 * Uses the existing `kling` BYOK key (load-keys.ts has the Polish-9.3
 * fallback that resolves `kling` from a `replicate` connection row
 * too, so either key works). REPLICATE_VIDEO_CONCAT_MODEL_ID must be
 * set for this to fire — the caller checked isVideoConcatEnabled()
 * upstream before any Veo cost was burned on multi-segment.
 */
async function runVeoStitch(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  segmentUrls: string[];
  userId: string;
  jobId: string;
  variantIndex: number;
}): Promise<
  { ok: true; publicUrl: string; costUsd: number } | { ok: false; error: string; costUsd: number }
> {
  const { step, segmentUrls, userId, jobId, variantIndex } = input;

  const submit = await step.run(`veo-stitch-submit-${variantIndex}`, async () => {
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
          : 'stitch submit failed';
    return { ok: false, costUsd: 0, error: err ?? 'stitch submit failed' };
  }
  const predictionId = submit.predictionId;

  let stitchedUrl: string | undefined;
  let stitchCost = 0;
  let stitchError: string | undefined;
  for (let attempt = 0; attempt < STITCH_POLL_MAX_ATTEMPTS; attempt++) {
    await step.sleep(
      `veo-stitch-wait-${variantIndex}-${attempt}`,
      `${STITCH_POLL_INTERVAL_SECONDS}s`,
    );
    const tick = await step.run(`veo-stitch-poll-${variantIndex}-${attempt}`, async () => {
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
      stitchError = tick.errorMessage ?? 'stitch failed';
      break;
    }
  }
  if (!stitchedUrl) {
    return {
      ok: false,
      costUsd: stitchCost,
      error: stitchError ?? `Stitch timed out after ${STITCH_POLL_MAX_ATTEMPTS} polls`,
    };
  }

  const upload = await step.run(`veo-stitch-upload-${variantIndex}`, async () => {
    try {
      const u = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: stitchedUrl!,
        filename: `veo-${variantIndex}-composite`,
      });
      return { ok: true as const, publicUrl: u.publicUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });
  // If the stitched-output re-upload fails, fall back to the
  // Replicate-delivery URL — it works for at least 24h while the
  // operator investigates.
  const publicUrl = upload.ok ? upload.publicUrl : stitchedUrl;
  return { ok: true, publicUrl, costUsd: stitchCost };
}
