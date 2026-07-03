import { Buffer } from 'node:buffer';
import { eq } from 'drizzle-orm';
import {
  callClaude,
  callGeminiImage,
  checkReplicateConcat,
  createHedraAsset,
  isVideoConcatEnabled,
  pollHedraGeneration,
  pollKieVideo,
  submitHedraGeneration,
  submitKieVideo,
  submitReplicateConcat,
  uploadHedraAsset,
} from '@mbb/ai-providers';
import {
  computeHedraVoiceOffsetForJob,
  computeSegmentCountForModel,
  getDefaultHedraVoice,
  getModelProviderConfig,
  getVideoModel,
  isHedraVoiceRosterUncurated,
  pickHedraVoicesForBatch,
  type HedraVoiceRosterEntry,
  type ModelProviderConfig,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@mbb/shared';
import { getDb, schema } from '@mbb/db';
import { extractMetadataObject } from './analyze-concept';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedImage, uploadGeneratedVideoFromUrl } from '../lib/storage';

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
  // Polish-21 Commit 2: dispatch. Hedra Character 3 is single-call
  // image-to-talking-avatar — completely different flow (asset upload,
  // native TTS, no segments, no concat). Legacy kie.ai path stays
  // through Commit 3 for backwards-compat with in-flight jobs.
  if (input.model.id === 'hedra_character_3') {
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
 * Polish-21: single-scene ad spec for Character 3 (one scene per
 * variant since Character 3 is single-call). Replaces the
 * Polish-20 `VideoAdSpec.segments[]` structure.
 */
export interface VideoAdSpecHedra {
  scene: VideoAdScene;
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
  // Accept either {scene: {...}} or a flat {scene_description, script}
  // shape. Claude occasionally emits the flat shape when only one
  // scene is asked for.
  if (v.scene && typeof v.scene === 'object' && !Array.isArray(v.scene)) {
    return validateSceneBody(v.scene as Record<string, unknown>);
  }
  return validateSceneBody(v);
}

function validateSceneBody(body: Record<string, unknown>): VideoAdSpecHedra | null {
  const sd = body['scene_description'];
  const sc = body['script'];
  if (typeof sd !== 'string' || sd.length === 0) return null;
  if (typeof sc !== 'string' || sc.length === 0) return null;
  return { scene: { scene_description: sd, script: sc } };
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
const HEDRA_POLL_MAX_ATTEMPTS = 80;
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

  // Voice roster gate — Polish-21 Commit 2 ships with named voices,
  // so this returns false. Kept as a defensive check in case a
  // future accidental roster wipe would silently no-op the batch.
  if (isHedraVoiceRosterUncurated()) {
    return {
      index: variantIndex,
      ok: false,
      costUsd: 0,
      error:
        'Hedra voice roster is empty. Populate HEDRA_VOICE_ROSTER in ' +
        'packages/shared/src/video-models.ts via scripts/hedra-list-voices.mjs.',
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
    // Character 3 keyframe: photoreal amateur smartphone selfie
    // framing matching the scene description. Vertical 9:16 for
    // downstream Hedra output aspect.
    const imagePrompt =
      `Photoreal amateur smartphone selfie photograph, vertical 9:16 framing, ` +
      `chest-up. Scene: ${sceneDescription}. Natural lighting, no filters, no text ` +
      `overlays, no captions, no watermarks. Fictional everyperson with no ` +
      `resemblance to any public figure. TikTok confessional aesthetic — raw ` +
      `iPhone footage look, subtle handheld micro-jitter cue. Single character in frame.`;
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
  const voice = pickHedraVoiceForVariant({ variantIndex, variantCount, jobId });

  // Polish-21.0.1 hardening (job 52923be6 diagnostic): loud-log the
  // exact text_prompt + script + voice_id we're about to send to
  // Hedra. The hedra-video client already logs a first-call
  // diagnostic per (kind, aiModelId) tuple, but that fires only
  // ONCE per worker cold-start — subsequent submits are silent.
  // This per-variant log fires on EVERY submit so a future
  // regression (short scene_description, wrong field mapping,
  // voice-id-vs-name confusion) surfaces in Inngest logs without
  // needing to re-run for a first-call fire.
  console.log(
    `[generate-video-variant] variant ${variantIndex} (hedra) pre-submit: ` +
      `voice_id=${voice.id} voice_label=${voice.label} ` +
      `text_prompt_chars=${sceneDescription.length} ` +
      `text_prompt_head=${JSON.stringify(sceneDescription.slice(0, 200))} ` +
      `script_chars=${script.length} ` +
      `script_head=${JSON.stringify(script.slice(0, 200))}`,
  );

  // Step 6: submit generation.
  const submitResult = await step.run(`hedra-submit-${variantIndex}`, async () => {
    let keys;
    try {
      keys = await loadDecryptedKeys(userId, ['hedra']);
    } catch (err) {
      if (err instanceof MissingProviderKeyError) return { ok: false as const, error: err.message };
      throw err;
    }
    return submitHedraGeneration({
      userId,
      apiKey: keys.hedra!,
      aiModelId: config.modelParam,
      startKeyframeId,
      // Polish-21.0.1 hotfix: `voiceId` field carries a Hedra voice
      // UUID (from HEDRA_VOICE_ROSTER). Commit 2 mistakenly sent
      // names ("Jessica", "Matilda") in this field and Hedra 422'd
      // with `invalid literal for int() with base 10: 'jessica-a'`.
      // The single-entry Polish-21.0.1 roster carries the confirmed
      // hedra-labs/hedra-api-starter UUID; Polish-21.0.2 restores
      // the multi-voice batch diversity once Hedra support delivers
      // the full built-in UUID list.
      tts: { voiceId: voice.id, text: script },
      textPrompt: sceneDescription,
      resolution: '720p',
      aspectRatio: '9:16',
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
  for (let attempt = 0; attempt < HEDRA_POLL_MAX_ATTEMPTS; attempt++) {
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
    if (poll.status === 'error') {
      pollError = poll.errorMessage ?? 'Hedra reported error';
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
    // queued / processing / pending → keep polling
    await step.sleep(`hedra-wait-${variantIndex}-${attempt}`, `${HEDRA_POLL_INTERVAL_SECONDS}s`);
  }

  // Bill on submit-to-terminal even if we time out — Hedra charges
  // credits when Character 3 starts, not when we retrieve the output.
  cost += targetSeconds * config.usdPerSecond;

  if (!downloadUrl) {
    console.log(
      `[generate-video-variant] variant ${variantIndex} (hedra): timed out after ` +
        `${HEDRA_POLL_MAX_ATTEMPTS} polls. generationId=${generationId} ` +
        `last_error=${pollError ?? 'unset'}`,
    );
    return {
      index: variantIndex,
      ok: false,
      costUsd: cost,
      error:
        `Hedra generation ${generationId} did not reach terminal state within ` +
        `${HEDRA_POLL_MAX_ATTEMPTS} polls.` +
        (pollError ? ` Last error: ${pollError}` : ''),
    };
  }

  // Step 8: mirror the mp4 to Supabase Storage.
  const upload = await step.run(`hedra-upload-video-${variantIndex}`, async () =>
    uploadGeneratedVideoFromUrl({
      userId,
      jobId,
      remoteUrl: downloadUrl,
      filename: `video-${model.id}-${variantIndex}-composite`,
    }),
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
        hedra_output_asset_id: outputAssetId ?? null,
        reference_image_url: referenceImageUrl ?? null,
        voice_id: voice.id,
        voice_label: voice.label,
        voice_gender: voice.gender,
        voice_age: voice.age,
        text_prompt: sceneDescription,
        script,
        duration_seconds: targetSeconds,
        segment_count_requested: 1,
        segment_count_generated: 1,
        stitched: false,
      },
    });
  });

  return { index: variantIndex, ok: true, costUsd: cost, fileUrl: upload.publicUrl };
}

/**
 * Pick a voice for this variant. Deterministic per (jobId, variantCount)
 * — retries of the same job produce identical picks. Falls back to
 * `getDefaultHedraVoice()` when pickHedraVoicesForBatch returns fewer
 * entries than expected (defensive; the roster is fixed at 6).
 */
export function pickHedraVoiceForVariant(input: {
  variantIndex: number;
  variantCount: number;
  jobId: string;
}): HedraVoiceRosterEntry {
  const offset = computeHedraVoiceOffsetForJob(input.jobId);
  const picks = pickHedraVoicesForBatch(Math.max(1, input.variantCount), offset);
  if (picks.length > 0) {
    return picks[input.variantIndex % picks.length]!;
  }
  const fallback = getDefaultHedraVoice();
  if (!fallback) {
    throw new Error('Hedra voice roster returned no voices and no default is set.');
  }
  return fallback;
}

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
    `You write ${model.displayName} scene prompts for short UGC talking-head video ads. ` +
    `Output ONLY valid JSON matching the schema below — no markdown fences, no preamble, ` +
    `no trailing prose.\n\n` +
    `REQUIRED SCHEMA:\n` +
    `{\n` +
    `  "scene": {\n` +
    `    "scene_description": "50-80 words describing setting + character + tone + framing + lighting. ONE paragraph, no bracketed sections.",\n` +
    `    "script": "The words the character speaks aloud (this is TTS audio, not on-screen text)."\n` +
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
    `FORMAT — HARD REQUIREMENTS:\n` +
    `- scene_description is ONE flowing paragraph. NO bracketed sections. ` +
    `NO **Camera Shot:**, NO **Actions:**, NO **Dialogue:**, NO **Character:**, ` +
    `NO "Setting:"/"Lighting:"/"Framing:" labels. If source_analysis contains this ` +
    `bracketed style, IGNORE it — do NOT copy the structure.\n` +
    `- 50-80 words for scene_description. Longer = wasted tokens on choreography ` +
    `Character 3 ignores.\n` +
    `- The scene_description weaves together (in one paragraph): setting/location, ` +
    `character (age range, gender, ethnicity, outfit, brief persona hint), tone/energy, ` +
    `camera framing (chest-up UGC iPhone selfie, tripod-style or hand-held), lighting mood.\n` +
    `- script is the words spoken aloud only. NO stage directions, NO speaker attribution ` +
    `("She says:", "He confesses:") — the whole thing IS the speech.\n\n` +
    `WORKED EXAMPLE (Polish-21 anchor — this is the yapper-style scene + script the ` +
    `operator manually tested on Hedra Character 3):\n` +
    `{\n` +
    `  "scene": {\n` +
    `    "scene_description": "A 34-year-old woman with light brown hair sits in the driver's seat of a parked dark-interior SUV, chest-up dashboard-mounted phone framing, tripod-style stability. Warm afternoon sunlight through the driver's side window catches her face. Confessional TikTok tone, like venting to a friend on FaceTime. Raw iPhone selfie aesthetic, no filter, casual outfit.",\n` +
    `    "script": "I swear to god, I was spending $80 a month on face serums that did NOTHING. Zero. Nada. Like, honestly? I finally figured it out — and I wish I'd known sooner."\n` +
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
    `+ tone while preserving the source's hooks and key phrases. Target duration is set by ` +
    `the audio Character 3 generates from your script — aim for a script whose read ` +
    `length matches the source ad pacing.`;

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
    // 50-80 word scene + a short script ≈ 300 tokens; cap modestly.
    maxTokens: 2048,
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
  spec: VideoAdSpecHedra,
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
