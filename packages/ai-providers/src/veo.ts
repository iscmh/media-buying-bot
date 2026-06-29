import { callProvider } from './chokepoint';

/**
 * Polish-19.2: Veo 3.1 Fast video generation client.
 *
 * Native-audio single-call video generation via Google's Gemini
 * Developer API. Replaces the Polish-19 Kling Avatar v2 pipeline
 * (image + audio + lipsync chain) with a single model that emits
 * dialogue + ambient + SFX natively from a text prompt. Uses the
 * existing BYOK Gemini key the Polish-12.x Omni Flash worker
 * already relies on — no new provider connection needed.
 *
 * Endpoint pattern (Gemini Developer API long-running operations):
 *   - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
 *     body: { instances: [{ prompt }], parameters: { ... } }
 *     response: { name: "operations/abc" }
 *   - GET https://generativelanguage.googleapis.com/v1beta/{name}
 *     response: { done: bool, response?: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } }
 *
 * Auth: `x-goog-api-key` header (same as gemini-client.ts).
 *
 * Pricing (per Google's public preview pricing): $0.15 per second
 * of generated output. 8s max per call. Polish-19.2 ships single-
 * chunk path only; multi-chunk chaining (whether via a Veo Extend
 * endpoint or via Replicate ffmpeg-concat stitching of N independent
 * 8s clips) lands as Polish-19.3 after the basic API flow is
 * verified live.
 *
 * IMPORTANT — UNKNOWN-IN-FIELD pieces, env-overridable so a wrong
 * default is a config flip not a redeploy:
 *   - VEO_MODEL_ID — defaults to 'veo-3.1-fast'. Google's preview
 *     model names have changed multiple times. If 404 surfaces with
 *     "model not found", override this env var without code changes.
 *   - VEO_USD_PER_SECOND — defaults to 0.15. Update if pricing
 *     changes after preview.
 *   - VEO_AUDIO_ENABLED_BY_DEFAULT — defaults to true (Veo 3.1
 *     emits audio by default per the spec). Set to '0' to send an
 *     explicit `parameters.audio: false` if a future preview rev
 *     requires the toggle.
 *
 * Logs the FULL response body on every submit + poll call to
 * console.log so the first live test surfaces any drift in
 * Google's response shape without needing a diagnostic redeploy.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SUBMIT_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 30_000;

export const VEO_DEFAULT_MODEL_ID = 'veo-3.1-fast';

export function getVeoModelId(): string {
  return process.env.VEO_MODEL_ID?.trim() || VEO_DEFAULT_MODEL_ID;
}

/** $0.15 per second of generated video. Env-tunable. */
const VEO_USD_PER_SECOND = Number(process.env.VEO_USD_PER_SECOND) || 0.15;

export function estimateVeoCostUsd(durationSeconds: number): number {
  return Math.max(0, durationSeconds) * VEO_USD_PER_SECOND;
}

/**
 * Polish-19.2: per-call duration ceiling. Veo 3.1 Fast caps each
 * generation at 8 seconds; longer requests are clamped by the
 * worker and produce a clamped output (multi-chunk chaining is
 * Polish-19.3 territory).
 */
export const VEO_MAX_SECONDS_PER_CALL = 8;
export const VEO_MIN_SECONDS_PER_CALL = 2;

export function clampVeoDurationSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return VEO_MAX_SECONDS_PER_CALL;
  return Math.min(
    VEO_MAX_SECONDS_PER_CALL,
    Math.max(VEO_MIN_SECONDS_PER_CALL, Math.round(seconds)),
  );
}

export interface VeoSubmitInput {
  userId: string;
  apiKey: string;
  prompt: string;
  /** Clamped to [VEO_MIN_SECONDS_PER_CALL, VEO_MAX_SECONDS_PER_CALL] by the client. */
  durationSeconds?: number;
  /** Defaults to '9:16' for UGC. */
  aspectRatio?: '16:9' | '9:16' | '1:1';
  /** Optional reference image (base64) for image-to-video mode. Unused in 19.2. */
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface VeoSubmitResult {
  ok: boolean;
  operationName?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface VeoSubmitResponseShape {
  name?: string;
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Polish-19.2: submit a Veo 3.1 Fast generation. Returns the
 * long-running operation name (e.g. "operations/abc") for polling.
 *
 * Logs the FULL response on failure so the first live drift surfaces
 * cleanly. Model id / audio-flag / pricing are all env-overridable
 * so wrong guesses ship as config flips, not code patches.
 */
export async function submitVeoVideo(input: VeoSubmitInput): Promise<VeoSubmitResult> {
  const modelId = getVeoModelId();
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(modelId)}:predictLongRunning`;
  const duration = clampVeoDurationSeconds(input.durationSeconds ?? VEO_MAX_SECONDS_PER_CALL);
  const audioEnabledByDefault = (process.env.VEO_AUDIO_ENABLED_BY_DEFAULT ?? '1') !== '0';

  const instanceBase: Record<string, unknown> = { prompt: input.prompt };
  if (input.referenceImageBase64 && input.referenceImageMimeType) {
    instanceBase.image = {
      bytesBase64Encoded: input.referenceImageBase64,
      mimeType: input.referenceImageMimeType,
    };
  }

  const parameters: Record<string, unknown> = {
    aspectRatio: input.aspectRatio ?? '9:16',
    durationSeconds: duration,
    sampleCount: 1,
    personGeneration: 'allow_adult',
  };
  // Veo 3.1 emits audio natively. The explicit toggle is a defensive
  // hatch — if a future preview rev requires an explicit flag, the
  // env override flips it without a code change.
  if (!audioEnabledByDefault) {
    parameters.audio = false;
  }

  const body = { instances: [instanceBase], parameters };

  const result = await callProvider<VeoSubmitResponseShape>({
    userId: input.userId,
    provider: 'gemini',
    url,
    method: 'POST',
    headers: {
      'x-goog-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model: modelId,
      prompt_chars: input.prompt.length,
      duration_seconds: duration,
      aspect_ratio: parameters.aspectRatio,
      reference_image_present: !!instanceBase.image,
      audio_default: audioEnabledByDefault,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    console.log(
      `[veo] submit transport failure: status=${result.status} model=${modelId} ` +
        `prompt_chars=${input.prompt.length} err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.error) {
    console.log(
      `[veo] submit soft failure: model=${modelId} body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.data.error.code, result.data.error.message),
    };
  }
  if (!result.data.name) {
    console.log(
      `[veo] submit succeeded but missing operation name; body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Veo predictLongRunning response missing operation name',
    };
  }
  return { ok: true, operationName: result.data.name, latencyMs: result.latencyMs };
}

export interface VeoPollInput {
  userId: string;
  apiKey: string;
  operationName: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface VeoPollResult {
  ok: boolean;
  done: boolean;
  /** First sample's video URL when done + success. */
  videoUri?: string;
  failMessage?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface VeoPollResponseShape {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { uri?: string };
      }>;
    };
    // Defensive: some Vertex previews wrap differently. Caller's
    // extractor checks both shapes.
    predictResponse?: {
      videos?: Array<{ uri?: string }>;
    };
  };
}

/**
 * Polish-19.2: poll a Veo long-running operation. Caller composes
 * with step.sleep for the polling loop.
 */
export async function pollVeoOperation(input: VeoPollInput): Promise<VeoPollResult> {
  // Gemini long-running operations API: GET /v1beta/{operationName}.
  // operationName already includes the "operations/..." prefix per
  // the submit response.
  const url = `${GEMINI_BASE}/${input.operationName}`;

  const result = await callProvider<VeoPollResponseShape>({
    userId: input.userId,
    provider: 'gemini',
    url,
    method: 'GET',
    headers: { 'x-goog-api-key': input.apiKey },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { operationName: input.operationName },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    console.log(
      `[veo] poll transport failure: operation=${input.operationName} status=${result.status} err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      done: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.error) {
    console.log(
      `[veo] poll terminal error: operation=${input.operationName} body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: true,
      done: true,
      failMessage: result.data.error.message ?? `Veo error code ${result.data.error.code}`,
      latencyMs: result.latencyMs,
    };
  }

  if (!result.data.done) {
    return { ok: true, done: false, latencyMs: result.latencyMs };
  }

  // done === true — extract video URI
  const videoUri = extractVeoOutputUri(result.data);
  if (!videoUri) {
    console.log(
      `[veo] poll done but no video URI found; body=${JSON.stringify(result.data).slice(0, 2000)}`,
    );
    return {
      ok: true,
      done: true,
      failMessage:
        'Veo operation reported done but no video URI in response (check Inngest logs for the full body)',
      latencyMs: result.latencyMs,
    };
  }
  return { ok: true, done: true, videoUri, latencyMs: result.latencyMs };
}

/**
 * Polish-19.2: pure helper for extracting the output URI from a Veo
 * poll response. Defensive against two known wrapper shapes (Gemini
 * Developer API's `generateVideoResponse.generatedSamples[0].video.uri`
 * AND Vertex AI's `predictResponse.videos[0].uri`). Exported so the
 * branches are unit-testable.
 */
export function extractVeoOutputUri(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as VeoPollResponseShape;
  const gemA = r.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (typeof gemA === 'string' && gemA.length > 0) return gemA;
  const gemB = r.response?.predictResponse?.videos?.[0]?.uri;
  if (typeof gemB === 'string' && gemB.length > 0) return gemB;
  return undefined;
}

/**
 * Polish-19.2: map Veo's documented HTTP / API error codes to
 * actionable strings. Same pattern as kie-omni.translateKieErrorStatus.
 */
export function translateVeoErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `Veo validation failed${fallback ? `: ${fallback}` : ' (check prompt + parameters)'}.`;
  if (status === 401 || status === 403)
    return 'Veo authentication failed (invalid Gemini API key). Re-paste your key at /connections/tools.';
  if (status === 404)
    return `Veo resource / model not found${fallback ? `: ${fallback}` : ''} (check VEO_MODEL_ID env override).`;
  if (status === 429) return 'Veo rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `Veo upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `Veo request failed${status ? ` (status ${status})` : ''}.`;
}
