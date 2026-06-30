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

/**
 * Polish-19.2.2: corrected default after live 404 surfaced — the
 * pre-19.2.2 default was 'veo-3.1-fast' which doesn't exist on the
 * v1beta predictLongRunning endpoint. Confirmed against Google docs
 * (ai.google.dev/gemini-api/docs/video, 2026-06-22):
 *
 *   - Veo 3.1 Standard: veo-3.1-generate-preview
 *   - Veo 3.1 Fast:     veo-3.1-fast-generate-preview   ← current default
 *   - Veo 3.1 Lite:     veo-3.1-lite-generate-preview
 *
 * The `-generate-preview` suffix is required while these models are
 * still preview. When the family GAs (suffix likely dropped), flip
 * VEO_MODEL_ID env var and update this default. The trailing
 * "-preview" pin in the regression test catches accidental
 * non-preview defaults until the GA flip is documented.
 */
export const VEO_DEFAULT_MODEL_ID = 'veo-3.1-fast-generate-preview';

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

/**
 * Polish-19.4: Veo Extend constants per Google docs:
 *   - Base call when chain-extending MUST be exactly 8 seconds.
 *   - Each Extend adds 7s of new content (NOT 8s — the segment math
 *     uses 8 + (N-1) × 7).
 *   - Resolution MUST be 720p in the Extend chain (1080p/4k unsupported).
 *   - Max 20 extensions per chain (148s total).
 */
export const VEO_EXTEND_SECONDS_PER_CALL = 7;
export const VEO_EXTEND_REQUIRED_RESOLUTION = '720p';
export const VEO_EXTEND_MAX_CHAIN_CALLS = 20;

/**
 * Polish-19.4.1: Veo's accepted range for the durationSeconds param
 * on the EXTEND endpoint is [4, 8] per the live error message
 * ("Please provide a value between 4 and 8, inclusive"). Narrower
 * than VEO_MIN_SECONDS_PER_CALL=2 (which is the base-submit floor).
 * Kept here, NOT exported as a public constant, because it's only
 * used by the env-override parser below.
 */
const VEO_EXTEND_API_MIN_SECONDS = 4;
const VEO_EXTEND_API_MAX_SECONDS = VEO_MAX_SECONDS_PER_CALL; // 8

/**
 * Polish-19.4.1: parser for VEO_EXTEND_DURATION_SECONDS env override.
 * Default behavior (returns null) is to OMIT the durationSeconds
 * field from extend requests — Veo's Developer API rejects the 7s
 * value Google's docs implied was the param, so the safest default
 * is to let Veo apply its server-side default.
 *
 * Env values:
 *   - unset / empty / whitespace → null (omit field, Option A)
 *   - integer in [4, 8] → that integer (Option B fallback, typically '8')
 *   - any other value → null + warning log (defensive)
 *
 * Exported so the parsing logic is unit-testable independently of
 * a full submitVeoExtend call.
 */
export function parseExtendDurationOverride(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    console.log(
      `[veo-extend] ignoring VEO_EXTEND_DURATION_SECONDS=${JSON.stringify(raw)} — ` +
        `not a finite integer; falling back to omit-field default.`,
    );
    return null;
  }
  if (n < VEO_EXTEND_API_MIN_SECONDS || n > VEO_EXTEND_API_MAX_SECONDS) {
    console.log(
      `[veo-extend] ignoring VEO_EXTEND_DURATION_SECONDS=${n} — outside Veo's ` +
        `accepted [${VEO_EXTEND_API_MIN_SECONDS}, ${VEO_EXTEND_API_MAX_SECONDS}] range ` +
        `for the extend endpoint; falling back to omit-field default.`,
    );
    return null;
  }
  return n;
}

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
  /**
   * Polish-19.4: optional resolution override. Default behavior (omit
   * field) lets Google pick — the Developer API has been seen returning
   * 1080p without it being requested. When chain-extending (the worker
   * passes '720p'), the base segment MUST be 720p so the Extend chain's
   * 720p-only constraint matches the source resolution.
   */
  resolution?: '720p' | '1080p';
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
  };
  // Polish-19.4: explicit resolution required when chain-extending
  // (Extend only supports 720p). Other callers omit and let Google
  // pick the default for the model tier.
  if (input.resolution) {
    parameters.resolution = input.resolution;
  }
  // Polish-19.4: personGeneration RE-ADDED with default 'allow_all'.
  // Polish-19.2.3 dropped it entirely after a live rejection on
  // 'allow_adult' for text-to-video — turns out the rejection was
  // specific to the value, not the field. Per Google's docs the
  // Gemini Developer API requires:
  //   - 'allow_all'   for text-to-video AND Extend chains
  //   - 'allow_adult' for image-to-video / reference-image inputs
  // The submit path here is text-to-video (when no reference image)
  // OR image-to-video (when input.referenceImageBase64 is set).
  // Auto-pick based on which mode the caller invoked; the env var
  // still overrides everything if a future preview rev changes the
  // accepted vocab.
  const personGenerationDefault = instanceBase.image ? 'allow_adult' : 'allow_all';
  const personGenerationOverride = process.env.VEO_PERSON_GENERATION?.trim();
  parameters.personGeneration = personGenerationOverride || personGenerationDefault;
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
      resolution: parameters.resolution ?? '(default)',
      reference_image_present: !!instanceBase.image,
      audio_default: audioEnabledByDefault,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  // Polish-19.2.3: log the actual parameters block we sent on every
  // failure path so the next validation rejection ("personGeneration
  // is currently not supported", etc) shows the EXACT sent body next
  // to the error message. Pre-19.2.3 the log only had the error
  // message — diagnosing required reading the chokepoint DB audit
  // log to see what we sent, which is slow + non-local. Logging
  // `parameters` (not the full body — the base64 reference image
  // would balloon the line) is enough for validation diagnosis.
  if (!result.ok) {
    console.log(
      `[veo] submit transport failure: status=${result.status} model=${modelId} ` +
        `prompt_chars=${input.prompt.length} ` +
        `parameters=${JSON.stringify(parameters)} ` +
        `err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.error) {
    console.log(
      `[veo] submit soft failure: model=${modelId} ` +
        `parameters=${JSON.stringify(parameters)} ` +
        `responseBody=${JSON.stringify(result.data).slice(0, 1500)}`,
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

// =========================================================================
// Polish-19.4: Veo Extend — chain a prior generation forward 7s at a time
// =========================================================================
//
// CONTRACT (verified against Google's docs, June 2026):
//   - Endpoint: same predictLongRunning on veo-3.1-fast-generate-preview.
//   - The instance carries a `video` field pointing at the prior
//     generation's Files API URI:
//         instances[0].video = { uri, mimeType: 'video/mp4' }
//     The prompt describes ONLY the new 7s of content.
//   - durationSeconds in parameters MUST be 7 (NOT 8 — that's the base
//     call's max). The Extend adds exactly 7 seconds of fresh content
//     onto the input video.
//   - resolution MUST be '720p' (1080p/4k unsupported on Extend).
//   - personGeneration: 'allow_all' (same as text-to-video).
//   - Output: the operation completes with ONE continuous mp4 = the
//     input video + the 7s extension. The worker uses that output URI
//     as the input for the NEXT Extend call to chain.
//
// CONSEQUENCE FOR THE WORKER:
//   - After N extends, the final operation's output IS the cumulative
//     composite — no ffmpeg-concat step needed.
//   - Files API URIs have a 2-day TTL but the TTL RESETS when the URI
//     is referenced for Extend, so a chain stays valid as long as
//     extends happen within 2 days of each other.

/** Polish-19.4: shape of the video reference passed back into Extend. */
export interface VeoExtendVideoRef {
  /** Files API URI from a previous Veo generation. */
  uri: string;
  /** Always 'video/mp4' for Veo outputs; pinned for the request body. */
  mimeType?: string;
}

export interface VeoExtendSubmitInput {
  userId: string;
  apiKey: string;
  /** Reference to the previous generation's output video. */
  previousVideo: VeoExtendVideoRef;
  /** Self-contained prompt describing the NEW 7s of content. */
  prompt: string;
  /** Defaults to '9:16'. Must match the base call's aspect ratio. */
  aspectRatio?: '16:9' | '9:16' | '1:1';
  generationJobId?: string;
  generatedCreativeId?: string;
}

/**
 * Polish-19.4: submit a Veo Extend call. Returns the long-running
 * operation name; the caller polls with `pollVeoOperation`. Same
 * downstream poll/extract path as the base submit.
 *
 * The first live extend call console.logs the FULL request body
 * shape so the next maintainer can see whether the `video` field
 * actually belongs in `instances[0]` (assumed) or `parameters`
 * (alternate Google docs phrasing — both have been seen across
 * Veo / Vertex AI revs). If a 400 lands, the log tells us which
 * shape to flip to without a redeploy.
 */
export async function submitVeoExtend(input: VeoExtendSubmitInput): Promise<VeoSubmitResult> {
  const modelId = getVeoModelId();
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(modelId)}:predictLongRunning`;

  // Polish-19.4.1: HOTFIX — `durationSeconds: 7` rejects with
  // "value out of bound. Please provide a value between 4 and 8,
  // inclusive." The "7 seconds per extend" framing in Google's docs
  // is the OUTPUT increment Veo produces, NOT a parameter value the
  // client passes. Default behavior: OMIT the field entirely so
  // Veo applies its server-side default for Extend (~7s).
  //
  // Env-override hatch (Option B fallback): if a future Google rev
  // requires the field present, set VEO_EXTEND_DURATION_SECONDS to
  // a value in [4, 8] (the API-accepted range) and we'll send it.
  // Typical fallback value is '8' (max valid) — extend bills the
  // 7s output increment regardless of which valid value we pass.
  // Unset / whitespace / out-of-range → omit (Option A, the default).
  const extendDurationOverride = parseExtendDurationOverride(
    process.env.VEO_EXTEND_DURATION_SECONDS,
  );

  // Polish-19.4: personGeneration MUST be 'allow_all' for Extend per
  // Google docs (same as text-to-video). Env override hatch retained
  // so an operator can flip it without redeploying if Google adds
  // more values to the vocab.
  const personGenerationOverride = process.env.VEO_PERSON_GENERATION?.trim();
  const personGeneration = personGenerationOverride || 'allow_all';

  const videoRef = {
    uri: input.previousVideo.uri,
    mimeType: input.previousVideo.mimeType ?? 'video/mp4',
  };

  const instance: Record<string, unknown> = {
    prompt: input.prompt,
    video: videoRef,
  };
  const parameters: Record<string, unknown> = {
    aspectRatio: input.aspectRatio ?? '9:16',
    sampleCount: 1,
    resolution: VEO_EXTEND_REQUIRED_RESOLUTION,
    personGeneration,
  };
  if (extendDurationOverride !== null) {
    parameters.durationSeconds = extendDurationOverride;
  }

  const body = { instances: [instance], parameters };

  // Polish-19.4.1: loud-log the FULL body (not just the summary) so
  // each live extend confirms — in Inngest — that resolution='720p'
  // and personGeneration='allow_all' actually made it onto the wire,
  // and whether the optional durationSeconds is present. Pre-19.4.1
  // the rejection on durationSeconds=7 wasn't visible without DB
  // audit-log spelunking because the summary already pre-stringified.
  console.log(
    `[veo-extend] submit attempt: model=${modelId} ` +
      `prev_uri=${videoRef.uri} prev_mime=${videoRef.mimeType} ` +
      `prompt_chars=${input.prompt.length} ` +
      `duration_override=${extendDurationOverride ?? '(omitted — Option A)'} ` +
      `parameters=${JSON.stringify(parameters)} ` +
      `instance_keys=${JSON.stringify(Object.keys(instance))}`,
  );

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
      mode: 'extend',
      prompt_chars: input.prompt.length,
      duration_seconds_param: extendDurationOverride ?? '(omitted)',
      aspect_ratio: parameters.aspectRatio,
      resolution: parameters.resolution,
      person_generation: personGeneration,
      previous_video_uri: videoRef.uri,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    console.log(
      `[veo-extend] submit transport failure: status=${result.status} model=${modelId} ` +
        `prev_uri=${videoRef.uri} ` +
        `parameters=${JSON.stringify(parameters)} ` +
        `err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.status, result.errorMessage),
    };
  }
  if (result.data.error) {
    console.log(
      `[veo-extend] submit soft failure: model=${modelId} ` +
        `prev_uri=${videoRef.uri} ` +
        `parameters=${JSON.stringify(parameters)} ` +
        `responseBody=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateVeoErrorStatus(result.data.error.code, result.data.error.message),
    };
  }
  if (!result.data.name) {
    console.log(
      `[veo-extend] submit succeeded but missing operation name; body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Veo Extend predictLongRunning response missing operation name',
    };
  }
  console.log(
    `[veo-extend] submit ok: operation=${result.data.name} model=${modelId} ` +
      `prev_uri=${videoRef.uri}`,
  );
  return { ok: true, operationName: result.data.name, latencyMs: result.latencyMs };
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
