import { callProvider } from './chokepoint';

/**
 * Polish-9.12: stitch a list of clip URLs into one composite MP4 via
 * a Replicate ffmpeg-concat model. Same Replicate API surface as the
 * Kling cinematic model (one BYOK key, env-overridable model id) so
 * we don't need a separate provider type.
 *
 * Disabled by default: REPLICATE_VIDEO_CONCAT_MODEL_ID must be set to
 * a known-working model slug. The worker logs a clear "stitching
 * skipped" message when unset so the operator (you) can enable it
 * after verifying the model exists on Replicate. Per-clip rows are
 * still written either way — stitching is a value-add layer.
 *
 * Output handling: most concat models return either a single string
 * URL or an array of one URL — we handle both shapes (same convention
 * as checkKlingPrediction).
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Per-job cost estimate for stitching. Placeholder — actual cost
 * depends on the chosen model. Override via env if your concat model
 * publishes a per-second or per-job price.
 */
const STITCH_COST_USD = Number(process.env.REPLICATE_STITCH_COST_USD) || 0.15;

export function getVideoConcatModelId(): string {
  return process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID?.trim() || '';
}

export function isVideoConcatEnabled(): boolean {
  return getVideoConcatModelId().length > 0;
}

export interface SubmitConcatInput {
  userId: string;
  apiKey: string;
  videoUrls: string[];
  generationJobId?: string;
}

export interface SubmitConcatResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Submit concat. The input field name varies across Replicate ffmpeg
 * models (`videos`, `video_urls`, `clips`, `video_files`). Sending all
 * four covers the common cases — extra fields are silently ignored.
 *
 * Polish-9.14: support both Replicate prediction endpoints.
 *   - "owner/name"           → POST /v1/models/{owner}/{name}/predictions
 *                              (officially-exposed models like Kling)
 *   - "owner/name:VERSION"   → POST /v1/predictions with { version, input }
 *                              (community models like idan054/better-
 *                              video-merge, which return 404 on the
 *                              model-named endpoint)
 */
export async function submitReplicateConcat(input: SubmitConcatInput): Promise<SubmitConcatResult> {
  const raw = getVideoConcatModelId();
  if (!raw) {
    return {
      ok: false,
      modelId: '',
      latencyMs: 0,
      errorMessage: 'REPLICATE_VIDEO_CONCAT_MODEL_ID is not set. Stitching disabled.',
    };
  }
  const colonIdx = raw.indexOf(':');
  const modelPath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : raw.slice(colonIdx + 1).trim();

  const inputFields = {
    videos: input.videoUrls,
    video_urls: input.videoUrls,
    clips: input.videoUrls,
    // idan054/better-video-merge uses this field name.
    video_files: input.videoUrls,
  };

  const url = version
    ? `${REPLICATE_BASE}/v1/predictions`
    : `${REPLICATE_BASE}/v1/models/${modelPath}/predictions`;
  const body = version ? { version, input: inputFields } : { input: inputFields };
  const result = await callProvider<{ id?: string; error?: string }>({
    userId: input.userId,
    provider: 'kling',
    url,
    method: 'POST',
    headers: {
      Authorization: `Token ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model_id: modelPath,
      version: version || undefined,
      clip_count: input.videoUrls.length,
    },
    generationJobId: input.generationJobId,
  });
  if (!result.ok) {
    return {
      ok: false,
      modelId: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  const predictionId = result.data.id;
  if (!predictionId) {
    return {
      ok: false,
      modelId: raw,
      latencyMs: result.latencyMs,
      errorMessage: 'Replicate concat response missing prediction id',
    };
  }
  return {
    ok: true,
    predictionId,
    modelId: raw,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

export interface CheckConcatInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
}

export interface CheckConcatResult {
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/** Single status check for the concat prediction. */
export async function checkReplicateConcat(input: CheckConcatInput): Promise<CheckConcatResult> {
  const url = `${REPLICATE_BASE}/v1/predictions/${encodeURIComponent(input.predictionId)}`;
  const result = await callProvider<{
    status?: string;
    output?: string | string[];
    error?: string;
  }>({
    userId: input.userId,
    provider: 'kling',
    url,
    method: 'GET',
    headers: { Authorization: `Token ${input.apiKey}` },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { prediction_id: input.predictionId },
    generationJobId: input.generationJobId,
  });
  if (!result.ok) {
    return {
      status: 'failed',
      costUsd: 0,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  const raw = result.data.status;
  if (raw === 'succeeded') {
    const out = Array.isArray(result.data.output) ? result.data.output[0] : result.data.output;
    return {
      status: 'completed',
      videoUrl: typeof out === 'string' ? out : undefined,
      costUsd: STITCH_COST_USD,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
    };
  }
  if (raw === 'failed' || raw === 'canceled') {
    return {
      status: 'failed',
      costUsd: 0,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.data.error ?? `Replicate concat ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}
