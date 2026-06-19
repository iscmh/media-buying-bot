import { callProvider } from './chokepoint';

/**
 * Polish-12.5: extract the last frame of a video via a Replicate
 * ffmpeg-style model. Same env-configurable pattern as Polish-9.12's
 * replicate-concat — one BYOK Replicate key, the actual model id is
 * configured via REPLICATE_FRAME_EXTRACT_MODEL_ID so the operator
 * can pick a working community model (e.g. lucataco/ffmpeg-utility,
 * fofr/ffmpeg, or similar) without a code redeploy.
 *
 * Disabled by default: when REPLICATE_FRAME_EXTRACT_MODEL_ID is
 * unset, isFrameExtractEnabled() returns false and the caller's
 * worker falls back to using the Nano Banana reference frame for
 * every segment (Polish-12.4 behavior). Chain continuity is a
 * value-add, not a hard requirement.
 *
 * The model is expected to accept a video URL via one of the common
 * input field names (`video`, `video_url`, `input_video`, `file`)
 * and return either a single image URL or `output[0]`. We send the
 * common names defensively so adopting a new model rarely needs a
 * code change.
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Per-extraction cost. Placeholder. Override via env if the chosen
 * model publishes a per-job price. Most Replicate ffmpeg-style
 * utility models charge $0.01–0.03 per call.
 */
const FRAME_EXTRACT_COST_USD = Number(process.env.REPLICATE_FRAME_EXTRACT_COST_USD) || 0.02;

export function getFrameExtractModelId(): string {
  return process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID?.trim() || '';
}

export function isFrameExtractEnabled(): boolean {
  return getFrameExtractModelId().length > 0;
}

export interface SubmitFrameExtractInput {
  userId: string;
  apiKey: string;
  videoUrl: string;
  generationJobId?: string;
}

export interface SubmitFrameExtractResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function submitReplicateFrameExtract(
  input: SubmitFrameExtractInput,
): Promise<SubmitFrameExtractResult> {
  const raw = getFrameExtractModelId();
  if (!raw) {
    return {
      ok: false,
      modelId: '',
      latencyMs: 0,
      errorMessage: 'REPLICATE_FRAME_EXTRACT_MODEL_ID is not set. Frame extraction disabled.',
    };
  }
  const colonIdx = raw.indexOf(':');
  const modelPath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : raw.slice(colonIdx + 1).trim();

  // Defensive field-name spray — different ffmpeg-style models use
  // different input field names. The model silently ignores the
  // ones it doesn't recognize.
  const inputFields = {
    video: input.videoUrl,
    video_url: input.videoUrl,
    input_video: input.videoUrl,
    file: input.videoUrl,
    // Hints for models that take an explicit time spec — most
    // ffmpeg-utility models default to last-frame on omission, but
    // the spec value here is harmless when ignored.
    time: 'last',
    frame: 'last',
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
      kind: 'frame_extract',
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
      errorMessage: 'Replicate frame-extract response missing prediction id',
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

export interface CheckFrameExtractInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
}

export interface CheckFrameExtractResult {
  status: 'processing' | 'completed' | 'failed';
  /** Public URL of the extracted JPG / PNG frame. */
  frameUrl?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function checkReplicateFrameExtract(
  input: CheckFrameExtractInput,
): Promise<CheckFrameExtractResult> {
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
    requestBodyForLog: { prediction_id: input.predictionId, kind: 'frame_extract' },
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
      frameUrl: typeof out === 'string' ? out : undefined,
      costUsd: FRAME_EXTRACT_COST_USD,
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
      errorMessage: result.data.error ?? `Replicate frame-extract ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}
