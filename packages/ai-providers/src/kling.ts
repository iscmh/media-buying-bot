import { callProvider } from './chokepoint';

/**
 * Polish-4: Kling 2.5 cinematic video generation via Replicate.
 *
 * We treat Replicate as the abstraction (one API key, many models). The
 * specific model slug is overridable via env so we can bump versions
 * without redeploying. Pricing approximately $0.30 per 5-second 9:16
 * clip on kling-v2.5-turbo-pro (May 2026).
 *
 * Pipeline:
 *   1. submitKlingVideo({ prompt, durationSeconds, aspectRatio })
 *      → POST https://api.replicate.com/v1/predictions
 *      Returns predictionId.
 *   2. checkKlingPrediction(predictionId) — polled by the worker every
 *      10–30s until status === 'succeeded' or 'failed'.
 *   3. On success the output is a list of video URLs (Replicate
 *      convention); we take the first.
 *
 * Auth: Authorization: Token <REPLICATE_API_TOKEN> header (Replicate's
 * documented format). Token is the user's BYOK Replicate key, stored
 * in ai_provider_connections.
 *
 * KLING_MODEL_ID env override lets us hot-swap model versions without
 * a redeploy (Replicate ships breaking model updates without backward
 * compatibility, so we want the lever).
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const KLING_MODEL_DEFAULT = 'kwaivgi/kling-v2.5-turbo-pro';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

/** Cost per 5-second 9:16 cinematic clip (USD). Tuneable; reflects May 2026 list price. */
const KLING_COST_USD_PER_CLIP = 0.3;

export function getKlingModelId(): string {
  return process.env.KLING_MODEL_ID?.trim() || KLING_MODEL_DEFAULT;
}

/** Per-clip cost estimate. Used by the form picker before submit. */
export function estimateKlingClipCostUsd(): number {
  return KLING_COST_USD_PER_CLIP;
}

export type KlingPredictionStatus = 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface KlingSubmitInput {
  userId: string;
  apiKey: string;
  /**
   * Cinematic prompt — emitted by buildCinematicPromptFromScript. Should
   * be 60–120 words of concrete visual description (scenes, lighting,
   * camera moves).
   */
  prompt: string;
  durationSeconds?: 5 | 10;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KlingSubmitResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Submit a Kling generation. Returns a predictionId for polling.
 * Replicate's /v1/predictions endpoint accepts a model identifier in
 * the URL path (faster) — we use this rather than the version-hash
 * form to avoid pinning to a stale version.
 */
export async function submitKlingVideo(input: KlingSubmitInput): Promise<KlingSubmitResult> {
  const modelId = getKlingModelId();
  // Replicate's "create-prediction-using-model-version" endpoint shape:
  //   POST /v1/models/{owner}/{name}/predictions
  // It defaults to the latest published version of the model.
  const url = `${REPLICATE_BASE}/v1/models/${modelId}/predictions`;
  const body = {
    input: {
      prompt: input.prompt,
      duration: input.durationSeconds ?? 5,
      aspect_ratio: input.aspectRatio ?? '9:16',
    },
  };

  const result = await callProvider<{
    id?: string;
    status?: string;
    error?: string;
  }>({
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
      model_id: modelId,
      prompt_chars: input.prompt.length,
      duration: body.input.duration,
      aspect_ratio: body.input.aspect_ratio,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      modelId,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  const predictionId = result.data.id;
  if (!predictionId) {
    return {
      ok: false,
      modelId,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: 'Replicate response did not include a prediction id',
    };
  }
  return {
    ok: true,
    predictionId,
    modelId,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

export interface KlingCheckInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KlingCheckResult {
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  rawStatus?: KlingPredictionStatus;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/** Single status check. Worker polls via Inngest step.sleep. */
export async function checkKlingPrediction(input: KlingCheckInput): Promise<KlingCheckResult> {
  const url = `${REPLICATE_BASE}/v1/predictions/${encodeURIComponent(input.predictionId)}`;
  const result = await callProvider<{
    status?: KlingPredictionStatus;
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

  const data = result.data;
  const raw = data.status;
  if (raw === 'succeeded') {
    // Replicate normalizes single-output models to a string; multi-output
    // returns an array. Take the first URL either way.
    const url = Array.isArray(data.output) ? data.output[0] : data.output;
    return {
      status: 'completed',
      videoUrl: typeof url === 'string' ? url : undefined,
      costUsd: KLING_COST_USD_PER_CLIP,
      rawStatus: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
    };
  }
  if (raw === 'failed' || raw === 'canceled') {
    return {
      status: 'failed',
      costUsd: 0,
      rawStatus: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: data.error ?? `Kling prediction ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    rawStatus: raw,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

export type KlingErrorCategory =
  | 'auth' // 401/403 — bad/revoked Replicate key
  | 'credits' // 402/429 — out of credits or rate-limited
  | 'model_missing' // 404 — model id wrong or unpublished
  | 'timeout'
  | 'server'
  | 'unknown';

export function classifyKlingError(
  status: number | undefined,
  message: string | undefined,
): KlingErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'credits';
  if (status === 404) return 'model_missing';
  if (status === 0 && /timeout|aborted/i.test(message ?? '')) return 'timeout';
  if (typeof status === 'number' && status >= 500) return 'server';
  return 'unknown';
}
