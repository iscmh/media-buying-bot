import { eq } from 'drizzle-orm';
import {
  VEO_EXTEND_SECONDS_PER_CALL,
  VEO_MAX_SECONDS_PER_CALL,
  callClaude,
  checkReplicateConcat,
  clampVeoDurationSeconds,
  estimateVeoCostUsd,
  isVideoConcatEnabled,
  pollVeoOperation,
  submitReplicateConcat,
  submitVeoExtend,
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
 * Polish-19.4: Veo chain mode. 'extend' (the new default) uses
 * Google's native Extend endpoint — base 8s + N-1 × 7s extends, with
 * the final operation's video output BEING the cumulative composite
 * (no ffmpeg-concat step needed). 'concat' is the Polish-19.3
 * parallel-N×8s + Replicate-stitch path, kept live behind this env
 * var so an operator can flip back if Extend drift surfaces.
 *
 * Reads VEO_CHAINING_MODE env. Anything other than the literal
 * string 'concat' resolves to 'extend' (defaults-safe).
 */
export type VeoChainingMode = 'extend' | 'concat';

export function getVeoChainingMode(): VeoChainingMode {
  const raw = process.env.VEO_CHAINING_MODE?.trim().toLowerCase();
  return raw === 'concat' ? 'concat' : 'extend';
}

/**
 * Polish-19.4.3: milliseconds to step.sleep between sequential
 * extend calls in a chain. Default 2500ms — short enough that a
 * 30s ad chain adds ~7.5s wall-clock, long enough to stay well
 * under Veo's 50 RPM baseline (1200ms would be the theoretical
 * floor; 2500ms gives headroom for other users on the same
 * project).
 *
 * Set to '0' to disable the pause entirely (regression path if a
 * future Veo tier removes rate limits or the retry loop proves
 * enough on its own).
 */
export const VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT = 2500;

export function getVeoExtendInterCallDelayMs(): number {
  const raw = process.env.VEO_EXTEND_INTER_CALL_DELAY_MS?.trim();
  if (!raw) return VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.log(
      `[veo-3-1-fast] ignoring VEO_EXTEND_INTER_CALL_DELAY_MS=${JSON.stringify(raw)} — ` +
        `not a non-negative number; falling back to default (${VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT}ms).`,
    );
    return VEO_EXTEND_INTER_CALL_DELAY_MS_DEFAULT;
  }
  return Math.floor(n);
}

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
  /**
   * Self-contained Veo prompt for this chunk (8s for segment 0, 7s
   * for extend segments). Includes visual scene, dialogue in quotes
   * with speaker attribution, and (Polish-19.4.2) an acoustic
   * texture line woven into the prose.
   */
  prompt: string;
  /**
   * Polish-19.4.2: structured acoustic texture description Claude
   * emits alongside the prompt (also woven INTO the prompt). Kept
   * as a separate field so tests can inspect what Claude produced
   * per segment without re-parsing the prompt string. Optional —
   * parser stays tolerant so pre-19.4.2 cached specs still validate.
   */
  sound_texture?: string;
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
    // Polish-19.4.2: carry sound_texture through when present. Not
    // required — pre-19.4.2 cached responses lack the field and must
    // still validate. Empty string treated as absent.
    const soundTexture =
      typeof s.sound_texture === 'string' && s.sound_texture.length > 0
        ? s.sound_texture
        : undefined;
    segments.push({
      index: idx,
      prompt: s.prompt,
      ...(soundTexture !== undefined ? { sound_texture: soundTexture } : {}),
    });
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

/**
 * Polish-19.4.2: extract the source ad's script transcription from
 * jobMetadata so runClaudeAdSpec can lift it into a top-level
 * user-message field. The Gemini Vision analyze-concept step writes
 * this under `metadata.analysis.script_transcription` per the shared
 * Sora prompt schema (packages/shared/src/prompts/index.ts:100).
 *
 * Returns "" if the transcription is missing / not a string / empty
 * — Claude's system prompt tolerates the empty case (falls back to
 * generating from source_analysis + own creative judgment) so a
 * concept with no vision-detected script still works.
 */
export function extractSourceScriptVerbatim(jobMetadata: Record<string, unknown> | null): string {
  if (!jobMetadata) return '';
  const analysis = jobMetadata['analysis'];
  if (!analysis || typeof analysis !== 'object') return '';
  const t = (analysis as Record<string, unknown>)['script_transcription'];
  return typeof t === 'string' ? t : '';
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
  // Polish-19.4: dispatch on chain mode. 'extend' (new default) chains
  // via Veo's native Extend endpoint; 'concat' is the Polish-19.3
  // parallel + Replicate-ffmpeg-concat path, retained as a manual
  // fallback. Mode is logged once per variant so the operator can
  // SEE which path fired in Inngest.
  const mode = getVeoChainingMode();
  console.log(
    `[veo-3-1-fast] variant ${input.variantIndex}: chaining mode = ${mode} (env VEO_CHAINING_MODE)`,
  );
  if (mode === 'extend') {
    return runOneVariantExtend(input);
  }
  return runOneVariantConcat(input);
}

async function runOneVariantConcat(input: RunOneVariantInput): Promise<VeoVariantResult> {
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
// Polish-19.4: extend-chain variant runner
// =========================================================================
//
// Sequential chain of N Veo calls — segment 0 via submitVeoVideo
// (forced to 8s + 720p so the chain's 720p constraint matches), then
// segments 1..N-1 via submitVeoExtend, each feeding the previous
// operation's Files API videoUri into the next call's `previousVideo`.
// The FINAL operation's output IS the cumulative composite — no
// concat step needed. Persists ONE composite row per variant (no
// per-segment rows since each extend's output is the cumulative
// video, not a 7s chunk).

async function runOneVariantExtend(input: RunOneVariantInput): Promise<VeoVariantResult> {
  const { step, jobId, userId, variantIndex, durationSeconds, jobMetadata } = input;
  let cost = 0;

  // Same Claude ad-spec call as the concat path. Segment count math
  // here mirrors the cost-estimator's computeVeoExtendCalls so the
  // worker spends what the form quoted.
  const segmentCount = computeVeoSegmentCount(durationSeconds); // structural cap reuse — extend chain bills per call below
  const adSpecResult = await step.run(`claude-ad-spec-extend-${variantIndex}`, async () =>
    runClaudeAdSpec({
      userId,
      jobId,
      variantIndex,
      jobMetadata,
      segmentCount,
      durationSeconds,
    }),
  );
  cost += adSpecResult.costUsd;
  if (!adSpecResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: adSpecResult.error };
  }
  const adSpec = adSpecResult.adSpec;

  console.log(
    `[veo-3-1-fast] variant ${variantIndex}: extend chain — base (8s, 720p) + ${Math.max(
      0,
      adSpec.segments.length - 1,
    )} extends (7s each, 720p). Final segment's output is the composite.`,
  );

  // ---- Base segment (segments[0]) — submitVeoVideo with 8s + 720p ----
  const base = await runVeoBaseForChain({
    step,
    jobId,
    userId,
    variantIndex,
    prompt: adSpec.segments[0]!.prompt,
  });
  cost += base.costUsd;
  if (!base.ok) {
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error: `Extend chain base segment failed: ${base.error}`,
    };
  }

  // ---- Extend each subsequent segment, chaining the previous URI ----
  let chainVideoUri = base.videoUri;
  let chainOperationName = base.veoOperationName;
  const operationNames: string[] = [base.veoOperationName];
  // Polish-19.4.3: inter-call delay between extends. Sequential
  // chain fires calls back-to-back which can trip Veo's 50 RPM
  // baseline under load — a short breather in between reduces
  // the odds of the retry loop having to kick in. Env-tunable
  // via VEO_EXTEND_INTER_CALL_DELAY_MS (default 2500ms).
  const interCallDelayMs = getVeoExtendInterCallDelayMs();
  for (let segIdx = 1; segIdx < adSpec.segments.length; segIdx++) {
    if (interCallDelayMs > 0) {
      await step.sleep(`veo-extend-pause-${variantIndex}-${segIdx}`, `${interCallDelayMs}ms`);
    }
    const seg = adSpec.segments[segIdx]!;
    const ext = await runVeoExtendSegment({
      step,
      jobId,
      userId,
      variantIndex,
      segmentIndex: segIdx,
      previousVideoUri: chainVideoUri,
      prompt: seg.prompt,
    });
    cost += ext.costUsd;
    if (!ext.ok) {
      return {
        index: variantIndex,
        ok: false,
        costUsd: cost,
        error: `Extend segment ${segIdx} failed: ${ext.error}`,
      };
    }
    chainVideoUri = ext.videoUri;
    chainOperationName = ext.veoOperationName;
    operationNames.push(ext.veoOperationName);
  }

  // ---- Upload the FINAL chain video as the composite ----
  // The final operation's output is already the cumulative composite
  // (input video + 7s extension = one continuous mp4 per Google's
  // Extend contract). No concat step.
  const uploadResult = await step.run(`veo-extend-upload-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        throw new Error(
          `Cannot download Veo extend composite for variant ${variantIndex}: ${err.message}. ` +
            `Gemini key required for the private Files API URI.`,
        );
      throw err;
    }
    return uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: chainVideoUri,
      filename: `veo-${variantIndex}-composite-extend`,
      fetchHeaders: buildVeoDownloadHeaders(chainVideoUri, keys.gemini!),
    });
  });

  await step.run(`insert-composite-extend-${variantIndex}`, async () => {
    const db = getDb();
    // Output duration = 8 (base) + 7 × (N-1) (extends).
    const outputDurationSeconds =
      VEO_MAX_SECONDS_PER_CALL +
      VEO_EXTEND_SECONDS_PER_CALL * Math.max(0, adSpec.segments.length - 1);
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
        chaining_mode: 'extend',
        duration_seconds: outputDurationSeconds,
        segment_count_requested: segmentCount,
        segment_count_generated: adSpec.segments.length,
        veo_operation_names: operationNames,
        final_video_uri: chainVideoUri,
        final_operation_name: chainOperationName,
        segments: adSpec.segments,
        resolution: '720p',
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: uploadResult.publicUrl };
}

/**
 * Polish-19.4: factored Claude ad-spec call. Both concat and extend
 * modes use the SAME prompt + parsing — only the post-Claude
 * generation path differs. Factored to keep the two modes pinned to
 * the same script schema (a drift would land mode-specific bugs).
 */
async function runClaudeAdSpec(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  jobMetadata: Record<string, unknown> | null;
  segmentCount: number;
  durationSeconds: number;
}): Promise<
  { ok: true; adSpec: VeoAdSpec; costUsd: number } | { ok: false; error: string; costUsd: number }
> {
  const { userId, jobId, variantIndex, jobMetadata, segmentCount, durationSeconds } = input;
  let keys;
  try {
    keys = await loadDecryptedKeys(userId, ['claude']);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }
  // Polish-19.4.2: lift the source ad's script transcription out of
  // the general metadata blob and into a top-level user-message
  // field so Claude sees the exact winning words next to the
  // "preserve hooks + key phrases" directive. Everything else in
  // jobMetadata still flows through under source_analysis for the
  // vision cues (framing, background, subject appearance).
  const sourceScriptVerbatim = extractSourceScriptVerbatim(jobMetadata);

  const systemPrompt =
    `You write Veo 3.1 prompts for short UGC video ads. Output ONLY valid JSON ` +
    `matching the schema below — no markdown fences, no preamble, no trailing prose.\n\n` +
    `REQUIRED SCHEMA:\n` +
    `{\n` +
    `  "segments": [\n` +
    `    {\n` +
    `      "index": 0,\n` +
    `      "prompt": "Self-contained Veo prompt for the first 8s — visual scene + speaker attribution + dialogue in quotes + acoustic texture line",\n` +
    `      "sound_texture": "Close-mic iPhone front-camera compression, faint room tone, no music."\n` +
    `    },\n` +
    `    {\n` +
    `      "index": 1,\n` +
    `      "prompt": "Continuation Veo prompt for the next 7s ...",\n` +
    `      "sound_texture": "..."\n` +
    `    }\n` +
    `    // one entry per segment; segments[0] is 8s (Veo base), segments[1..] are 7s each (Veo extend)\n` +
    `  ]\n` +
    `}\n\n` +
    `STRUCTURE PER segment.prompt (in this order, one paragraph):\n` +
    `1. Visual scene (who: age-range, gender, ethnicity, outfit; where: room/setting; lighting; framing — UGC iPhone selfie hand-held, NOT studio, NOT cinematic).\n` +
    `2. Speaker attribution + spoken dialogue in quotes. Example templates: "She says: '...'" / "He confesses: '...'" / "She whispers: '...'" / "He half-laughs: '...'". Pick attribution that matches the emotional beat.\n` +
    `3. Acoustic texture line woven into the prose (repeat the sound_texture field's content inside the prompt — Veo reads audio cues from the prompt body, not from adjacent JSON fields).\n\n` +
    `WORD COUNT PER SEGMENT (HARD LIMITS — going over breaks the yapping pace and looks fake):\n` +
    `- Segment 0 (Veo base, 8s @ 720p): 22-28 words of dialogue max, natural yapping pace ~170wpm.\n` +
    `- Segments 1..N-1 (Veo extend, +7s each): 18-24 words each.\n` +
    `- Word count = spoken words inside the quotes ONLY (excludes speaker attribution + visual/sound description).\n\n` +
    `SOURCE-SCRIPT PRESERVATION (this is NOT verbatim quoting — this is preserving what MADE the source ad win while varying the wrapper):\n` +
    `- PRESERVE: hook openers ("I swear to god", "You will NOT believe"), dollar amounts, ALL CAPS emphasis words, filler words (like, honestly, literally), ellipses, natural stammers, key product/offer phrases from the source.\n` +
    `- ADAPT: character demographics, setting details, non-essential specifics for variant differentiation.\n` +
    `- WORKED EXAMPLE — source: "I swear to god, I was spending $80 a month on face serums that did NOTHING. Then my esthetician told me about this $12 drugstore toner..."\n` +
    `  CORRECT segment 0: "I swear to god, I've been buying these $80 face serums for months and they did NOTHING. Zero. Nada." (preserves "I swear to god" + "$80" + "NOTHING" + energy pattern, adapts specifics).\n` +
    `  WRONG segment 0: "I was spending $80 a month on face serums that did NOTHING." (just quoting a random chunk — loses hook variation across variants).\n\n` +
    `HARD CONSTRAINTS (apply to every segment):\n` +
    `- Single character, single scene, single camera angle — consistent across all segments.\n` +
    `- Photoreal amateur smartphone selfie aesthetic. NOT a 3D character, NOT animated, NOT CGI.\n` +
    `- Character is a fictional everyperson with no resemblance to any public figure.\n` +
    `- No on-screen text, no captions, no graphics, no watermarks, no subtitles.\n\n` +
    `MULTI-SEGMENT RULES (only when segments.length > 1):\n` +
    `- segments[0] hooks the viewer in the first second — use the source's opening hook, adapted.\n` +
    `- Middle segments deepen the story / build the pitch, using preserved key phrases from the source.\n` +
    `- The FINAL segment ends with a clear call-to-action.\n` +
    `- Maintain character + setting continuity across segments (same person, same outfit, same room, same lighting).\n\n` +
    `SOUND TEXTURE EXAMPLES (pick one that matches the visual scene; weave verbatim into the prompt AND emit in the sound_texture field):\n` +
    `- "Close-mic iPhone front-camera compression, faint room tone, no music."\n` +
    `- "Handheld iPhone audio, faint traffic outside, no music, slight bathroom tile echo."\n` +
    `- "Static tripod audio, air conditioner hum in background, no music."\n` +
    `- "Kitchen ambient (fridge hum, faint dish clatter), close-mic iPhone selfie audio, no music."\n\n` +
    `THIS REQUEST: return EXACTLY ${segmentCount} segment${segmentCount === 1 ? '' : 's'} ` +
    `for a ${durationSeconds}s ad. This variant is index ${variantIndex} — differentiate from other variants by adapting the character demographics and setting while preserving the source's hooks and key phrases.`;

  const userMessage = JSON.stringify({
    source_script_verbatim: sourceScriptVerbatim,
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
      ok: false,
      error: claude.errorMessage ?? 'Claude ad-spec call failed',
      costUsd: claude.costUsd,
    };
  }
  const rawText = (claude.text ?? '').trim();
  if (!rawText) {
    return { ok: false, error: 'Claude returned an empty ad spec', costUsd: claude.costUsd };
  }
  const parsed = parseVeoAdSpec(rawText);
  if (parsed) {
    return { ok: true, adSpec: parsed, costUsd: claude.costUsd };
  }
  console.log(
    `[veo-3-1-fast] variant ${variantIndex}: segments[] JSON failed to parse; ` +
      `falling back to single-segment wrap. Claude returned: ${rawText.slice(0, 500)}`,
  );
  return { ok: true, adSpec: fallbackToSingleSegment(rawText), costUsd: claude.costUsd };
}

/**
 * Polish-19.4: base segment for the extend chain. Forces 8s
 * duration + 720p resolution so the chain's 720p-only constraint
 * matches the source. Same submit → poll → return-videoUri pattern as
 * runOneSegment but does NOT upload (the cumulative video is uploaded
 * once at the end of the chain).
 */
async function runVeoBaseForChain(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  prompt: string;
}): Promise<
  | { ok: true; videoUri: string; veoOperationName: string; costUsd: number }
  | { ok: false; error: string; costUsd: number }
> {
  const { step, jobId, userId, variantIndex, prompt } = input;
  const segLabel = `${variantIndex}-base`;

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
      prompt,
      durationSeconds: VEO_MAX_SECONDS_PER_CALL, // base call is exactly 8s
      aspectRatio: '9:16',
      resolution: '720p', // required for the Extend chain
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.operationName) {
      return {
        ok: false as const,
        error: submit.errorMessage ?? 'Veo base predictLongRunning failed',
      };
    }
    return { ok: true as const, operationName: submit.operationName };
  });
  if (!submitResult.ok) {
    return { ok: false, error: submitResult.error, costUsd: 0 };
  }

  const poll = await pollVeoUntilDone({
    step,
    jobId,
    userId,
    operationName: submitResult.operationName,
    label: segLabel,
  });
  const cost = estimateVeoCostUsd(VEO_MAX_SECONDS_PER_CALL);
  if (!poll.ok) {
    return { ok: false, costUsd: cost, error: poll.error };
  }
  return {
    ok: true,
    videoUri: poll.videoUri,
    veoOperationName: submitResult.operationName,
    costUsd: cost,
  };
}

/**
 * Polish-19.4: one Extend segment in the chain. Same submit → poll
 * pattern but uses submitVeoExtend with the previous segment's video
 * URI as input. Each Extend bills 7s of generation.
 */
async function runVeoExtendSegment(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  segmentIndex: number;
  previousVideoUri: string;
  prompt: string;
}): Promise<
  | { ok: true; videoUri: string; veoOperationName: string; costUsd: number }
  | { ok: false; error: string; costUsd: number }
> {
  const { step, jobId, userId, variantIndex, segmentIndex, previousVideoUri, prompt } = input;
  const segLabel = `${variantIndex}-ext${segmentIndex}`;

  const submitResult = await step.run(`veo-extend-submit-${segLabel}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const submit = await submitVeoExtend({
      userId,
      apiKey: keys.gemini!,
      previousVideo: { uri: previousVideoUri, mimeType: 'video/mp4' },
      prompt,
      aspectRatio: '9:16',
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.operationName) {
      return {
        ok: false as const,
        error: submit.errorMessage ?? 'Veo Extend predictLongRunning failed',
      };
    }
    return { ok: true as const, operationName: submit.operationName };
  });
  if (!submitResult.ok) {
    return { ok: false, error: submitResult.error, costUsd: 0 };
  }

  const poll = await pollVeoUntilDone({
    step,
    jobId,
    userId,
    operationName: submitResult.operationName,
    label: segLabel,
  });
  const cost = estimateVeoCostUsd(VEO_EXTEND_SECONDS_PER_CALL);
  if (!poll.ok) {
    return { ok: false, costUsd: cost, error: poll.error };
  }
  return {
    ok: true,
    videoUri: poll.videoUri,
    veoOperationName: submitResult.operationName,
    costUsd: cost,
  };
}

/**
 * Polish-19.4: shared poll loop for both base + extend submits in
 * the chain. Same warmup + exponential-backoff curve as Polish-19.3
 * runOneSegment's poll loop, factored so the two callers stay in
 * lockstep. Step name prefix differs per caller via `label`.
 */
async function pollVeoUntilDone(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  operationName: string;
  label: string;
}): Promise<{ ok: true; videoUri: string } | { ok: false; error: string }> {
  const { step, jobId, userId, operationName, label } = input;
  await step.sleep(`veo-warmup-${label}`, `${POLL_WARMUP_SECONDS}s`);
  let pollError: string | undefined;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await step.run(`veo-poll-${label}-${attempt}`, async () => {
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
        operationName,
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
      if (poll.videoUri) return { ok: true, videoUri: poll.videoUri };
      pollError = poll.failMessage ?? 'Veo done without a video URI';
      break;
    }
    await step.sleep(`veo-wait-${label}-${attempt}`, `${computeVeoPollIntervalSeconds(attempt)}s`);
  }
  return {
    ok: false,
    error:
      `Veo operation ${operationName} (${label}) did not reach terminal state within ` +
      `${POLL_MAX_ATTEMPTS} polls.` +
      (pollError ? ` Last error: ${pollError}` : ''),
  };
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
