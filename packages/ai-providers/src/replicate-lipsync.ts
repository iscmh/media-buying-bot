import { callProvider } from './chokepoint';

/**
 * Polish-11: Replicate lipsync layer. After Kling generates silent
 * clips and they're stitched into a silent composite, ElevenLabs
 * produces one continuous voiceover from the full Section C dialogue,
 * and this client submits the silent composite + audio to a Replicate
 * lipsync model. The resulting lip-synced MP4 is the final deliverable.
 *
 * Same versioned/unversioned model id convention as replicate-concat.ts
 * + replicate-audio-trim.ts: env value parsed for an optional
 * `:VERSION_HASH` suffix.
 *
 * Disabled by default — REPLICATE_LIPSYNC_MODEL_ID must be set. When
 * unset the worker writes the silent composite as the final and skips
 * lipsync; per-clip + composite rows still persist.
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Conservative per-job lipsync estimate. Most lipsync models on
 * Replicate charge $0.05-0.20 per output second. Tune via env.
 */
const LIPSYNC_COST_USD = Number(process.env.REPLICATE_LIPSYNC_COST_USD) || 1.0;

export function getLipsyncModelId(): string {
  return process.env.REPLICATE_LIPSYNC_MODEL_ID?.trim() || '';
}

export function isLipsyncEnabled(): boolean {
  return getLipsyncModelId().length > 0;
}

export interface SubmitLipsyncInput {
  userId: string;
  apiKey: string;
  videoUrl: string;
  audioUrl: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface SubmitLipsyncResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Submit a lipsync job. Lipsync model input schemas vary — send a
 * shotgun of common video / audio field names (Replicate silently
 * ignores unknown fields).
 */
export async function submitLipsync(input: SubmitLipsyncInput): Promise<SubmitLipsyncResult> {
  const raw = getLipsyncModelId();
  if (!raw) {
    return {
      ok: false,
      modelId: '',
      latencyMs: 0,
      errorMessage: 'REPLICATE_LIPSYNC_MODEL_ID is not set. Lipsync disabled.',
    };
  }
  const colonIdx = raw.indexOf(':');
  const modelPath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : raw.slice(colonIdx + 1).trim();

  const inputFields = {
    // Video field aliases.
    video: input.videoUrl,
    video_url: input.videoUrl,
    video_file: input.videoUrl,
    face: input.videoUrl,
    face_video: input.videoUrl,
    // Audio field aliases.
    audio: input.audioUrl,
    audio_url: input.audioUrl,
    audio_file: input.audioUrl,
    speech: input.audioUrl,
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
    generatedCreativeId: input.generatedCreativeId,
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
      errorMessage: 'Replicate lipsync response missing prediction id',
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

export interface CheckLipsyncInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface CheckLipsyncResult {
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function checkLipsync(input: CheckLipsyncInput): Promise<CheckLipsyncResult> {
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
    generatedCreativeId: input.generatedCreativeId,
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
      costUsd: LIPSYNC_COST_USD,
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
      errorMessage: result.data.error ?? `Replicate lipsync ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}
