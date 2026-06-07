import { callProvider } from './chokepoint';

/**
 * Polish-9.18: per-clip silence trimming via a generic Replicate
 * ffmpeg model. Slots in between Kling clip generation and the
 * Polish-9.12 stitching step. Each clip gets a trim pass to strip
 * leading/trailing silence before concat, so the final composite
 * has no dead-air at clip boundaries.
 *
 * Same Replicate API surface as replicate-concat.ts: one BYOK key,
 * env-overridable model id, supports both the model-named endpoint
 * (officially-exposed models) and the versioned endpoint (community
 * models like cuuupid/cog-ffmpeg).
 *
 * Disabled by default: REPLICATE_AUDIO_TRIM_MODEL_ID must be set to
 * a known-working slug. When unset the worker skips the trim and
 * passes raw clip URLs to the concat step.
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Per-clip trim cost estimate. Most ffmpeg models on Replicate run a
 * few cents per second of input. Tune via env if the chosen model
 * publishes a different rate.
 */
const TRIM_COST_USD = Number(process.env.REPLICATE_AUDIO_TRIM_COST_USD) || 0.02;

/**
 * Default ffmpeg silenceremove arguments. Trims leading + trailing
 * silence < -50 dB longer than 100 ms. Tuneable via env so the
 * operator can dial threshold/duration without a redeploy.
 */
const DEFAULT_TRIM_ARGS =
  process.env.REPLICATE_AUDIO_TRIM_ARGS ||
  '-af silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB:detection=peak,silenceremove=stop_periods=-1:stop_silence=0.1:stop_threshold=-50dB:detection=peak';

export function getAudioTrimModelId(): string {
  return process.env.REPLICATE_AUDIO_TRIM_MODEL_ID?.trim() || '';
}

export function isAudioTrimEnabled(): boolean {
  return getAudioTrimModelId().length > 0;
}

export interface SubmitAudioTrimInput {
  userId: string;
  apiKey: string;
  videoUrl: string;
  generationJobId?: string;
}

export interface SubmitAudioTrimResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Submit trim. Generic ffmpeg models on Replicate use a variety of
 * input field names — send a shotgun of common shapes and let the
 * model pick whichever it consumes. Replicate silently ignores
 * unknown fields.
 */
export async function submitAudioTrim(input: SubmitAudioTrimInput): Promise<SubmitAudioTrimResult> {
  const raw = getAudioTrimModelId();
  if (!raw) {
    return {
      ok: false,
      modelId: '',
      latencyMs: 0,
      errorMessage: 'REPLICATE_AUDIO_TRIM_MODEL_ID is not set. Audio trim disabled.',
    };
  }
  const colonIdx = raw.indexOf(':');
  const modelPath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : raw.slice(colonIdx + 1).trim();

  const inputFields = {
    // Generic ffmpeg models accept different field names for the
    // source file — send the common ones.
    video: input.videoUrl,
    video_url: input.videoUrl,
    video_file: input.videoUrl,
    input: input.videoUrl,
    input_video: input.videoUrl,
    // Filter/command shotgun — different ffmpeg wrappers expose these.
    command: DEFAULT_TRIM_ARGS,
    args: DEFAULT_TRIM_ARGS,
    ffmpeg_args: DEFAULT_TRIM_ARGS,
    filter: DEFAULT_TRIM_ARGS,
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
      errorMessage: 'Replicate audio-trim response missing prediction id',
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

export interface CheckAudioTrimInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
}

export interface CheckAudioTrimResult {
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/** Single status check for the trim prediction. */
export async function checkAudioTrim(input: CheckAudioTrimInput): Promise<CheckAudioTrimResult> {
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
      costUsd: TRIM_COST_USD,
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
      errorMessage: result.data.error ?? `Replicate audio-trim ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}
