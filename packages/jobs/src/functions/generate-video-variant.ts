import { eq } from 'drizzle-orm';
import {
  callClaude,
  checkReplicateConcat,
  isVideoConcatEnabled,
  pollKieVideo,
  submitKieVideo,
  submitReplicateConcat,
} from '@mbb/ai-providers';
import {
  computeSegmentCountForModel,
  getModelProviderConfig,
  getVideoModel,
  type ModelProviderConfig,
  type VideoModel,
  type VideoModelId,
  type VideoProviderId,
} from '@mbb/shared';
import { getDb, schema } from '@mbb/db';
import { inngest } from '../client';
import { MissingProviderKeyError, loadDecryptedKeys } from '../lib/load-keys';
import { markJobCompleted, markJobFailed } from '../lib/job-markers';
import { uploadGeneratedVideoFromUrl } from '../lib/storage';

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

    const jobMetadata = (job.metadata ?? null) as Record<string, unknown> | null;
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
            format: `video_${modelId}`,
            isClipPart: false,
            generationMetadata: {
              mock: true,
              variant_index: i,
              model_id: modelId,
              provider_id: providerId,
              duration_seconds: autoDuration.targetSeconds,
              segment_count: autoDuration.segmentCount,
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
        provider: config.providerId === 'kie_ai' ? 'kie_ai' : 'kie_ai',
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
      provider: 'kie_ai',
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
  model: VideoModel;
  config: ModelProviderConfig;
  targetSeconds: number;
  segmentCount: number;
  jobMetadata: Record<string, unknown> | null;
}

async function runOneVariant(input: RunOneVariantInput): Promise<VideoVariantResult> {
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

  const systemPrompt =
    `You write ${model.displayName} prompts for short UGC video ads. Output ONLY valid JSON ` +
    `matching the schema below — no markdown fences, no preamble, no trailing prose.\n\n` +
    `REQUIRED SCHEMA:\n` +
    `{\n` +
    `  "segments": [\n` +
    `    {\n` +
    `      "index": 0,\n` +
    `      "prompt": "Self-contained ${model.displayName} prompt for this segment — visual scene + speaker attribution + dialogue in quotes + acoustic texture line",\n` +
    `      "sound_texture": "Close-mic iPhone front-camera compression, faint room tone, no music."\n` +
    `    }\n` +
    `    // one entry per segment; each segment is ${model.maxSingleCallSeconds}s (${model.displayName}'s per-call cap)\n` +
    `  ]\n` +
    `}\n\n` +
    `STRUCTURE PER segment.prompt (in this order, one paragraph):\n` +
    `1. Visual scene (who: age-range, gender, ethnicity, outfit; where: room/setting; lighting; framing — UGC iPhone selfie hand-held, NOT studio, NOT cinematic).\n` +
    `2. Speaker attribution + spoken dialogue in quotes. Templates: "She says: '...'" / "He confesses: '...'" / "She whispers: '...'" / "He half-laughs: '...'". Pick attribution matching the emotional beat.\n` +
    `3. Acoustic texture line woven into the prose (repeat the sound_texture field's content inside the prompt — the model reads audio cues from the prompt body, not adjacent JSON).\n\n` +
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

  const userMessage = JSON.stringify({
    source_script_verbatim: sourceScriptVerbatim,
    source_analysis: jobMetadata ?? {},
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
