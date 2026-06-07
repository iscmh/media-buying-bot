import { callProvider } from './chokepoint';

/**
 * Polish-4: Kling cinematic video generation via Replicate.
 *
 * Polish-9.17: bumped default model from kling-v2.5-turbo-pro to
 * kling-v2.6 — the master prompt's [GENERATE NATIVE AUDIO AND LIP-
 * SYNC TO EXACT DIALOGUE] directive was designed for the audio-
 * capable Kling, but 2.5 turbo pro generated silent video. 2.6
 * supports synchronized native audio (speech + ambient + SFX) on
 * the same image-to-video workflow.
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
const KLING_MODEL_DEFAULT = 'kwaivgi/kling-v2.6';
// Polish-9.6: submit just queues the prediction so 30s stays fine;
// check is a single GET so 15s stays fine. The worker bounds the
// poll-loop total time via POLL_INTERVAL × POLL_MAX_ATTEMPTS — see
// generate-kling-multi-clip-variants.ts for that ceiling (now 10 min
// per clip via REPLICATE_POLL_TIMEOUT_MS env override).
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Cost per 5-second 9:16 clip on Replicate's kwaivgi/kling-v2.6
 * (Nov 2026 list price). Bumped from $0.30 (2.5 turbo pro) per
 * Polish-9.17.
 */
const KLING_COST_USD_PER_CLIP = 0.35;

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
  /**
   * Polish-9.8: image-to-video anchor. Public URL to a first-frame PNG
   * (typically Nano Banana output) that Kling uses to lock character
   * identity across clips. The master prompt's `[USE IMAGE X AS
   * STARTING FRAME]` directive depends on this being wired.
   */
  startImageUrl?: string;
  /**
   * Polish-9.18: override the default negative prompt. Caller passes a
   * full string; default DEFAULT_KLING_NEGATIVE_PROMPT is used when
   * omitted. Used to suppress burned-in captions + plastic-skin
   * aesthetic + studio look.
   */
  negativePrompt?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

/**
 * Polish-9.18: default negative prompt for every Kling submit. Suppresses:
 *   - burned-in captions / subtitles / on-screen text (Kling auto-burns
 *     these otherwise)
 *   - plastic / airbrushed / over-rendered AI skin look
 *   - cinematic / studio lighting (we want amateur smartphone UGC)
 *   - perfect-symmetry uncanny faces
 *
 * Exported so callers (and tests) can reference / extend it.
 */
export const DEFAULT_KLING_NEGATIVE_PROMPT = [
  'captions, subtitles, closed captions, on-screen text, burned-in text, text overlays, watermarks, logos',
  'smooth skin, plastic skin, plastic look, perfect skin, glossy skin, airbrushed, retouched',
  'over-rendered, hyperreal, glossy, over-saturated, uncanny valley',
  'cinematic lighting, studio lighting, professional photography',
  'symmetric face, perfect symmetry',
].join(', ');

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
  const klingInput: Record<string, unknown> = {
    prompt: input.prompt,
    duration: input.durationSeconds ?? 5,
    aspect_ratio: input.aspectRatio ?? '9:16',
    // Polish-9.17: kling-v2.6 supports synchronized native audio
    // (speech + ambient + SFX). The exact param name varies across
    // Kling deployments — send all four common aliases. Replicate
    // silently ignores unknown input fields.
    enable_audio: true,
    with_audio: true,
    generate_audio: true,
    audio: true,
    // Polish-9.18: suppress burned-in captions + plastic-skin look.
    negative_prompt: input.negativePrompt ?? DEFAULT_KLING_NEGATIVE_PROMPT,
  };
  if (input.startImageUrl) {
    klingInput.start_image = input.startImageUrl;
  }
  const body = { input: klingInput };

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
      duration: klingInput.duration,
      aspect_ratio: klingInput.aspect_ratio,
      has_start_image: !!input.startImageUrl,
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
