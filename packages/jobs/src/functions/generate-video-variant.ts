import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkReplicateConcat,
  createHedraAsset,
  isFailedHedraStatus,
  isVideoConcatEnabled,
  pollHedraGeneration,
  pollKieVideo,
  resolveHedraModelIdForVideoModel,
  submitElevenLabsTts,
  submitHedraGeneration,
  submitKieVideo,
  submitReplicateConcat,
  uploadHedraAsset,
} from '@mbb/ai-providers';
import {
  computeElevenLabsVoiceOffsetForJob,
  computeSegmentCountForModel,
  getDefaultElevenLabsVoice,
  getModelProviderConfig,
  getVideoModel,
  isElevenLabsVoiceRosterUncurated,
  pickElevenLabsVoicesForBatch,
  POLISH_VERSION,
  type CharacterVoiceGender,
  type ElevenLabsVoiceRosterEntry,
  type ModelProviderConfig,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@mbb/shared';
import { getDb, schema } from '@mbb/db';
import { extractMetadataObject } from './analyze-concept';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';

// Polish-21.0.15 hotfix: cold-start diagnostic log. Fires ONCE
// per serverless function boot (module-load time) so operators
// can grep Inngest logs after a redeploy and confirm the fresh
// build's version. Prevents the Polish-21.0.14 confusion where
// composite rows carried `polish_version: null` because the
// Inngest job was frozen on the pre-Polish-21.0.14 function
// version (Inngest's documented retry-pinning behavior). If this
// line appears with the expected version on a fresh cold start,
// the deploy stuck; if it doesn't appear at all, the module
// isn't loading and the Inngest handler is stale.
// eslint-disable-next-line no-console
console.log(`[jobs.generate-video-variant] cold start — POLISH_VERSION=${POLISH_VERSION}`);

/**
 * Polish-20: unified video-variant worker.
 *
 * ONE codepath that reads job.metadata.model_id +
 * job.metadata.provider_id, looks up the ModelProviderConfig via the
 * shared descriptor layer, then generates via the config-driven
 * kie-video client.
 *
 * Per variant:
 *   1. Claude → segments[] ad spec (per-model word-count calibrated).
 *   2. For each segment: submitKieVideo → pollKieVideo (parallel via
 *      Promise.all) using the model's ModelProviderConfig.
 *   3. If segmentCount > 1: Replicate ffmpeg-concat stitch.
 *   4. Upload composite → write generated_creatives row.
 *
 * Prompt-engineering: word-count calibration matched to the model's
 * per-call duration + source_script_verbatim preservation +
 * sound_texture field + speaker attribution.
 */

const POLL_WARMUP_SECONDS = 15;
const POLL_INITIAL_INTERVAL_SECONDS = 8;
const POLL_MAX_INTERVAL_SECONDS = 25;
const POLL_BACKOFF_GROWTH = 1.15;
const POLL_MAX_ATTEMPTS = 80; // ~15-25min ceiling — kie.ai runs are typically 30-120s

/**
 * Polish-20: exponential-backoff poll cadence — responsive at start,
 * bounded at 25s for stuck operations.
 */
export function computeVideoPollIntervalSeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return POLL_INITIAL_INTERVAL_SECONDS;
  const raw = POLL_INITIAL_INTERVAL_SECONDS * Math.pow(POLL_BACKOFF_GROWTH, attempt);
  return Math.min(
    Math.max(POLL_INITIAL_INTERVAL_SECONDS, Math.ceil(raw)),
    POLL_MAX_INTERVAL_SECONDS,
  );
}

/**
 * Polish-20: auto-resolve target duration from the fallback chain:
 *   1. metadata.analysis.video_duration_seconds  (vision-derived)
 *   2. metadata.source_duration_seconds          (form-picked)
 *   3. 30s default
 *
 * Segment count is derived from the RESOLVED duration + the picked
 * model's per-call cap.
 */
export function resolveAutoVideoDuration(
  jobMetadata: Record<string, unknown> | null,
  model: VideoModel,
): {
  targetSeconds: number;
  segmentCount: number;
  source: 'analysis' | 'form' | 'default';
  sourceDurationSeconds: number | null;
} {
  const buildResult = (
    target: number,
    source: 'analysis' | 'form' | 'default',
    raw: number | null,
  ) => ({
    targetSeconds: target,
    segmentCount: computeSegmentCountForModel(model, target),
    source,
    sourceDurationSeconds: raw,
  });
  if (jobMetadata) {
    const analysis = jobMetadata['analysis'];
    if (analysis && typeof analysis === 'object') {
      const a = analysis as Record<string, unknown>;
      const visionDuration = a['video_duration_seconds'];
      if (typeof visionDuration === 'number' && visionDuration > 0) {
        return buildResult(visionDuration, 'analysis', visionDuration);
      }
    }
    const formPersisted = jobMetadata['source_duration_seconds'];
    if (typeof formPersisted === 'number' && formPersisted > 0) {
      return buildResult(formPersisted, 'form', formPersisted);
    }
  }
  return buildResult(30, 'default', null);
}

/**
 * Polish-20: per-model word-count calibration for the Claude
 * ad-spec prompt. Each model has a different segment size so the
 * calibration scales with model.maxSingleCallSeconds.
 *
 * Math: ~170wpm natural yapping pace, so `secondsPerCall × 170/60`
 * words per segment, ±10% window.
 */
export function computeWordCountRangePerSegment(model: VideoModel): {
  min: number;
  max: number;
} {
  const wpm = 170;
  const central = (model.maxSingleCallSeconds * wpm) / 60;
  return {
    min: Math.round(central * 0.85),
    max: Math.round(central * 1.05),
  };
}

/**
 * Polish-20 Commit 2 (Polish-19.4.2 pattern): extract the source
 * ad's script transcription from jobMetadata for the Claude prompt's
 * top-level source_script_verbatim field. Returns "" when missing.
 */
export function extractSourceScriptVerbatim(jobMetadata: Record<string, unknown> | null): string {
  if (!jobMetadata) return '';
  const analysis = jobMetadata['analysis'];
  if (!analysis || typeof analysis !== 'object') return '';
  const t = (analysis as Record<string, unknown>)['script_transcription'];
  return typeof t === 'string' ? t : '';
}

/**
 * Polish-20.0.3: strip fields Claude should NOT see when writing
 * per-segment yapper prompts. The pre-20.0.3 worker forwarded the
 * ENTIRE jobMetadata blob as `source_analysis`, which included the
 * analyze-concept step's `draft_prompt` — a bracketed
 * ("**Camera Shot:**", "**Actions:**", etc.) Sora-era monolith.
 * Claude then copied that bracketed structure into its segment
 * prompts, so Seedance received bracketed prose instead of yapper
 * prose (production diagnostic on job 395cc9b7).
 *
 * We now hand Claude ONLY the vision-derived analysis object
 * (subject / scene / audio cues / duration), plus the sourceScript
 * verbatim at the top level. Nothing else.
 */
export function sanitizeSourceAnalysisForClaude(
  jobMetadata: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!jobMetadata) return {};
  const analysis = jobMetadata['analysis'];
  if (analysis && typeof analysis === 'object' && !Array.isArray(analysis)) {
    // Return a defensive copy so Claude can't see stray root-level
    // fields (draft_prompt, model_id, provider_id, _live, etc.)
    // leaking through via prototype chain.
    return { ...(analysis as Record<string, unknown>) };
  }
  return {};
}

// -------------------------------------------------------------------
// Ad-spec types (Polish-19.4.2 shape carried forward)
// -------------------------------------------------------------------

export interface VideoAdSegment {
  index: number;
  prompt: string;
  sound_texture?: string;
}

export interface VideoAdSpec {
  segments: VideoAdSegment[];
}

export function parseVideoAdSpec(raw: string | unknown): VideoAdSpec | null {
  if (typeof raw !== 'string') return validateVideoAdSpec(raw);
  let candidate = raw.trim();
  const fenceMatch = candidate.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch && fenceMatch[1]) candidate = fenceMatch[1].trim();
  try {
    return validateVideoAdSpec(JSON.parse(candidate));
  } catch {
    /* fall through */
  }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return validateVideoAdSpec(JSON.parse(candidate.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

function validateVideoAdSpec(value: unknown): VideoAdSpec | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.segments) || v.segments.length === 0) return null;
  const segments: VideoAdSegment[] = [];
  for (let i = 0; i < v.segments.length; i++) {
    const s = v.segments[i] as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object') return null;
    if (typeof s.prompt !== 'string' || s.prompt.length === 0) return null;
    const idx = typeof s.index === 'number' && Number.isFinite(s.index) ? s.index : i;
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

export function fallbackToSingleSegment(rawText: string): VideoAdSpec {
  return { segments: [{ index: 0, prompt: rawText }] };
}

// -------------------------------------------------------------------
// Worker
// -------------------------------------------------------------------

interface VideoVariantResult {
  index: number;
  ok: boolean;
  costUsd: number;
  fileUrl?: string;
  error?: string;
}

export const generateVideoVariant = inngest.createFunction(
  {
    id: 'generate-video-variant',
    name: 'Generate video variant (unified worker — Seedance / Kling / etc.)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/video-variant.requested' },
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

    // Polish-20.0.2: use the shared defensive extractor so a
    // postgres-js jsonb-as-string edge case can't miss model_id.
    const jobMetadata = extractMetadataObject(job.metadata ?? null);
    const modelId =
      jobMetadata && typeof jobMetadata['model_id'] === 'string'
        ? (jobMetadata['model_id'] as VideoModelId)
        : null;
    const providerId =
      jobMetadata && typeof jobMetadata['provider_id'] === 'string'
        ? (jobMetadata['provider_id'] as VideoProviderId)
        : null;

    if (!modelId || !providerId) {
      await markJobFailed(
        jobId,
        userId,
        `Missing model_id/provider_id on job metadata (model_id=${modelId ?? 'null'}, provider_id=${providerId ?? 'null'}).`,
        0,
      );
      return { jobId, mode, generated: 0 };
    }

    const model = getVideoModel(modelId);
    const config = getModelProviderConfig(modelId, providerId);
    if (!model || !config) {
      await markJobFailed(
        jobId,
        userId,
        `Unknown (model_id, provider_id) tuple: (${modelId}, ${providerId}). No live ModelProviderConfig.`,
        0,
      );
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
    const autoDuration = resolveAutoVideoDuration(jobMetadata, model);
    console.log(
      `[generate-video-variant] job ${jobId}: model=${modelId} provider=${providerId} ` +
        `target=${autoDuration.targetSeconds}s (${autoDuration.segmentCount} segment${
          autoDuration.segmentCount === 1 ? '' : 's'
        }) via ${autoDuration.source}` +
        (autoDuration.sourceDurationSeconds != null
          ? ` from source ${autoDuration.sourceDurationSeconds}s`
          : ' (no source duration)'),
    );

    if (mode === 'mock') {
      // Polish-20 Commit 5: mock path now matches the live path's
      // row shape — per-segment rows (isClipPart: true) when
      // segmentCount > 1, plus a composite row (isClipPart: false).
      // Same shape lets the /runs/[id] grid + review filters behave
      // identically in mock and live modes.
      await step.sleep('mock-render', '2s');
      await step.run('insert-mock-rows', async () => {
        const db = getDb();
        const mockUrl = 'https://samplelib.com/lib/preview/mp4/sample-10s.mp4';
        for (let variantIndex = 0; variantIndex < variantCount; variantIndex++) {
          if (autoDuration.segmentCount > 1) {
            const segmentRows = Array.from(
              { length: autoDuration.segmentCount },
              (_, segmentIndex) => ({
                userId,
                generationJobId: jobId,
                fileUrl: mockUrl,
                aspectRatio: '9:16' as const,
                status: 'ready_for_review' as const,
                format: `video_${modelId}_segment`,
                clipIndex: segmentIndex,
                isClipPart: true,
                generationMetadata: {
                  mock: true,
                  variant_index: variantIndex,
                  segment_index: segmentIndex,
                  model_id: modelId,
                  provider_id: providerId,
                  duration_seconds: model.maxSingleCallSeconds,
                },
              }),
            );
            await db.insert(schema.generatedCreatives).values(segmentRows);
          }
          await db.insert(schema.generatedCreatives).values({
            userId,
            generationJobId: jobId,
            fileUrl: mockUrl,
            aspectRatio: '9:16',
            status: 'ready_for_review',
            format: `video_${modelId}`,
            isClipPart: false,
            generationMetadata: {
              mock: true,
              variant_index: variantIndex,
              model_id: modelId,
              provider_id: providerId,
              duration_seconds: autoDuration.targetSeconds,
              segment_count: autoDuration.segmentCount,
              stitched: autoDuration.segmentCount > 1,
            },
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
        // Polish-21: provider tag now derives from the actual routing
        // key so admin per-worker rollups aggregate hedra jobs
        // separately from kie.ai jobs.
        provider: providerId,
        path: 'video-variant',
      });
      return { jobId, mode, generated: variantCount };
    }

    // Multi-segment concat guard — fail fast when concat is required but
    // env not set.
    if (autoDuration.segmentCount > 1 && !isVideoConcatEnabled()) {
      await markJobFailed(
        jobId,
        userId,
        `Multi-segment video (${autoDuration.segmentCount} segments) requires REPLICATE_VIDEO_CONCAT_MODEL_ID env. ` +
          `Set it on Vercel + redeploy, or pick the 8s preset for single-call output.`,
        0,
      );
      return { jobId, mode, generated: 0 };
    }

    const variantResults = await Promise.all(
      Array.from({ length: variantCount }, (_, index) =>
        runOneVariant({
          step,
          jobId,
          userId,
          variantIndex: index,
          variantCount,
          model,
          config,
          targetSeconds: autoDuration.targetSeconds,
          segmentCount: autoDuration.segmentCount,
          jobMetadata,
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
      // Polish-21: provider tag from the actual routing key.
      provider: providerId,
      path: 'video-variant',
      partialFailures: failures.map((f) => ({ index: f.index, error: f.error })),
    });
    return { jobId, mode, generated: successes.length, failed: failures.length };
  },
);

// -------------------------------------------------------------------
// Per-variant runner
// -------------------------------------------------------------------

interface RunOneVariantInput {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  /**
   * Polish-21: total variants in the batch. Hedra path uses this to
   * pick a deterministic voice roster slice per batch (each variant
   * lands a different voice for max ad-test diversity). Legacy
   * kie.ai path ignores it.
   */
  variantCount: number;
  model: VideoModel;
  config: ModelProviderConfig;
  targetSeconds: number;
  segmentCount: number;
  jobMetadata: Record<string, unknown> | null;
}

async function runOneVariant(input: RunOneVariantInput): Promise<VideoVariantResult> {
  // Polish-21 Commit 2 → Polish-21.0.9: dispatch. ALL Hedra-provider
  // models (Character 3, Kling Avatar v2 Standard, Kling Avatar v2
  // Pro) are single-call image-to-talking-avatar generations — same
  // asset-upload + ElevenLabs TTS + /generations submit flow, only
  // the ai_model_id UUID differs. Route by PROVIDER, not model id,
  // so a future Hedra-hosted model lands here for free.
  if (input.config.providerId === 'hedra') {
    return runOneVariantHedra(input);
  }
  const {
    step,
    jobId,
    userId,
    variantIndex,
    model,
    config,
    targetSeconds,
    segmentCount,
    jobMetadata,
  } = input;
  let cost = 0;

  const adSpecResult = await step.run(`claude-ad-spec-${variantIndex}`, async () =>
    runClaudeAdSpec({
      userId,
      jobId,
      variantIndex,
      jobMetadata,
      model,
      segmentCount,
      targetSeconds,
    }),
  );
  cost += adSpecResult.costUsd;
  if (!adSpecResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: adSpecResult.error };
  }
  const adSpec = adSpecResult.adSpec;

  console.log(
    `[generate-video-variant] variant ${variantIndex} model=${model.id}: fanning out ` +
      `${adSpec.segments.length} segment(s) for ${targetSeconds}s ad. ` +
      `${adSpec.segments.length > 1 ? 'Will stitch via Replicate ffmpeg-concat.' : 'Single-call, no stitch.'}`,
  );

  const perCallSeconds = Math.min(
    model.maxSingleCallSeconds,
    Math.max(1, Math.round(targetSeconds / adSpec.segments.length)),
  );
  const clampedPerCall = clampPerCallSeconds(model, perCallSeconds);

  // Generate all segments in parallel.
  const segmentResults = await Promise.all(
    adSpec.segments.map((seg: VideoAdSegment) =>
      runOneSegment({
        step,
        jobId,
        userId,
        variantIndex,
        segmentIndex: seg.index,
        segmentPrompt: seg.prompt,
        model,
        config,
        durationSeconds: clampedPerCall,
      }),
    ),
  );
  for (const s of segmentResults) cost += s.costUsd;

  const allOk = segmentResults.every((s) => s.ok);
  if (!allOk) {
    const firstFailure = segmentResults.find((s) => !s.ok);
    console.log(
      `[generate-video-variant] variant ${variantIndex}: ${
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

  const successSegments = [...segmentResults]
    .filter((s): s is SegmentSuccess => s.ok)
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
  const segmentUrls = successSegments.map((s) => s.publicUrl);

  let compositeUrl = segmentUrls[0]!;
  let stitched = false;
  if (successSegments.length > 1) {
    const stitchResult = await runStitch({
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

  // Persist per-segment rows (when multi-segment) + composite row.
  if (successSegments.length > 1) {
    await step.run(`insert-segment-rows-${variantIndex}`, async () => {
      const db = getDb();
      const rows = successSegments.map((s) => ({
        userId,
        generationJobId: jobId,
        fileUrl: s.publicUrl,
        aspectRatio: '9:16' as const,
        status: 'ready_for_review' as const,
        format: `video_${model.id}_segment`,
        clipIndex: s.segmentIndex,
        isClipPart: true,
        generationMetadata: {
          variant_index: variantIndex,
          segment_index: s.segmentIndex,
          model_id: model.id,
          provider_id: config.providerId,
          kie_task_id: s.taskId,
          duration_seconds: clampedPerCall,
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
      format: `video_${model.id}`,
      isClipPart: false,
      generationMetadata: {
        variant_index: variantIndex,
        model_id: model.id,
        provider_id: config.providerId,
        duration_seconds: successSegments.length * clampedPerCall,
        segment_count_requested: segmentCount,
        segment_count_generated: successSegments.length,
        segment_urls: segmentUrls,
        kie_task_ids: successSegments.map((s) => s.taskId),
        segments: adSpec.segments,
        stitched,
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: compositeUrl };
}

// -------------------------------------------------------------------
// Polish-21 Commit 2: Hedra Character 3 branch
// -------------------------------------------------------------------
//
// Single-call image-to-talking-avatar. Zero segment fan-out, zero
// stitch. Nine well-defined step.run boundaries per variant:
//   1. Claude → {scene_description, script} (short-scene format)
//   2. Nano Banana Pro → reference character image (base64)
//   3. Voice roster gate check + variant → voice assignment
//   4. createHedraAsset({type: 'image'}) → asset id
//   5. uploadHedraAsset (multipart) → bytes land
//   6. submitHedraGeneration({start_keyframe_id, tts, text_prompt})
//   7. pollHedraGeneration until 'complete'|'error'
//   8. Download mp4 → Supabase Storage
//   9. Insert generated_creatives row (isClipPart: false — Hedra is
//      never a multi-clip source)
//
// Every step.run wraps a single API call so Inngest's retry
// semantics can replay a stalled poll without re-running Claude etc.
//
// Voice picker: pickHedraVoicesForBatch(variantCount, offset) with
// offset derived from jobId — each batch lands a different voice on
// variant 0, but retries of the same job produce identical output.

/**
 * Polish-21: Character 3 uses ~50-80 word scene descriptions rather
 * than the yapper prose Polish-20.0.3 tuned for kie.ai models.
 * Character 3 handles motion from the audio track natively — long
 * camera choreography prompts fight the model.
 */
export interface VideoAdScene {
  scene_description: string;
  script: string;
}

/**
 * Polish-21.0.7 hotfix: structured character schema for the Nano
 * Banana Pro reference image call. Rewrites the Polish-21.0.5 JOHN
 * paragraph shape to the operator's manually-verified "Linda"
 * pattern: ITEMIZED physical-feature bullets with specific
 * imperfections + a CRITICAL ANTI-CELEBRITY DIRECTIVE block with
 * named examples + "anonymous not attractive" reframe.
 *
 * Rationale:
 *   - Nano Banana Pro renders itemized bullets sharper than flowing
 *     paragraphs (paragraph anchors get averaged out; bullets
 *     survive with their specific imperfection intact).
 *   - Without an explicit anti-celebrity directive, Nano Banana
 *     pattern-matches to famous training-data faces by default.
 *     Named examples in the prompt steer the model away from those
 *     specific attractors.
 *   - "Anonymous, not attractive" reframes the default beauty-
 *     optimization goal that produces stock-photo output.
 */
export type SkinColorForStubble = 'grey' | 'brown' | 'black' | 'blonde' | 'red' | 'none';

export interface StructuredCharacter {
  name: string;
  age: number;
  nationality: string;
  gender: 'male' | 'female';
  /** e.g. "suburban grandmother", "working dad", "young professional". */
  demographic_role: string;
  /** Bullet — length, color, styling. Ends with "slightly messy, NOT styled" qualifier. */
  hair_bullet: string;
  /** Bullet — one specific eye-line asymmetry (e.g. droopy eyelid on one side). */
  eye_asymmetry_bullet: string;
  /** Bullet — one specific nose imperfection (bump on bridge, wider than average, etc). */
  nose_bullet: string;
  /** Bullet — mouth asymmetry / downturn detail. */
  mouth_bullet: string;
  /** Bullet — eye color + age-specific detail (crow's feet, bags, redness). */
  eye_color_and_age_detail: string;
  /** Bullet — jaw with subtle imperfection (jowls, softness, weak chin). */
  jaw_bullet: string;
  /** Bullet — face shape with "NOT chiseled, NOT model-shaped" qualifier. */
  face_shape_bullet: string;
  /** Bullet — specific clothing item + material + wear condition. */
  clothing_bullet: string;
  /** Paragraph — sitting/standing setting with specific furniture/props + light source. */
  setting_paragraph: string;
  /** String — age-appropriate skin imperfections (age spots / acne scars / freckles / etc). */
  skin_age_appropriate_detail: string;
  /** Drives the SKIN REALISM MANDATE stubble line. */
  skin_color_for_stubble: SkinColorForStubble;
  /**
   * 8-12 age-appropriate actresses the face MUST NOT resemble.
   * Named examples steer Nano Banana away from the celebrity
   * attractors it defaults to.
   */
  anti_celeb_actress_examples: string[];
  /** 4-6 news anchors / talk show hosts the face MUST NOT resemble. */
  anti_celeb_news_examples: string[];
  /** 4-6 political figures / spouses the face MUST NOT resemble. */
  anti_celeb_politician_examples: string[];
}

/**
 * Polish-21.0.7: safe-fallback Linda-shape everyperson used when
 * Claude's output omits or fails to parse the character block.
 * Concrete itemized values match the operator's manually verified
 * production reference. Age tuned to the ~65+ suburban grandmother
 * bucket — the most-tested UGC ad-target demographic.
 */
export const FALLBACK_STRUCTURED_CHARACTER: StructuredCharacter = {
  name: 'Linda',
  age: 68,
  nationality: 'American',
  gender: 'female',
  demographic_role: 'suburban grandmother',
  hair_bullet:
    'Shoulder-length salt-and-pepper hair, slightly messy, NOT styled, NOT symmetrical — a couple of loose strands framing the face',
  eye_asymmetry_bullet:
    'Slightly uneven eye line — one eyelid drooping slightly more than the other (natural aging)',
  nose_bullet: 'Ordinary nose — slightly wider than average, with a small bump on the bridge',
  mouth_bullet: 'Thin lips, slightly asymmetric mouth, natural slight downturn on the left side',
  eye_color_and_age_detail: "Warm hazel eyes with visible crow's feet and slight bags underneath",
  jaw_bullet: 'Soft jawline with mild jowls (age-appropriate) — no sharp definition',
  face_shape_bullet:
    'Oval face with natural fullness at the cheeks, NOT chiseled, NOT model-shaped',
  clothing_bullet:
    'Faded navy cotton crewneck with honest wear at the neckline — not new, not designer',
  setting_paragraph:
    'Sitting at a slightly cluttered morning kitchen table — a coffee mug and unopened mail visible behind her, warm natural window light from off-camera. Cozy lived-in feel.',
  skin_age_appropriate_detail:
    "faint age spots on the cheekbones, small broken capillaries near the nose, natural crow's feet at the outer eye corners",
  skin_color_for_stubble: 'none',
  anti_celeb_actress_examples: [
    'Meryl Streep',
    'Helen Mirren',
    'Jane Fonda',
    'Diane Keaton',
    'Sally Field',
    'Goldie Hawn',
    'Susan Sarandon',
    'Glenn Close',
    'Judi Dench',
    'Maggie Smith',
  ],
  anti_celeb_news_examples: [
    'Barbara Walters',
    'Diane Sawyer',
    'Katie Couric',
    'Oprah',
    'Ellen DeGeneres',
  ],
  anti_celeb_politician_examples: [
    'Hillary Clinton',
    'Nancy Pelosi',
    'Barbara Bush',
    'Michelle Obama',
  ],
};

/**
 * Polish-21: single-scene ad spec for Character 3 (one scene per
 * variant since Character 3 is single-call). Replaces the
 * Polish-20 `VideoAdSpec.segments[]` structure.
 *
 * Polish-21.0.5: `character` block added for the Nano Banana Pro
 * reference-image step (JOHN pattern). Optional on the wire —
 * parser fills in FALLBACK_STRUCTURED_CHARACTER when Claude drops
 * or malforms the block.
 */
export interface VideoAdSpecHedra {
  scene: VideoAdScene;
  character: StructuredCharacter;
}

/**
 * Polish-21.0.7 hotfix: compose the Nano Banana Pro image prompt
 * from the structured character using the operator's manually-
 * verified Linda 7-block pattern:
 *
 *   1. Vertical iPhone selfie lead (fictional + demographic hint)
 *   2. PHYSICAL FEATURES (deliberately asymmetric and ordinary) —
 *      itemized bullets with specific imperfections
 *   3. Setting paragraph
 *   4. SKIN REALISM MANDATE (all three ZERO anchors preserved from
 *      Polish-21.0.5 tests + Linda-style age-appropriate detail)
 *   5. CRITICAL ANTI-CELEBRITY DIRECTIVE (new — named examples of
 *      who the face MUST NOT resemble + "anonymous not attractive"
 *      reframe + regenerate self-check)
 *   6. Camera / setting anchor
 *   7. Anti-AI directive tail (verbatim from Kling 3.0 guide)
 *
 * Key wording anchors are word-for-word — a future rewrite that
 * softens the ZERO clauses, drops the ANONYMOUS-not-ATTRACTIVE
 * reframe, or removes the celebrity examples silently degrades
 * Nano Banana output back toward AI-CGI stock-photo aesthetic.
 * Tests pin every anchor.
 */
export function composeNanoBananaCharacterPrompt(character: StructuredCharacter): string {
  const {
    name,
    age,
    nationality,
    gender,
    demographic_role,
    hair_bullet,
    eye_asymmetry_bullet,
    nose_bullet,
    mouth_bullet,
    eye_color_and_age_detail,
    jaw_bullet,
    face_shape_bullet,
    clothing_bullet,
    setting_paragraph,
    skin_age_appropriate_detail,
    skin_color_for_stubble,
    anti_celeb_actress_examples,
    anti_celeb_news_examples,
    anti_celeb_politician_examples,
  } = character;
  const pronoun = gender === 'female' ? 'She' : 'He';
  const objectPronoun = gender === 'female' ? 'her' : 'him';
  const stubbleClause =
    skin_color_for_stubble === 'none'
      ? ''
      : ` Real ${skin_color_for_stubble} stubble shadow on upper lip and jaw from one day of missed shaving.`;

  // Block 1 — Linda selfie lead.
  const block1_selfieLead =
    `Photorealistic vertical iPhone selfie of a fictional ${age}-year-old ${nationality} ${gender} named ${name}. ` +
    `Generic ${demographic_role} appearance.`;

  // Block 2 — PHYSICAL FEATURES (itemized bullets, deliberately
  // asymmetric). Bullets render sharper on Nano Banana than paragraphs;
  // the anti-generic imperfection stays intact instead of averaging out.
  const block2_physicalFeatures =
    `PHYSICAL FEATURES (deliberately asymmetric and ordinary):\n` +
    `- ${hair_bullet}\n` +
    `- ${eye_asymmetry_bullet}\n` +
    `- ${nose_bullet}\n` +
    `- ${mouth_bullet}\n` +
    `- ${eye_color_and_age_detail}\n` +
    `- ${jaw_bullet}\n` +
    `- ${face_shape_bullet}\n` +
    `- Clothing: ${clothing_bullet}`;

  // Block 3 — Setting.
  const block3_setting = setting_paragraph;

  // Block 4 — SKIN REALISM MANDATE. Preserves the Polish-21.0.5 anchors
  // ("ZERO beauty filters. ZERO skin smoothing. ZERO AI plastic-skin
  // artifacts.") AND adds the Linda-shaped age-appropriate detail line.
  const block4_skinRealism =
    `SKIN REALISM MANDATE: Real ${age}-year-old skin — visible pores, natural sebaceous texture on nose, ${skin_age_appropriate_detail}, slight redness on cheekbones.${stubbleClause} Natural vellus hair on forearms. ` +
    `ZERO airbrushing. ZERO beauty filters. ZERO skin smoothing. ZERO AI plastic-skin artifacts. ` +
    `${pronoun} must look like a real ${age}-year-old ${demographic_role}, not a model, not an actor, ` +
    `not an AI-generated character.`;

  // Block 5 — CRITICAL ANTI-CELEBRITY DIRECTIVE (NEW). Steers Nano
  // Banana away from famous-face attractors with named examples +
  // the "anonymous not attractive" reframe + regenerate self-check.
  const actressList = anti_celeb_actress_examples.join(', ');
  const newsList = anti_celeb_news_examples.join(', ');
  const politicianList = anti_celeb_politician_examples.join(', ');
  const block5_antiCelebrity =
    `CRITICAL ANTI-CELEBRITY DIRECTIVE: The face must be DELIBERATELY GENERIC and FORGETTABLE. The face must NOT resemble:\n` +
    `- ANY actress (${actressList})\n` +
    `- ANY news anchor or talk show host (${newsList})\n` +
    `- ANY political figure or spouse (${politicianList})\n` +
    `- ANY famous ${gender} of the ~${age}-year-old bracket, living or dead.\n\n` +
    `The face should look like a RANDOM ${demographic_role}: 'the kind of face where you'd say I think I've seen ${objectPronoun} at the grocery store but you couldn't pick ${objectPronoun} out of a lineup.' Slightly asymmetric, ordinary features, no 'TV polish.'\n\n` +
    `Aim for ANONYMOUS, not ATTRACTIVE. The face should be intentionally unremarkable. If the face looks like a TV ${demographic_role} character, regenerate. The target is 'real human you'd walk past on the street and forget.'`;

  // Block 6 — Camera anchor (Polish-21.0.5 phrasing preserved for
  // the existing test pins).
  const block6_camera = `Shot on iPhone front camera, 9:16 vertical, natural daylight from ${setting_paragraph.split('.')[0]?.toLowerCase() ?? 'the scene setting'}, slightly shaky handheld feel.`;

  // Block 7 — Anti-AI directive (verbatim Kling 3.0 guide anchor).
  const block7_antiAiDirective =
    'ABSOLUTELY NO phones, cameras, screens, social media UI, floating text, or digital overlays visible anywhere in the frame.';

  return [
    block1_selfieLead,
    block2_physicalFeatures,
    block3_setting,
    block4_skinRealism,
    block5_antiCelebrity,
    block6_camera,
    block7_antiAiDirective,
  ].join('\n\n');
}

export function parseVideoAdSpecHedra(raw: string | unknown): VideoAdSpecHedra | null {
  if (typeof raw !== 'string') return validateVideoAdSpecHedra(raw);
  let candidate = raw.trim();
  const fenceMatch = candidate.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch && fenceMatch[1]) candidate = fenceMatch[1].trim();
  try {
    return validateVideoAdSpecHedra(JSON.parse(candidate));
  } catch {
    /* fall through */
  }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return validateVideoAdSpecHedra(JSON.parse(candidate.slice(first, last + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

function validateVideoAdSpecHedra(value: unknown): VideoAdSpecHedra | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  // Accept either {scene: {...}, character: {...}} or a flat
  // {scene_description, script, character?} shape. Claude
  // occasionally emits the flat shape when only one scene is
  // asked for.
  const character = parseStructuredCharacter(v['character']);
  if (v.scene && typeof v.scene === 'object' && !Array.isArray(v.scene)) {
    return validateSceneBody(v.scene as Record<string, unknown>, character);
  }
  return validateSceneBody(v, character);
}

function validateSceneBody(
  body: Record<string, unknown>,
  character: StructuredCharacter,
): VideoAdSpecHedra | null {
  const sd = body['scene_description'];
  const sc = body['script'];
  if (typeof sd !== 'string' || sd.length === 0) return null;
  if (typeof sc !== 'string' || sc.length === 0) return null;
  return { scene: { scene_description: sd, script: sc }, character };
}

/**
 * Polish-21.0.7 hotfix: parse a Linda-shape character block from
 * Claude's output, falling back to FALLBACK_STRUCTURED_CHARACTER
 * when the block is missing / not an object / drops required
 * fields. Partial hydration risks a strange half-Claude, half-
 * fallback character that reads worse than either shape on its
 * own — cleaner to fall back wholesale.
 */
export function parseStructuredCharacter(raw: unknown): StructuredCharacter {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return FALLBACK_STRUCTURED_CHARACTER;
  const c = raw as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof c[key] === 'string' && (c[key] as string).length > 0 ? (c[key] as string) : undefined;
  const strArray = (key: string, minLen: number): string[] | undefined => {
    const v = c[key];
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return arr.length >= minLen ? arr : undefined;
  };

  const name = str('name');
  const ageRaw = c['age'];
  const age =
    typeof ageRaw === 'number' && Number.isFinite(ageRaw) && ageRaw > 0
      ? Math.round(ageRaw)
      : undefined;
  const nationality = str('nationality');
  const genderRaw = c['gender'];
  const gender: 'male' | 'female' | undefined =
    genderRaw === 'male' || genderRaw === 'female' ? genderRaw : undefined;
  const demographic_role = str('demographic_role');
  const hair_bullet = str('hair_bullet');
  const eye_asymmetry_bullet = str('eye_asymmetry_bullet');
  const nose_bullet = str('nose_bullet');
  const mouth_bullet = str('mouth_bullet');
  const eye_color_and_age_detail = str('eye_color_and_age_detail');
  const jaw_bullet = str('jaw_bullet');
  const face_shape_bullet = str('face_shape_bullet');
  const clothing_bullet = str('clothing_bullet');
  const setting_paragraph = str('setting_paragraph');
  const skin_age_appropriate_detail = str('skin_age_appropriate_detail');
  const stubbleRaw = c['skin_color_for_stubble'];
  const skin_color_for_stubble: SkinColorForStubble | undefined =
    stubbleRaw === 'grey' ||
    stubbleRaw === 'brown' ||
    stubbleRaw === 'black' ||
    stubbleRaw === 'blonde' ||
    stubbleRaw === 'red' ||
    stubbleRaw === 'none'
      ? stubbleRaw
      : undefined;
  // Anti-celebrity arrays: require at least a few named examples
  // per category so the DIRECTIVE block has real content.
  const anti_celeb_actress_examples = strArray('anti_celeb_actress_examples', 4);
  const anti_celeb_news_examples = strArray('anti_celeb_news_examples', 2);
  const anti_celeb_politician_examples = strArray('anti_celeb_politician_examples', 2);

  if (
    !name ||
    !age ||
    !nationality ||
    !gender ||
    !demographic_role ||
    !hair_bullet ||
    !eye_asymmetry_bullet ||
    !nose_bullet ||
    !mouth_bullet ||
    !eye_color_and_age_detail ||
    !jaw_bullet ||
    !face_shape_bullet ||
    !clothing_bullet ||
    !setting_paragraph ||
    !skin_age_appropriate_detail ||
    !skin_color_for_stubble ||
    !anti_celeb_actress_examples ||
    !anti_celeb_news_examples ||
    !anti_celeb_politician_examples
  ) {
    return FALLBACK_STRUCTURED_CHARACTER;
  }
  return {
    name,
    age,
    nationality,
    gender,
    demographic_role,
    hair_bullet,
    eye_asymmetry_bullet,
    nose_bullet,
    mouth_bullet,
    eye_color_and_age_detail,
    jaw_bullet,
    face_shape_bullet,
    clothing_bullet,
    setting_paragraph,
    skin_age_appropriate_detail,
    skin_color_for_stubble,
    anti_celeb_actress_examples,
    anti_celeb_news_examples,
    anti_celeb_politician_examples,
  };
}

// Polish-21: Hedra Character 3 typical run is 30-90s of generation.
// Warmup shorter than kie.ai (Character 3 rarely finishes < 20s).
//
// Polish-21.0.2: warmup bumped 8s → 15s after job 1db50a7c diagnosed
// a fast 189ms 404 on the first status poll. The URL is verified
// correct against three authoritative sources (Hedra docs, official
// Python starter, official Node SDK — see hedra-video.ts docstring),
// so the 404 is most plausibly eventual-consistency lag between
// submit and status endpoints. 15s + retry-on-404 during the first
// N attempts absorbs the window without meaningfully extending
// wall-clock on the happy path.
const HEDRA_POLL_WARMUP_SECONDS = 15;
const HEDRA_POLL_INTERVAL_SECONDS = 5;
/**
 * Polish-21.0.10: default poll budget when a VideoModel doesn't
 * specify `hedraPollMaxAttempts`. Every launcher-visible Hedra
 * model in Polish-21.0.10 sets its own budget (Character 3 = 80,
 * Kling Std = 150, Kling Pro = 200); this constant only fires
 * for a hypothetical future Hedra model that ships without a
 * per-model budget. Kept conservative to avoid runaway Inngest
 * cost on a mis-configured model.
 */
export const HEDRA_POLL_MAX_ATTEMPTS = 80;
/**
 * Polish-21.0.2: the number of consecutive 404s during the initial
 * post-submit window that we treat as "generation not queryable yet,
 * keep polling" rather than terminal error. 12 attempts × 5s
 * interval = ~60s tolerance for Hedra's status-endpoint replication
 * lag. If 404s persist beyond this window the worker fails the
 * variant loudly (likely a real bug — wrong endpoint, deleted
 * generation, or auth scope mismatch).
 */
const HEDRA_POLL_MAX_INITIAL_404S = 12;

async function runOneVariantHedra(input: RunOneVariantInput): Promise<VideoVariantResult> {
  const {
    step,
    jobId,
    userId,
    variantIndex,
    variantCount,
    model,
    config,
    targetSeconds,
    jobMetadata,
  } = input;
  let cost = 0;

  // Voice roster gate — Polish-21.0.4 hotfix ships with 5 preset
  // ElevenLabs voice UUIDs, so this returns false. Kept as a
  // defensive check in case a future accidental roster wipe would
  // silently no-op the batch.
  if (isElevenLabsVoiceRosterUncurated()) {
    return {
      index: variantIndex,
      ok: false,
      costUsd: 0,
      error:
        'ElevenLabs voice roster is empty. Populate ELEVENLABS_VOICE_ROSTER in ' +
        'packages/shared/src/video-models.ts.',
    };
  }

  // Step 1: Claude ad spec (short-scene format).
  const adSpecResult = await step.run(`hedra-claude-${variantIndex}`, async () =>
    runClaudeAdSpecHedra({ userId, jobId, variantIndex, variantCount, jobMetadata, model }),
  );
  cost += adSpecResult.costUsd;
  if (!adSpecResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: adSpecResult.error };
  }
  const { scene_description: sceneDescription, script } = adSpecResult.spec.scene;
  const character = adSpecResult.spec.character;
  // Polish-21.0.5: compose the Nano Banana Pro prompt from the
  // structured character using the JOHN 6-block pattern. Old
  // Polish-21 Commit 2 inline prompt produced AI-CGI output; the
  // JOHN naturalistic-paragraph anchors get Nano Banana to hold
  // photoreal amateur-selfie aesthetic.
  const imagePrompt = composeNanoBananaCharacterPrompt(character);

  // Step 2: Nano Banana Pro reference image gen.
  const refImageResult = await step.run(`hedra-nano-banana-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['gemini']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError)
        return { ok: false as const, error: err.message, costUsd: 0 };
      throw err;
    }
    const gen = await callGeminiImage({
      userId,
      apiKey: keys.gemini!,
      prompt: imagePrompt,
      generationJobId: jobId,
    });
    if (!gen.ok || !gen.imageBase64) {
      return {
        ok: false as const,
        error: gen.errorMessage ?? 'Nano Banana failed',
        costUsd: gen.costUsd,
      };
    }
    return {
      ok: true as const,
      imageBase64: gen.imageBase64,
      mimeType: gen.imageMimeType ?? 'image/png',
      costUsd: gen.costUsd,
    };
  });
  cost += refImageResult.costUsd;
  if (!refImageResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: refImageResult.error };
  }

  // Step 3: mirror the reference image to Supabase so the run-detail
  // page can render it alongside the video. Failure is non-fatal —
  // the video generation still lands; we just lose the forensic thumb.
  let referenceImageUrl: string | undefined;
  try {
    const uploaded = await step.run(`hedra-ref-upload-${variantIndex}`, async () =>
      uploadGeneratedImage({
        userId,
        jobId,
        variantIndex,
        imageBase64: refImageResult.imageBase64,
        mimeType: refImageResult.mimeType,
        filenamePrefix: 'hedra-ref-',
      }),
    );
    referenceImageUrl = uploaded.publicUrl;
  } catch (err) {
    console.log(
      `[generate-video-variant] variant ${variantIndex}: Supabase mirror of Hedra ` +
        `reference image failed; continuing without forensic thumb. err=${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 4+5: create Hedra image asset + upload bytes.
  const assetResult = await step.run(`hedra-image-asset-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['hedra']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const create = await createHedraAsset({
      userId,
      apiKey: keys.hedra!,
      name: `variant-${variantIndex}.png`,
      type: 'image',
      generationJobId: jobId,
    });
    if (!create.ok || !create.assetId) {
      return {
        ok: false as const,
        error: create.errorMessage ?? 'Hedra createHedraAsset failed',
      };
    }
    const bytes = Buffer.from(refImageResult.imageBase64, 'base64');
    const upload = await uploadHedraAsset({
      userId,
      apiKey: keys.hedra!,
      assetId: create.assetId,
      filename: `variant-${variantIndex}.png`,
      contentType: refImageResult.mimeType,
      bytes: new Uint8Array(bytes),
      generationJobId: jobId,
    });
    if (!upload.ok) {
      return { ok: false as const, error: upload.errorMessage ?? 'Hedra uploadHedraAsset failed' };
    }
    return { ok: true as const, assetId: create.assetId };
  });
  if (!assetResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: assetResult.error };
  }
  const startKeyframeId = assetResult.assetId;

  // Voice pick (deterministic per (jobId, variantIndex, variantCount)).
  //
  // Polish-21.0.11 hotfix: threads the StructuredCharacter's gender
  // into the roster filter so a male character never lands a female
  // voice and vice versa. Job 1feb8b33 diagnosed Sarah (female)
  // being picked for a male character — the picker rotated the
  // full 5-voice roster blind to character.gender.
  const voice = pickElevenLabsVoiceForVariant({
    variantIndex,
    variantCount,
    jobId,
    characterGender: character.gender,
  });

  // Polish-21.0.13 hotfix: version-stamped diagnostic log so the
  // next production diagnostic answers "did the deploy pick up the
  // gender-aware voice picker?" from a single log line. Job
  // 0bb2d35d confirmed the pre-21.0.11 build was still live in
  // prod (composite row missing compression:{} block + gendered
  // voice pick) — the tag guarantees the operator can spot a
  // stale deploy without needing to grep source revisions.
  //
  // Emits input (variantIndex + characterGender) AND output
  // (picked voice_id / label / gender) on ONE line — mismatch
  // between characterGender and voice.gender surfaces
  // immediately as `MISMATCH` in the log so future gender
  // regressions can't slip past a passive scan.
  const voiceMatchesCharacter = voice.gender === character.gender || voice.gender === 'neutral';
  console.log(
    `[generate-video-variant] variant ${variantIndex} (hedra) ` +
      `voice-pick [Polish-${POLISH_VERSION}]: ` +
      `input.character_gender=${JSON.stringify(character.gender)} ` +
      `input.variant_index=${variantIndex} ` +
      `input.variant_count=${variantCount} ` +
      `output.voice_id=${voice.id} output.voice_label=${voice.label} ` +
      `output.voice_gender=${voice.gender} ` +
      `match=${voiceMatchesCharacter ? 'OK' : 'MISMATCH'}`,
  );

  // Polish-21.0.14 hotfix: STRUCTURAL failsafe. Job 8fc23e4d
  // (post-Polish-21.0.13 deploy) still landed George (male) on a
  // Julia (female) character with `voice_matches_character_gender:
  // false` written to the row. That's mathematically impossible
  // with the shipped picker — either the deploy was still stale
  // OR a subtle bug lets `voice.gender !== character.gender`
  // slip past the filter. The assertion below makes the failure
  // mode STRUCTURALLY impossible: any future regression that
  // lets a mismatch reach the TTS submit call throws BEFORE we
  // spend on ElevenLabs + Hedra credits + before a wrong-voice
  // ad ships. Neutral voices are exempt (they match either).
  if (!voiceMatchesCharacter) {
    throw new Error(
      `[Polish-${POLISH_VERSION}] voice-pick mismatch: character.gender=${JSON.stringify(
        character.gender,
      )} but picker returned voice.gender=${JSON.stringify(voice.gender)} ` +
        `(voice_id=${voice.id} label=${voice.label}). This should be impossible ` +
        `with the shipped roster filter — check for a stale deploy or a picker ` +
        `refactor that dropped the gender filter. variantIndex=${variantIndex} ` +
        `jobId=${jobId}`,
    );
  }

  // Polish-21.0.4 hotfix: generate TTS audio via ElevenLabs BYOK
  // (replaces Hedra native TTS blocked on voice-UUID availability).
  const ttsResult = await step.run(`elevenlabs-tts-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['elevenlabs']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const tts = await submitElevenLabsTts({
      userId,
      apiKey: keys.elevenlabs!,
      voiceId: voice.id,
      text: script,
      generationJobId: jobId,
    });
    if (!tts.ok || !tts.audio) {
      return {
        ok: false as const,
        error: tts.errorMessage ?? 'ElevenLabs TTS failed',
      };
    }
    // Inngest step.run serializes return values — Uint8Array
    // survives as a base64 string round-trip via JSON.stringify.
    // Encode explicitly here so the downstream step can decode.
    return {
      ok: true as const,
      audioBase64: Buffer.from(tts.audio).toString('base64'),
      contentType: tts.contentType ?? 'audio/mpeg',
      audioBytes: tts.audio.byteLength,
    };
  });
  if (!ttsResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: ttsResult.error };
  }

  // Polish-21.0.4 hardening: loud-log the exact voice + text_prompt +
  // script we're about to send to Hedra + how many audio bytes
  // ElevenLabs produced. Per-variant unconditional log survives
  // first-call diagnostic memoization and is exactly the payload
  // to paste into a Hedra / ElevenLabs support ticket if a submit
  // fails downstream.
  console.log(
    `[generate-video-variant] variant ${variantIndex} (hedra) pre-submit: ` +
      `voice_id=${voice.id} voice_label=${voice.label} ` +
      `audio_bytes=${ttsResult.audioBytes} ` +
      `text_prompt_chars=${sceneDescription.length} ` +
      `text_prompt_head=${JSON.stringify(sceneDescription.slice(0, 200))} ` +
      `script_chars=${script.length} ` +
      `script_head=${JSON.stringify(script.slice(0, 200))}`,
  );

  // Polish-21.0.4: upload the ElevenLabs mp3 as a Hedra audio asset.
  // Two API calls: POST /assets (create) + POST /assets/{id}/upload
  // (multipart bytes). Bundled into one step.run so the Inngest
  // retry boundary matches image asset creation.
  const audioAssetResult = await step.run(`hedra-audio-asset-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['hedra']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const create = await createHedraAsset({
      userId,
      apiKey: keys.hedra!,
      name: `variant-${variantIndex}.mp3`,
      type: 'audio',
      generationJobId: jobId,
    });
    if (!create.ok || !create.assetId) {
      return {
        ok: false as const,
        error: create.errorMessage ?? 'Hedra createHedraAsset (audio) failed',
      };
    }
    const audioBytes = Buffer.from(ttsResult.audioBase64, 'base64');
    const upload = await uploadHedraAsset({
      userId,
      apiKey: keys.hedra!,
      assetId: create.assetId,
      filename: `variant-${variantIndex}.mp3`,
      contentType: ttsResult.contentType,
      bytes: new Uint8Array(audioBytes),
      generationJobId: jobId,
    });
    if (!upload.ok) {
      return {
        ok: false as const,
        error: upload.errorMessage ?? 'Hedra uploadHedraAsset (audio) failed',
      };
    }
    return { ok: true as const, assetId: create.assetId };
  });
  if (!audioAssetResult.ok) {
    return { index: variantIndex, ok: false, costUsd: cost, error: audioAssetResult.error };
  }
  const audioAssetId = audioAssetResult.assetId;

  // Submit generation with start_keyframe_id + audio_id (Polish-21.0.4
  // no longer sends audio_generation).
  const submitResult = await step.run(`hedra-submit-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['hedra']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    // Polish-21.0.9: env-override resolver reads
    // HEDRA_{CHARACTER_3,KLING_V2_STANDARD,KLING_V2_PRO}_MODEL_ID
    // at call time. Passing config.modelParam as the fallback so a
    // future descriptor UUID rotation propagates without a config
    // re-read here.
    const aiModelId = resolveHedraModelIdForVideoModel(model.id, config.modelParam);
    return submitHedraGeneration({
      userId,
      apiKey: keys.hedra!,
      aiModelId,
      // Polish-21.0.10 hotfix: per-model extras merged into
      // generated_video_inputs. Character 3 opts into
      // `{enhance_prompt: false}` via ModelProviderConfig; Kling
      // Avatar v2 variants pass undefined so Hedra's Kling backend
      // doesn't reject the submit with `unrecognized_arguments:
      // enhance_prompt`.
      extraGeneratedVideoInputs: config.hedraExtraGeneratedVideoInputs,
      startKeyframeId,
      // Polish-21.0.4 hotfix: audio_id path (ElevenLabs mp3
      // uploaded as Hedra audio asset). Replaces the .0.1/.0.2/.0.3
      // native-TTS tts:{voiceId,text} attempts — those failed on
      // Hedra's `voice_asset ... not found` because built-in voice
      // UUIDs aren't available on Creator plans.
      audioAssetId,
      textPrompt: sceneDescription,
      resolution: '720p',
      aspectRatio: '9:16',
      // Polish-21.0.3 hotfix: duration_ms is REQUIRED by Hedra
      // (docs say optional; reality returns 422 "Field required" —
      // see hedra-video.ts HedraSubmitGenerationInput JSDoc).
      // Source: Polish-19.3.1 auto-resolved target duration. The
      // client clamps to [1000ms, 90000ms] on the wire.
      durationSeconds: targetSeconds,
      generationJobId: jobId,
    });
  });
  if (!submitResult.ok || !submitResult.generationId) {
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        'errorMessage' in submitResult
          ? (submitResult.errorMessage ?? 'Hedra submit failed')
          : 'error' in submitResult
            ? submitResult.error
            : 'Hedra submit failed',
    };
  }
  const generationId = submitResult.generationId;

  // Step 7: poll until terminal.
  await step.sleep(`hedra-warmup-${variantIndex}`, `${HEDRA_POLL_WARMUP_SECONDS}s`);
  let downloadUrl: string | undefined;
  let outputAssetId: string | undefined;
  let pollError: string | undefined;
  // Polish-21.0.2: track consecutive 404s during the initial poll
  // window. Job 1db50a7c saw a fast 189ms 404 on the first poll
  // even though the URL is verified correct against three sources
  // (docs page + hedra-labs/hedra-api-starter + hedra-labs/hedra-node
  // SDK). Most plausible cause: eventual-consistency between submit
  // and status endpoints. We absorb the window here so a single
  // early 404 doesn't fail the variant.
  let consecutive404s = 0;
  // Polish-21.0.10: per-model poll budget from the descriptor.
  // Character 3 finishes 30-90s (80 polls plenty); Kling Avatar
  // v2 Standard/Pro run 5-6 minutes and need more headroom or
  // they time out on generations that would have succeeded.
  const pollMaxAttempts = model.hedraPollMaxAttempts ?? HEDRA_POLL_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    const poll = await step.run(`hedra-poll-${variantIndex}-${attempt}`, async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['hedra']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message };
        throw err;
      }
      return pollHedraGeneration({
        userId,
        apiKey: keys.hedra!,
        generationId,
        generationJobId: jobId,
      });
    });
    if (!('status' in poll) && !('notFound' in poll)) {
      pollError = 'error' in poll ? poll.error : 'Hedra poll failed with no status';
      break;
    }
    // Polish-21.0.2: 404 during initial window → "not queryable yet"
    // keep polling. Persistent 404s → real error, fail the variant.
    if ('notFound' in poll && poll.notFound) {
      consecutive404s += 1;
      if (consecutive404s > HEDRA_POLL_MAX_INITIAL_404S) {
        pollError =
          `Hedra status endpoint returned 404 for generation ${generationId} ` +
          `on ${consecutive404s} consecutive polls (>${HEDRA_POLL_MAX_INITIAL_404S} limit). ` +
          `URL verified against docs + hedra-labs/hedra-api-starter + hedra-labs/hedra-node; ` +
          `probable causes: generation was deleted upstream, API key lacks read scope, ` +
          `or the generation_id in the submit response is not the poll id. ` +
          `Check the first-404 log emitted by hedra-video.ts for the full response body.`;
        break;
      }
      await step.sleep(`hedra-wait-${variantIndex}-${attempt}`, `${HEDRA_POLL_INTERVAL_SECONDS}s`);
      continue;
    }
    consecutive404s = 0;
    if (!poll.ok) {
      pollError = poll.errorMessage ?? 'Hedra poll failed';
      break;
    }
    // Polish-21.0.10 hardening: use the shared terminal-error
    // predicate so `cancelled` short-circuits the loop the same
    // way `error` does. Also loud-log the exact Hedra
    // error_message + status BEFORE breaking so the operator sees
    // the failure attribution on the very first Inngest log line
    // rather than only in the aggregated variant error.
    if (poll.status && isFailedHedraStatus(poll.status)) {
      pollError = poll.errorMessage ?? `Hedra reported ${poll.status}`;
      console.log(
        `[generate-video-variant] variant ${variantIndex} (hedra): terminal ${poll.status} ` +
          `after ${attempt + 1} poll(s). generationId=${generationId} ` +
          `hedra_error_message=${JSON.stringify(poll.errorMessage ?? '(none)')}`,
      );
      break;
    }
    if (poll.status === 'complete') {
      if (poll.downloadUrl) {
        downloadUrl = poll.downloadUrl;
        outputAssetId = poll.assetId;
        break;
      }
      pollError = poll.errorMessage ?? 'Hedra complete without download URL';
      break;
    }
    // queued / processing / pending / finalizing → keep polling
    await step.sleep(`hedra-wait-${variantIndex}-${attempt}`, `${HEDRA_POLL_INTERVAL_SECONDS}s`);
  }

  // Bill on submit-to-terminal even if we time out — Hedra charges
  // credits when Character 3 starts, not when we retrieve the output.
  cost += targetSeconds * config.usdPerSecond;

  if (!downloadUrl) {
    console.log(
      `[generate-video-variant] variant ${variantIndex} (hedra): timed out after ` +
        `${pollMaxAttempts} polls (model=${model.id}). generationId=${generationId} ` +
        `last_error=${pollError ?? 'unset'}`,
    );
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        `Hedra generation ${generationId} did not reach terminal state within ` +
        `${pollMaxAttempts} polls (${model.displayName}).` +
        (pollError ? ` Last error: ${pollError}` : ''),
    };
  }

  // Step 8: mirror the mp4 to Supabase Storage.
  //
  // Polish-21.0.11 hotfix: compress via ffmpeg (libx264 CRF 25 +
  // aac 128kbps + faststart) BEFORE the Supabase upload. Kling
  // Avatar v2 Standard 30s 720p output is ~60-100MB — well past
  // the operator's 50MB Supabase bucket cap. Character 3 outputs
  // are smaller but the same compression step is a strict win
  // (lower egress, faster page loads). Missing ffmpeg or a
  // non-zero exit falls back to the raw buffer gracefully — see
  // compressVideoBuffer's contract.
  //
  // Polish-21.0.12: fetch + compress + upload live in ONE
  // step.run boundary on purpose. Splitting the compress out to
  // its own step (per the Polish-21.0.12 spec's initial proposal)
  // would require serializing the compressed buffer (~5-30MB
  // post-compress, ~60-100MB pre-compress) across the Inngest
  // step boundary — Inngest step outputs are JSON-serialized and
  // size-capped (~4MB per step). Passing a Buffer between steps
  // would either OOM the serialization or need an intermediate
  // storage backend (Blob store, unbounded-cap bucket). Keeping
  // the three phases inside one step.run:
  //   - preserves the retry unit (transient Hedra CDN blips
  //     retry the whole download → compress → upload chain,
  //     which is idempotent)
  //   - avoids the buffer-serialization cliff
  //   - keeps the ffmpeg-installer binary + tmpdir local to one
  //     Inngest step handler execution
  // Compression telemetry (original_size_bytes /
  // compressed_size_bytes / compression_ms / was_compressed /
  // compression_error) still lands on the composite row so the
  // operator's dashboard can pivot on the compress phase without
  // needing a separate step.
  // Polish-21.0.13: version-stamped log BEFORE + AFTER the
  // compress+upload step so the operator can prove from
  // production logs whether (a) the deploy is on the compressing
  // build and (b) whether ffmpeg-installer's binary was actually
  // resolved at runtime. Job 0bb2d35d landed a NULL compression
  // block in the composite row — the pre-log stamps "attempt"
  // and the post-log stamps the exact stats + fallback state.
  console.log(
    `[generate-video-variant] variant ${variantIndex} (hedra) ` +
      `compress-upload BEGIN [Polish-${POLISH_VERSION}]: ` +
      `model_id=${model.id} remote_url_host=${(() => {
        try {
          return new URL(downloadUrl).host;
        } catch {
          return '(unparseable)';
        }
      })()} compress=true`,
  );
  const upload = await step.run(`hedra-upload-video-${variantIndex}`, async () =>
    uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: downloadUrl,
      filename: `video-${model.id}-${variantIndex}-composite`,
      compress: true,
    }),
  );
  console.log(
    `[generate-video-variant] variant ${variantIndex} (hedra) ` +
      `compress-upload END [Polish-${POLISH_VERSION}]: ` +
      `model_id=${model.id} ` +
      `original_size_bytes=${upload.originalBytes} ` +
      `compressed_size_bytes=${upload.sizeBytes} ` +
      `compression_ms=${upload.compressionMs} ` +
      `was_compressed=${upload.wasCompressed}` +
      (upload.compressionError
        ? ` compression_error=${JSON.stringify(upload.compressionError)}`
        : ''),
  );

  // Step 9: write generated_creatives composite row. Hedra is
  // single-call so isClipPart: false and no per-segment rows.
  await step.run(`hedra-insert-composite-${variantIndex}`, async () => {
    const db = getDb();
    await db.insert(schema.generatedCreatives).values({
      userId,
      generationJobId: jobId,
      fileUrl: upload.publicUrl,
      aspectRatio: '9:16',
      status: 'ready_for_review',
      format: `video_${model.id}`,
      isClipPart: false,
      generationMetadata: {
        variant_index: variantIndex,
        model_id: model.id,
        provider_id: config.providerId,
        hedra_generation_id: generationId,
        hedra_input_asset_id: startKeyframeId,
        hedra_audio_asset_id: audioAssetId,
        hedra_output_asset_id: outputAssetId ?? null,
        reference_image_url: referenceImageUrl ?? null,
        // Polish-21.0.4 hotfix: voice source is ElevenLabs, not
        // Hedra native TTS. Voice metadata below refers to the
        // ElevenLabs voice used for the uploaded audio asset.
        tts_provider: 'elevenlabs',
        voice_id: voice.id,
        voice_label: voice.label,
        voice_gender: voice.gender,
        voice_age: voice.age,
        // Polish-21.0.13: durable record of the gender-match
        // outcome on every variant row. Lets the operator SQL /
        // dashboard-query for `voice_matches_character_gender =
        // false` across every job without scraping Inngest logs.
        //
        // Polish-21.0.14: broadened to accept neutral voices as
        // "match" (they pair with either character gender). The
        // structural-failsafe assertion above already throws on a
        // real mismatch, so this column being `false` on ANY
        // shipped row now indicates a stale deploy — every row
        // that reaches the insert step must have passed the
        // failsafe.
        voice_matches_character_gender:
          voice.gender === character.gender || voice.gender === 'neutral',
        // Polish-21.0.14: durable version stamp per composite
        // row. Lets operators SQL for `polish_version = '21.0.14'`
        // to prove the deploy carrying the aggressive ffmpeg
        // preset + voice failsafe actually reached prod. No more
        // "did the redeploy stick?" guessing after a diagnostic.
        // Polish-21.0.15: read from the shared @mbb/shared
        // constant so the version bump cascades every downstream
        // (worker + /api/health + /api/version) without hand-
        // editing string literals in three places.
        polish_version: POLISH_VERSION,
        // Polish-21.0.5 hotfix: log the character block Claude
        // produced (used to compose the Nano Banana JOHN prompt)
        // so operators can grep for AI-CGI regressions and inspect
        // which character shape produced a given output.
        character,
        nano_banana_prompt_chars: imagePrompt.length,
        text_prompt: sceneDescription,
        script,
        duration_seconds: targetSeconds,
        segment_count_requested: 1,
        segment_count_generated: 1,
        stitched: false,
        // Polish-21.0.11 → Polish-21.0.12: compression forensics.
        // Nested `compression: {}` block per operator spec so the
        // metadata dashboard can pull one path from every variant
        // row instead of grepping flat upload_* fields. `was_
        // compressed=false` + `compression_error` set means the
        // helper fell back to raw upload — most common cause is
        // ffmpeg binary missing on Vercel runtime (fixed in
        // Polish-21.0.12 by @ffmpeg-installer/ffmpeg dep +
        // resolveFfmpegPath chain).
        compression: {
          original_size_bytes: upload.originalBytes,
          compressed_size_bytes: upload.sizeBytes,
          compression_ms: upload.compressionMs,
          was_compressed: upload.wasCompressed,
          compression_error: upload.compressionError ?? null,
        },
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: upload.publicUrl };
}

/**
 * Pick a voice for this variant. Deterministic per (jobId, variantCount)
 * — retries of the same job produce identical picks. Falls back to
 * `getDefaultElevenLabsVoice()` when pickElevenLabsVoicesForBatch
 * returns fewer entries than expected (defensive; the roster is
 * fixed at 5 preset ElevenLabs voices).
 *
 * Polish-21.0.4 hotfix: renamed from pickHedraVoiceForVariant.
 * The roster is now ElevenLabs preset UUIDs (not Hedra native).
 *
 * Polish-21.0.11 hotfix: `characterGender` filters the roster to
 * matching-gender voices FIRST — job 1feb8b33 diagnosed a female
 * voice (Sarah) landing on a male character because the picker
 * rotated the full roster blind to Claude's character.gender
 * output. Filter → rotate → pick.
 */
export function pickElevenLabsVoiceForVariant(input: {
  variantIndex: number;
  variantCount: number;
  jobId: string;
  /**
   * Polish-21.0.11: character gender from the StructuredCharacter
   * block Claude emits in the Hedra ad spec.
   *
   * Polish-21.0.13 hotfix: NO LONGER OPTIONAL at the runtime
   * layer. Job 0bb2d35d symptom (female character got George,
   * male voice) matches the failure mode where `character.gender`
   * is silently undefined at the call site — a silent fall-
   * through would rotate the full 5-voice roster and land George
   * on variant 0 for many jobId hashes. Callers MUST pass
   * character.gender; undefined throws with a clear message so
   * the regression surfaces on the first variant instead of
   * shipping wrong-voice ads. The typescript signature is kept
   * optional so legacy tests without a character block still
   * compile, but the runtime check fires either way.
   */
  characterGender?: CharacterVoiceGender;
}): ElevenLabsVoiceRosterEntry {
  // Polish-21.0.13 hardening: fail-loud on missing characterGender.
  // No silent default.
  if (input.characterGender == null) {
    throw new Error(
      'pickElevenLabsVoiceForVariant: characterGender is required (Polish-21.0.13). ' +
        'A silent fall-through to the full roster rotation is what caused job 0bb2d35d ' +
        `to land a male voice on a female character. ` +
        `variantIndex=${input.variantIndex} jobId=${input.jobId}`,
    );
  }
  const offset = computeElevenLabsVoiceOffsetForJob(input.jobId);
  const picks = pickElevenLabsVoicesForBatch(
    Math.max(1, input.variantCount),
    offset,
    undefined,
    input.characterGender,
  );
  if (picks.length > 0) {
    return picks[input.variantIndex % picks.length]!;
  }
  const fallback = getDefaultElevenLabsVoice();
  if (!fallback) {
    throw new Error('ElevenLabs voice roster returned no voices and no default is set.');
  }
  return fallback;
}

/** @deprecated Use pickElevenLabsVoiceForVariant. */
export const pickHedraVoiceForVariant = pickElevenLabsVoiceForVariant;

/**
 * Polish-21 Commit 2: Claude ad-spec for Hedra Character 3.
 *
 * Character 3 produces motion from the audio track — long camera
 * choreography prompts fight the model. This prompt asks for a
 * SHORT (~50-80 word) scene description + a matching script, one
 * scene per variant (no segments[] fan-out).
 *
 * Dropped from the Polish-20.0.3 kie.ai prompt:
 *   - segments[] structure (Character 3 is single-call)
 *   - sound_texture field (Hedra handles audio via native TTS)
 *   - word-count calibration per segment (single-call = fixed length
 *     from audio duration, not from prompt word count)
 *   - speaker attribution boilerplate ("She says: ..." templates)
 *   - motion / camera choreography beats
 *
 * Kept:
 *   - Polish-19.4.2 verbatim source-script preservation
 *   - Polish-20.0.3 sanitized source_analysis (no draft_prompt leak)
 *   - Photoreal amateur smartphone selfie aesthetic anchor
 */
async function runClaudeAdSpecHedra(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  variantCount: number;
  jobMetadata: Record<string, unknown> | null;
  model: VideoModel;
}): Promise<
  | { ok: true; spec: VideoAdSpecHedra; costUsd: number }
  | { ok: false; error: string; costUsd: number }
> {
  const { userId, jobId, variantIndex, variantCount, jobMetadata, model } = input;
  let keys;
  try {
    keys = await loadDecryptedKeys(userId, ['claude']);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }

  const sourceScriptVerbatim = extractSourceScriptVerbatim(jobMetadata);
  const sanitizedSourceAnalysis = sanitizeSourceAnalysisForClaude(jobMetadata);

  const systemPrompt =
    `You write ${model.displayName} scene prompts + Nano Banana character sheets for short UGC ` +
    `talking-head video ads. Output ONLY valid JSON matching the schema below — no markdown ` +
    `fences, no preamble, no trailing prose.\n\n` +
    `REQUIRED SCHEMA:\n` +
    `{\n` +
    `  "scene": {\n` +
    `    "scene_description": "50-80 words. ONE flowing paragraph. Yapper style — CAN contain 'She says: <hook>' inside the paragraph as narrative framing (Hedra treats scene_description as text_prompt, so speaker attribution reads as scene context, not spoken content). See ANCHOR.",\n` +
    `    "script": "The words the character speaks aloud. NO stage directions, NO speaker attribution — this string goes verbatim to ElevenLabs TTS, so 'She says:' would be spoken literally."\n` +
    `  },\n` +
    `  "character": {\n` +
    `    "name": "First name only. Fictional — no public figure.",\n` +
    `    "age": 68,\n` +
    `    "nationality": "American / British / Filipino / …",\n` +
    `    "gender": "male" | "female",\n` +
    `    "demographic_role": "e.g. 'suburban grandmother', 'working dad', 'young professional', 'retiree'. Used inside the SKIN REALISM MANDATE + the CRITICAL ANTI-CELEBRITY DIRECTIVE + the 'looks like a TV {role} character, regenerate' self-check.",\n` +
    `    "hair_bullet": "SHORT bullet — length + color + styling, ending with 'slightly messy, NOT styled' or 'NOT symmetrical'. e.g. 'Shoulder-length salt-and-pepper hair, slightly messy, NOT styled, NOT symmetrical'.",\n` +
    `    "eye_asymmetry_bullet": "ONE specific eye-line asymmetry. e.g. 'Slightly uneven eye line — one eyelid drooping slightly more than the other (natural aging)'.",\n` +
    `    "nose_bullet": "ONE specific nose imperfection. e.g. 'Ordinary nose — slightly wider than average, with a small bump on the bridge'.",\n` +
    `    "mouth_bullet": "Mouth asymmetry / downturn detail. e.g. 'Thin lips, slightly asymmetric mouth, natural slight downturn on the left side'.",\n` +
    `    "eye_color_and_age_detail": "Eye color + age-specific detail. e.g. 'Warm hazel eyes with visible crow\\'s feet and slight bags underneath'.",\n` +
    `    "jaw_bullet": "Jawline with subtle imperfection (jowls, softness, weak chin). e.g. 'Soft jawline with mild jowls (age-appropriate)'.",\n` +
    `    "face_shape_bullet": "Face shape with 'NOT chiseled' or 'NOT model-shaped' qualifier. e.g. 'Oval face, NOT chiseled, NOT model-shaped, natural fullness at cheeks'.",\n` +
    `    "clothing_bullet": "SPECIFIC clothing item + material + wear condition. e.g. 'Faded navy cotton crewneck with honest wear at the neckline'.",\n` +
    `    "setting_paragraph": "Sitting/standing scene with SPECIFIC furniture / props + light source. e.g. 'Sitting at a slightly cluttered morning kitchen table — coffee mug and unopened mail behind her, warm natural window light from off-camera. Cozy lived-in feel.'",\n` +
    `    "skin_age_appropriate_detail": "Age-appropriate skin imperfections woven together as ONE phrase. e.g. 'faint age spots on cheekbones, small broken capillaries near the nose, natural crow\\'s feet at the outer eye corners'.",\n` +
    `    "skin_color_for_stubble": "grey" | "brown" | "black" | "blonde" | "red" | "none",\n` +
    `    "anti_celeb_actress_examples": ["8-12 age-appropriate actress names the face MUST NOT resemble. e.g. ['Meryl Streep', 'Helen Mirren', 'Jane Fonda', 'Diane Keaton', 'Sally Field', 'Goldie Hawn', 'Susan Sarandon', 'Glenn Close', 'Judi Dench', 'Maggie Smith']"],\n` +
    `    "anti_celeb_news_examples": ["4-6 news anchor / talk show host names. e.g. ['Barbara Walters', 'Diane Sawyer', 'Katie Couric', 'Oprah', 'Ellen DeGeneres']"],\n` +
    `    "anti_celeb_politician_examples": ["4-6 political figure / spouse names. e.g. ['Hillary Clinton', 'Nancy Pelosi', 'Barbara Bush', 'Michelle Obama']"]\n` +
    `  }\n` +
    `}\n\n` +
    `HOW ${model.displayName} WORKS (context so you write for the model, not against it):\n` +
    `- Character 3 is an image-to-talking-avatar model. It receives ONE reference image ` +
    `(a photoreal selfie of the character) + audio TTS of the script, and produces natural ` +
    `body movement, gestures, head shifts, and phoneme-accurate lip-sync.\n` +
    `- Motion, camera work, gestures — Character 3 handles all of these FROM THE AUDIO. ` +
    `Do NOT write camera moves, motion beats, gesture choreography, or shot-list bullets. ` +
    `Those fight the model.\n` +
    `- The scene_description is a STATIC scene anchor. Describe what a photo of this ` +
    `moment would show, then trust Character 3 to animate it.\n\n` +
    `SCENE FORMAT — HARD REQUIREMENTS:\n` +
    `- scene_description is ONE flowing paragraph. NO bracketed sections. ` +
    `NO **Camera Shot:**, NO **Actions:**, NO **Dialogue:**, NO **Character:**, ` +
    `NO "Setting:"/"Lighting:"/"Framing:" labels. If source_analysis contains this ` +
    `bracketed style, IGNORE it — do NOT copy the structure.\n` +
    `- 50-80 words for scene_description. Longer = wasted tokens on choreography ` +
    `Character 3 ignores.\n` +
    `- Template: "A {age}-year-old {gender} films herself/himself {location} — {specific ` +
    `framing: 'dashboard-mounted phone chest-up' / 'bathroom mirror selfie' / 'kitchen ` +
    `tripod'}. {Lighting: 'warm afternoon sunlight through the driver's side window' etc}. ` +
    `{Character context tied to source ad emotional register: 'confessional TikTok energy, ` +
    `like venting to a friend on FaceTime' / 'excited announcement to camera' / 'quiet ` +
    `vulnerable moment'}. She/He says: '{verbatim source hook + variation}'. Natural ` +
    `micro-expressions. Vertical 9:16."\n\n` +
    `CHARACTER FORMAT — HARD REQUIREMENTS (Linda pattern — Polish-21.0.7 verified working):\n` +
    `- ITEMIZED BULLETS in every physical-feature field. NOT flowing paragraphs. Nano Banana ` +
    `Pro renders bullets sharper than paragraphs — paragraph anchors get averaged out, ` +
    `bullets keep the specific imperfection intact.\n` +
    `- Every bullet MUST contain a SPECIFIC imperfection: droopy eyelid, bump on nose bridge, ` +
    `asymmetric mouth, mild jowls, natural downturn, etc. Symmetrical / model-shaped defaults ` +
    `read as AI-CGI on Nano Banana.\n` +
    `- Clothing MUST be a specific item + material + wear condition: "faded navy cotton ` +
    `crewneck with honest wear at the neckline". NO pristine outfits, NO designer brands.\n` +
    `- ANTI-CELEBRITY arrays MUST list 8-12 actress names (age-appropriate to the character), ` +
    `4-6 news anchors, 4-6 politicians. These names go verbatim into the CRITICAL ANTI-` +
    `CELEBRITY DIRECTIVE block downstream — Nano Banana pattern-matches to famous faces by ` +
    `default and needs the named examples to steer AWAY from them.\n` +
    `- Aim for ANONYMOUS, not ATTRACTIVE. The face should look like a RANDOM ` +
    `{demographic_role} you'd walk past on the street and forget. NOT a model. NOT a TV ` +
    `character.\n` +
    `- skin_color_for_stubble drives the SKIN REALISM MANDATE line downstream. Pick 'none' ` +
    `for a smooth-shaven or female face, otherwise pick the color that matches the hair.\n` +
    `- demographic_role is used in three places downstream: the SKIN REALISM MANDATE ` +
    `("must look like a real {age}-year-old {role}, not a model..."), the anti-celebrity ` +
    `directive ("looks like a TV {role} character, regenerate"), and the lead ` +
    `("Generic {role} appearance"). Pick something a stranger would say if asked "who's that ` +
    `in the video".\n\n` +
    `WORKED EXAMPLE (Polish-21.0.7 Linda anchor — the yapper scene + itemized character the ` +
    `operator manually verified working on Hedra Character 3 + Nano Banana Pro):\n` +
    `{\n` +
    `  "scene": {\n` +
    `    "scene_description": "A 68-year-old woman films herself at her cluttered kitchen table — dashboard-style phone chest-up, warm morning window light. Confessional TikTok energy, like venting to a friend on FaceTime. She says: 'I swear to god, I was spending $80 a month on face serums that did NOTHING.' Natural micro-expressions. Vertical 9:16.",\n` +
    `    "script": "I swear to god, I was spending $80 a month on face serums that did NOTHING. Zero. Nada. Like, honestly? I finally figured it out — and I wish I'd known sooner."\n` +
    `  },\n` +
    `  "character": {\n` +
    `    "name": "Linda",\n` +
    `    "age": 68,\n` +
    `    "nationality": "American",\n` +
    `    "gender": "female",\n` +
    `    "demographic_role": "suburban grandmother",\n` +
    `    "hair_bullet": "Shoulder-length salt-and-pepper hair, slightly messy, NOT styled, NOT symmetrical",\n` +
    `    "eye_asymmetry_bullet": "Slightly uneven eye line — one eyelid drooping slightly more than the other (natural aging)",\n` +
    `    "nose_bullet": "Ordinary nose — slightly wider than average, with a small bump on the bridge",\n` +
    `    "mouth_bullet": "Thin lips, slightly asymmetric mouth, natural slight downturn on the left side",\n` +
    `    "eye_color_and_age_detail": "Warm hazel eyes with visible crow\\'s feet and slight bags underneath",\n` +
    `    "jaw_bullet": "Soft jawline with mild jowls (age-appropriate)",\n` +
    `    "face_shape_bullet": "Oval face, NOT chiseled, NOT model-shaped, natural fullness at cheeks",\n` +
    `    "clothing_bullet": "Faded navy cotton crewneck with honest wear at the neckline",\n` +
    `    "setting_paragraph": "Sitting at a slightly cluttered morning kitchen table — coffee mug and unopened mail behind her, warm natural window light from off-camera. Cozy lived-in feel.",\n` +
    `    "skin_age_appropriate_detail": "faint age spots on cheekbones, small broken capillaries near the nose, natural crow\\'s feet at the outer eye corners",\n` +
    `    "skin_color_for_stubble": "none",\n` +
    `    "anti_celeb_actress_examples": ["Meryl Streep", "Helen Mirren", "Jane Fonda", "Diane Keaton", "Sally Field", "Goldie Hawn", "Susan Sarandon", "Glenn Close", "Judi Dench", "Maggie Smith"],\n` +
    `    "anti_celeb_news_examples": ["Barbara Walters", "Diane Sawyer", "Katie Couric", "Oprah", "Ellen DeGeneres"],\n` +
    `    "anti_celeb_politician_examples": ["Hillary Clinton", "Nancy Pelosi", "Barbara Bush", "Michelle Obama"]\n` +
    `  }\n` +
    `}\n\n` +
    `SOURCE-SCRIPT PRESERVATION (Polish-19.4.2 rule — this is NOT verbatim quoting, ` +
    `preserve what MADE the source ad win while varying the wrapper):\n` +
    `- PRESERVE from source: hook openers ("I swear to god", "You will NOT believe"), ` +
    `dollar amounts, ALL CAPS emphasis words, filler words (like, honestly, literally), ` +
    `ellipses, natural stammers, key product/offer phrases.\n` +
    `- ADAPT: character demographics (age, gender, ethnicity, outfit), setting/location, ` +
    `non-essential specifics — for variant differentiation.\n\n` +
    `HARD CONSTRAINTS:\n` +
    `- Single character, single static scene, single camera framing.\n` +
    `- Photoreal amateur smartphone selfie aesthetic. NOT 3D, NOT animated, NOT CGI, ` +
    `NOT cinematic.\n` +
    `- Character is a fictional everyperson with no resemblance to any public figure.\n` +
    `- The script is what gets SPOKEN. No stage directions, no on-screen text, no captions.\n\n` +
    `THIS REQUEST: this is variant ${variantIndex} of ${variantCount} in a batch. ` +
    `Differentiate from other variants by adapting the character demographics + setting ` +
    `+ tone while preserving the source's hooks and key phrases.`;

  const userMessage = JSON.stringify({
    source_script_verbatim: sourceScriptVerbatim,
    source_analysis: sanitizedSourceAnalysis,
    model_id: model.id,
    variant_index: variantIndex,
    variant_count: variantCount,
  });
  const claude = await callClaude({
    userId,
    apiKey: keys.claude!,
    systemPrompt,
    userMessage,
    // Polish-21.0.5: 50-80 word scene + short script + JOHN-pattern
    // character block (~200-400 tokens for the naturalistic
    // paragraphs). Bumped from 2048 to 4096 to leave headroom for
    // Claude to write vivid character detail without truncating.
    maxTokens: 4096,
    generationJobId: jobId,
  });
  if (!claude.ok) {
    return {
      ok: false,
      error: claude.errorMessage ?? 'Claude Hedra ad-spec call failed',
      costUsd: claude.costUsd,
    };
  }
  const rawText = (claude.text ?? '').trim();
  if (!rawText) {
    return { ok: false, error: 'Claude returned an empty Hedra ad spec', costUsd: claude.costUsd };
  }
  const parsed = parseVideoAdSpecHedra(rawText);
  if (!parsed) {
    console.log(
      `[generate-video-variant] variant ${variantIndex} (hedra): scene JSON failed to parse; ` +
        `raw text: ${rawText.slice(0, 500)}`,
    );
    return {
      ok: false,
      error: 'Claude returned an unparseable Hedra scene spec',
      costUsd: claude.costUsd,
    };
  }
  // Polish-21.0.1 hardening (job 52923be6 diagnostic): reject
  // suspiciously short scene_description / script values.
  //
  // Before this gate, Claude occasionally emitted a very-short
  // scene_description like "Aged Man" (picked up from the
  // source_analysis subject demographic hints) and the parser silently
  // accepted it. The Hedra submit then sent "Aged Man" as text_prompt,
  // producing a generation whose character bore no resemblance to the
  // intended scene. 40 chars is generous — the target is 50-80 WORDS
  // (~250-400 chars); anything under 40 chars is clearly malformed.
  const gateResult = validateHedraSpecMinLengths(parsed);
  if (!gateResult.ok) {
    console.log(
      `[generate-video-variant] variant ${variantIndex} (hedra): spec rejected by ` +
        `length gate. reason=${gateResult.reason} scene_description=${JSON.stringify(
          parsed.scene.scene_description,
        )} script=${JSON.stringify(parsed.scene.script)}`,
    );
    return { ok: false, error: gateResult.reason, costUsd: claude.costUsd };
  }
  return { ok: true, spec: parsed, costUsd: claude.costUsd };
}

/**
 * Polish-21.0.1 hardening: minimum-length gate on the parsed Hedra
 * ad spec. Rejects the suspiciously-short scene_description /
 * script values that leaked through Commit 2 (job 52923be6 saw
 * "Aged Man" as scene_description — 8 chars — passed to Hedra as
 * text_prompt).
 *
 * The Claude prompt asks for 50-80 WORDS of scene_description
 * (~250-400 chars); this gate catches responses under 40 chars
 * without touching legitimate short-script variants (a hook line
 * like "You'll NEVER guess." is ~19 chars but the SCENE
 * description shouldn't be).
 */
export const HEDRA_MIN_SCENE_DESCRIPTION_CHARS = 40;
export const HEDRA_MIN_SCRIPT_CHARS = 8;

export function validateHedraSpecMinLengths(
  // Polish-21.0.5: only reads scene fields — narrow the type to
  // `{scene: VideoAdScene}` so callers can pass a scene-only fixture
  // without threading a full VideoAdSpecHedra (with the newly-
  // required character block).
  spec: { scene: VideoAdScene },
): { ok: true } | { ok: false; reason: string } {
  const { scene_description, script } = spec.scene;
  if (scene_description.trim().length < HEDRA_MIN_SCENE_DESCRIPTION_CHARS) {
    return {
      ok: false,
      reason:
        `Claude returned a scene_description that is too short ` +
        `(${scene_description.trim().length} chars, need ≥${HEDRA_MIN_SCENE_DESCRIPTION_CHARS}). ` +
        `Retry the job. If it persists, check the Claude prompt for a source_analysis leak.`,
    };
  }
  if (script.trim().length < HEDRA_MIN_SCRIPT_CHARS) {
    return {
      ok: false,
      reason:
        `Claude returned a script that is too short ` +
        `(${script.trim().length} chars, need ≥${HEDRA_MIN_SCRIPT_CHARS}). Retry the job.`,
    };
  }
  return { ok: true };
}

// -------------------------------------------------------------------
// Per-segment runner
// -------------------------------------------------------------------

interface SegmentSuccess {
  ok: true;
  segmentIndex: number;
  publicUrl: string;
  taskId: string;
  promptChars: number;
  costUsd: number;
}
interface SegmentFailure {
  ok: false;
  segmentIndex: number;
  error: string;
  costUsd: number;
  taskId?: string;
}
type SegmentResult = SegmentSuccess | SegmentFailure;

async function runOneSegment(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  jobId: string;
  userId: string;
  variantIndex: number;
  segmentIndex: number;
  segmentPrompt: string;
  model: VideoModel;
  config: ModelProviderConfig;
  durationSeconds: number;
}): Promise<SegmentResult> {
  const {
    step,
    jobId,
    userId,
    variantIndex,
    segmentIndex,
    segmentPrompt,
    model,
    config,
    durationSeconds,
  } = input;
  const segLabel = `${variantIndex}-${segmentIndex}`;
  let cost = 0;

  const submitResult = await step.run(`kie-video-submit-${segLabel}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['kie_ai']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    const submit = await submitKieVideo({
      userId,
      apiKey: keys.kie_ai!,
      config,
      prompt: segmentPrompt,
      durationSeconds,
      aspectRatio: '9:16',
      audio: true,
      generationJobId: jobId,
    });
    if (!submit.ok || !submit.taskId) {
      return {
        ok: false as const,
        error: submit.errorMessage ?? 'kie.ai createTask failed',
      };
    }
    return { ok: true as const, taskId: submit.taskId };
  });
  if (!submitResult.ok) {
    return { ok: false, segmentIndex, costUsd: cost, error: submitResult.error };
  }

  await step.sleep(`kie-video-warmup-${segLabel}`, `${POLL_WARMUP_SECONDS}s`);
  let outputUrl: string | undefined;
  let pollError: string | undefined;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await step.run(`kie-video-poll-${segLabel}-${attempt}`, async () => {
      let keys;
      try {
        keys = await loadDecryptedKeys(userId, ['kie_ai']);
      } catch (err) {
        if (err instanceof MissingProviderKeyError)
          return { ok: false as const, error: err.message };
        throw err;
      }
      return pollKieVideo({
        userId,
        apiKey: keys.kie_ai!,
        taskId: submitResult.taskId,
        modelId: model.id,
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
    if (poll.state === 'success') {
      if (poll.outputUrl) {
        outputUrl = poll.outputUrl;
        break;
      }
      pollError = poll.errorMessage ?? 'kie.ai success without an output URL';
      break;
    }
    if (poll.state === 'fail') {
      pollError = poll.failMsg ?? poll.failCode ?? 'kie.ai generation failed';
      break;
    }
    // state === 'waiting'
    await step.sleep(
      `kie-video-wait-${segLabel}-${attempt}`,
      `${computeVideoPollIntervalSeconds(attempt)}s`,
    );
  }

  // Bill on submit-to-success (kie.ai charges when the generation
  // completes even if we time out on the poll).
  cost += durationSeconds * getKieVideoUsdPerSecond(config);

  if (!outputUrl) {
    console.log(
      `[generate-video-variant] segment ${segLabel} timed out / failed after ` +
        `${POLL_MAX_ATTEMPTS} polls. taskId=${submitResult.taskId} ` +
        `last_error=${pollError ?? 'unset'}`,
    );
    return {
      ok: false,
      segmentIndex,
      costUsd: cost,
      taskId: submitResult.taskId,
      error:
        `kie.ai task ${submitResult.taskId} (segment ${segmentIndex}) did not reach ` +
        `terminal state within ${POLL_MAX_ATTEMPTS} polls.` +
        (pollError ? ` Last error: ${pollError}` : ''),
    };
  }

  const uploadResult = await step.run(`upload-video-${segLabel}`, async () =>
    uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: outputUrl!,
      filename: `video-${model.id}-${variantIndex}-seg-${segmentIndex}`,
    }),
  );

  return {
    ok: true,
    segmentIndex,
    publicUrl: uploadResult.publicUrl,
    taskId: submitResult.taskId,
    promptChars: segmentPrompt.length,
    costUsd: cost,
  };
}

// -------------------------------------------------------------------
// Stitch (Polish-19.3 pattern)
// -------------------------------------------------------------------

const STITCH_POLL_INTERVAL_SECONDS = 8;
const STITCH_POLL_MAX_ATTEMPTS = 45;

async function runStitch(input: {
  step: Parameters<Parameters<typeof inngest.createFunction>[2]>[0]['step'];
  segmentUrls: string[];
  userId: string;
  jobId: string;
  variantIndex: number;
}): Promise<
  { ok: true; publicUrl: string; costUsd: number } | { ok: false; error: string; costUsd: number }
> {
  const { step, segmentUrls, userId, jobId, variantIndex } = input;

  const submit = await step.run(`video-stitch-submit-${variantIndex}`, async () => {
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
      `video-stitch-wait-${variantIndex}-${attempt}`,
      `${STITCH_POLL_INTERVAL_SECONDS}s`,
    );
    const tick = await step.run(`video-stitch-poll-${variantIndex}-${attempt}`, async () => {
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

  const upload = await step.run(`video-stitch-upload-${variantIndex}`, async () => {
    try {
      const u = await uploadGeneratedVideoFromUrl({
        userId,
        jobId,
        remoteUrl: stitchedUrl!,
        filename: `video-${variantIndex}-composite`,
      });
      return { ok: true as const, publicUrl: u.publicUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });
  const publicUrl = upload.ok ? upload.publicUrl : stitchedUrl;
  return { ok: true, publicUrl, costUsd: stitchCost };
}

// -------------------------------------------------------------------
// Claude ad-spec (Polish-19.4.2 shape, per-model word-count calibrated)
// -------------------------------------------------------------------

async function runClaudeAdSpec(input: {
  userId: string;
  jobId: string;
  variantIndex: number;
  jobMetadata: Record<string, unknown> | null;
  model: VideoModel;
  segmentCount: number;
  targetSeconds: number;
}): Promise<
  { ok: true; adSpec: VideoAdSpec; costUsd: number } | { ok: false; error: string; costUsd: number }
> {
  const { userId, jobId, variantIndex, jobMetadata, model, segmentCount, targetSeconds } = input;
  let keys;
  try {
    keys = await loadDecryptedKeys(userId, ['claude']);
  } catch (err) {
    if (err instanceof MissingProviderKeyError) {
      return { ok: false, error: err.message, costUsd: 0 };
    }
    throw err;
  }

  const sourceScriptVerbatim = extractSourceScriptVerbatim(jobMetadata);
  const { min: minWords, max: maxWords } = computeWordCountRangePerSegment(model);
  const sanitizedSourceAnalysis = sanitizeSourceAnalysisForClaude(jobMetadata);

  const systemPrompt =
    `You write ${model.displayName} prompts for short UGC video ads. Output ONLY valid JSON ` +
    `matching the schema below — no markdown fences, no preamble, no trailing prose.\n\n` +
    `REQUIRED SCHEMA:\n` +
    `{\n` +
    `  "segments": [\n` +
    `    {\n` +
    `      "index": 0,\n` +
    `      "prompt": "One continuous paragraph of yapper-style prose (see FORMAT + WORKED EXAMPLE below)",\n` +
    `      "sound_texture": "Close-mic iPhone front-camera compression, faint room tone, no music."\n` +
    `    }\n` +
    `    // one entry per segment; each segment is ${model.maxSingleCallSeconds}s (${model.displayName}'s per-call cap)\n` +
    `  ]\n` +
    `}\n\n` +
    `FORMAT — HARD REQUIREMENTS (Polish-20.0.3 regression pin):\n` +
    `- Every segment.prompt is ONE FLOWING PARAGRAPH of natural yapper-style prose. NO bracketed sections. NO **Camera Shot:**, NO **Actions:**, NO **Dialogue:**, NO **Character:**, NO "Setting:" / "Lighting:" / "Framing:" labels. If the source_analysis input contains this bracketed style, IGNORE that structure — DO NOT copy it.\n` +
    `- The prose weaves scene, character, action, dialogue, and audio texture together in one paragraph, like you're describing a video you just watched to a friend.\n\n` +
    `STRUCTURE PER segment.prompt (weave these together into ONE paragraph — NOT numbered sections):\n` +
    `1. Visual scene (who: age-range, gender, ethnicity, outfit; where: room/setting; lighting; framing — UGC iPhone selfie hand-held, NOT studio, NOT cinematic).\n` +
    `2. Speaker attribution + spoken dialogue in quotes. Templates: "She says: '...'" / "He confesses: '...'" / "She whispers: '...'" / "He half-laughs: '...'". Pick attribution matching the emotional beat.\n` +
    `3. Acoustic texture line woven into the prose (repeat the sound_texture field's content inside the prompt — the model reads audio cues from the prompt body, not adjacent JSON).\n\n` +
    `WORKED EXAMPLE (yapper-style prose the models respond to — Polish-20.0.3 anchor):\n` +
    `"A 34-year-old white woman with light brown hair films herself in the driver's seat of a parked dark-interior SUV, dashboard-mounted phone framing her chest-up, steady tripod-style. She's mid-conversation, hand gesturing as she lists things, picking up like she's telling her friend a story. Warm afternoon sunlight through the driver's side window catches her face. She says in an exhausted-but-relieved conversational tone, like venting to a friend on FaceTime: 'I swear to god, I was spending $80 a month on face serums that did NOTHING. Zero. Nada.' Close-mic dashboard-camera compression, faint car interior room tone, distant parking lot ambient noise, no music. Raw iPhone footage aesthetic, TikTok confessional energy, no-filter realism, natural handheld micro-jitter, vertical 9:16."\n\n` +
    `WORD COUNT PER SEGMENT (HARD LIMITS — going over breaks the yapping pace and looks fake):\n` +
    `- Every segment: ${minWords}-${maxWords} words of dialogue, natural yapping pace ~170wpm (${model.maxSingleCallSeconds}s per call × 170wpm / 60).\n` +
    `- Word count = spoken words inside the quotes ONLY (excludes speaker attribution + visual/sound description).\n\n` +
    `SOURCE-SCRIPT PRESERVATION (this is NOT verbatim quoting — preserve what MADE the source ad win while varying the wrapper):\n` +
    `- PRESERVE: hook openers ("I swear to god", "You will NOT believe"), dollar amounts, ALL CAPS emphasis words, filler words (like, honestly, literally), ellipses, natural stammers, key product/offer phrases from the source.\n` +
    `- ADAPT: character demographics, setting details, non-essential specifics for variant differentiation.\n\n` +
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
    `SOUND TEXTURE EXAMPLES (pick one matching the visual scene; weave verbatim into the prompt AND emit in sound_texture):\n` +
    `- "Close-mic iPhone front-camera compression, faint room tone, no music."\n` +
    `- "Handheld iPhone audio, faint traffic outside, no music, slight bathroom tile echo."\n` +
    `- "Static tripod audio, air conditioner hum in background, no music."\n\n` +
    `THIS REQUEST: return EXACTLY ${segmentCount} segment${segmentCount === 1 ? '' : 's'} ` +
    `for a ${targetSeconds}s ad on ${model.displayName}. This variant is index ${variantIndex} — ` +
    `differentiate from other variants by adapting the character demographics and setting while preserving the source's hooks and key phrases.`;

  // Polish-20.0.3: sanitize source_analysis so Claude only sees the
  // vision-derived scene/subject fields — NOT the Sora-era
  // draft_prompt blob (which used to bleed bracketed section styling
  // into Claude's output on job 395cc9b7). We keep the raw script
  // verbatim at the top level so PRESERVE rules still fire.
  const userMessage = JSON.stringify({
    source_script_verbatim: sourceScriptVerbatim,
    source_analysis: sanitizedSourceAnalysis,
    target_duration_seconds: targetSeconds,
    target_segment_count: segmentCount,
    model_id: model.id,
    model_max_seconds_per_call: model.maxSingleCallSeconds,
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
  const parsed = parseVideoAdSpec(rawText);
  if (parsed) return { ok: true, adSpec: parsed, costUsd: claude.costUsd };
  console.log(
    `[generate-video-variant] variant ${variantIndex}: segments[] JSON failed to parse; ` +
      `falling back to single-segment wrap. Claude returned: ${rawText.slice(0, 500)}`,
  );
  return { ok: true, adSpec: fallbackToSingleSegment(rawText), costUsd: claude.costUsd };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Clamp per-call seconds to what the model's API will accept. Seedance
 * 1.5 Pro: [4, 12] step 2 (round to nearest even ≥ 4). Kling: [3, 15].
 * Seedance 2: [4, 15].
 */
export function clampPerCallSeconds(model: VideoModel, seconds: number): number {
  const s = Math.max(1, Math.round(seconds));
  if (model.id === 'seedance_1_5_pro') {
    // step 2 → round up to nearest even ≥ 4
    const min = 4;
    const max = 12;
    if (s <= min) return min;
    if (s >= max) return max;
    return s % 2 === 0 ? s : Math.min(max, s + 1);
  }
  if (model.id === 'kling_3_standard') {
    return Math.max(3, Math.min(15, s));
  }
  if (model.id === 'seedance_2') {
    return Math.max(4, Math.min(15, s));
  }
  // Unknown model — fall back to the descriptor cap.
  return Math.max(1, Math.min(model.maxSingleCallSeconds, s));
}

function getKieVideoUsdPerSecond(config: ModelProviderConfig): number {
  return config.usdPerSecond;
}
