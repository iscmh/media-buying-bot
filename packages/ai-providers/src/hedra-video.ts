import { Buffer } from 'node:buffer';
import { logAiProviderApiCall } from '@mbb/db';
import {
  DEFAULT_HEDRA_CHARACTER_3_MODEL_ID,
  DEFAULT_HEDRA_KLING_V2_PRO_MODEL_ID,
  DEFAULT_HEDRA_KLING_V2_STANDARD_MODEL_ID,
} from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * Polish-21 Commit 1: Hedra Character 3 image-to-talking-avatar
 * client.
 *
 * Replaces the Polish-20 kie.ai text-to-video pipeline (Seedance 1.5
 * Pro / Kling 3.0 Standard / Seedance 2). Character 3 emits a full
 * talking-head video from a single character reference image + an
 * audio track — no multi-clip stitching, no character drift.
 *
 * Endpoint contract (verified against hedra-labs/hedra-api-starter,
 * the official Python starter — Polish-21 investigation):
 *
 *   Base URL : https://api.hedra.com/web-app/public
 *   Auth     : x-api-key: <API_KEY>  (LOWERCASE header)
 *   Assets   : POST /assets            {name, type: 'image'|'audio'}
 *              POST /assets/{id}/upload  multipart file field
 *   Voices   : GET  /voices
 *   Submit   : POST /generations       (see HedraGenerationSubmitBody)
 *   Poll     : GET  /generations/{id}/status
 *   Download : status.download_url is a presigned URL; fetch raw.
 *
 * Design decisions:
 *   - Multipart upload BYPASSES chokepoint (callProvider always
 *     JSON.stringifies the body). We call fetch() directly and log
 *     manually via logAiProviderApiCall so audit coverage stays
 *     intact.
 *   - Character 3 model UUID is hardcoded in the caller
 *     (video-models.ts ModelProviderConfig.modelParam). Matches the
 *     approach in hedra-labs/hedra-api-starter (line 139 overrides
 *     the /models lookup with a constant).
 *   - Native-TTS default: audio_generation.type='text_to_speech' with
 *     voice_id from the curated HEDRA_VOICE_ROSTER. Uploaded-audio
 *     mode (audio_id) is exposed but Polish-21 launch uses TTS.
 *
 * First-live diagnostic: every call kind loud-logs its FULL body on
 * the first invocation so first-live drift surfaces in Inngest logs
 * without a redeploy.
 */

const HEDRA_BASE = 'https://api.hedra.com/web-app/public';
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const ASSET_CREATE_TIMEOUT_MS = 15_000;
const ASSET_UPLOAD_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 15_000;

// -------------------------------------------------------------------
// Types — request/response shapes
// -------------------------------------------------------------------

export type HedraAssetType = 'image' | 'audio' | 'video';

export interface HedraCreateAssetInput {
  userId: string;
  apiKey: string;
  name: string;
  type: HedraAssetType;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HedraCreateAssetResult {
  ok: boolean;
  assetId?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface HedraCreateAssetResponse {
  id?: string;
}

export interface HedraUploadAssetInput {
  userId: string;
  apiKey: string;
  assetId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HedraUploadAssetResult {
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * @deprecated Polish-21.0.4 hotfix removed Hedra native TTS from
 * the pipeline (see submitHedraGeneration JSDoc). Type kept for
 * downstream type imports; nothing in the client consumes it.
 */
export interface HedraTtsInput {
  voiceId: string;
  text: string;
}

export interface HedraSubmitGenerationInput {
  userId: string;
  apiKey: string;
  /** Character 3 UUID from ModelProviderConfig.modelParam. */
  aiModelId: string;
  /** Uploaded image asset id (Nano Banana Pro reference frame). */
  startKeyframeId: string;
  /**
   * REQUIRED as of Polish-21.0.4 hotfix. Hedra's native TTS
   * (audio_generation.type='text_to_speech') is blocked on
   * voice-UUID availability on Creator plans, so the worker
   * generates audio via ElevenLabs BYOK and uploads the mp3 as a
   * Hedra audio asset. audioAssetId is that asset id.
   */
  audioAssetId: string;
  /** Short scene-description prompt (Polish-21 Character 3 style — ~50-80 words). */
  textPrompt: string;
  resolution: '540p' | '720p';
  aspectRatio: '9:16' | '16:9' | '1:1';
  /**
   * REQUIRED as of Polish-21.0.3 hotfix — job 2026-07-03 diagnostic
   * confirmed Hedra returns HTTP 422 "Field required" when
   * generated_video_inputs.duration_ms is missing, even though the
   * docs mark the field as optional:
   *
   *   {"detail": [{"type": "missing",
   *                "loc": ["body", "generated_video_inputs", "duration_ms"],
   *                "msg": "Field required"}]}
   *
   * Value is clamped to [1000, 90000] ms at submit time
   * (Hedra Character 3 hard cap 90s; sub-1s doesn't play with TTS
   * pacing). NaN / non-finite / non-positive → 15000 ms default.
   */
  durationSeconds: number;
  /** Optional deterministic seed. */
  seed?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

/** Polish-21.0.3: default when caller passes 0 / NaN / negative. */
export const HEDRA_DEFAULT_DURATION_MS = 15_000;
/** Polish-21.0.3: sub-1s doesn't play with TTS pacing. */
export const HEDRA_MIN_DURATION_MS = 1_000;
/** Polish-21.0.3: Hedra Character 3 hard cap. */
export const HEDRA_MAX_DURATION_MS = 90_000;

/**
 * Polish-21.0.3: clamp a caller-provided duration (seconds) to
 * Hedra's accepted range and emit the ms value we send on the
 * wire. Extracted so tests can pin the clamp behavior directly.
 */
export function clampHedraDurationMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return HEDRA_DEFAULT_DURATION_MS;
  const raw = Math.round(seconds * 1000);
  return Math.max(HEDRA_MIN_DURATION_MS, Math.min(HEDRA_MAX_DURATION_MS, raw));
}

// -------------------------------------------------------------------
// Polish-21.0.9: per-model UUID env override
// -------------------------------------------------------------------
//
// Mirrors the Polish-21.0.8 getNanoBananaModelId pattern in
// gemini-client.ts: env is read at CALL TIME (not module-load time)
// so setting HEDRA_*_MODEL_ID at deploy time picks up without a
// bundle rebuild. Whitespace-only overrides fall through to the
// default so a blank env var doesn't wire a nonsense UUID.
//
// One env name per model:
//   HEDRA_CHARACTER_3_MODEL_ID          → hedra_character_3
//   HEDRA_KLING_V2_STANDARD_MODEL_ID    → hedra_kling_avatar_v2_standard
//   HEDRA_KLING_V2_PRO_MODEL_ID         → hedra_kling_avatar_v2_pro
//
// The worker calls resolveHedraModelIdWithEnv(descriptorDefault,
// videoModelId) right before submitHedraGeneration so descriptor
// UUIDs are used as fallbacks, not baked into the wire body.

export function getHedraCharacter3ModelId(): string {
  return readEnvUuidOrDefault('HEDRA_CHARACTER_3_MODEL_ID', DEFAULT_HEDRA_CHARACTER_3_MODEL_ID);
}

export function getHedraKlingV2StandardModelId(): string {
  return readEnvUuidOrDefault(
    'HEDRA_KLING_V2_STANDARD_MODEL_ID',
    DEFAULT_HEDRA_KLING_V2_STANDARD_MODEL_ID,
  );
}

export function getHedraKlingV2ProModelId(): string {
  return readEnvUuidOrDefault('HEDRA_KLING_V2_PRO_MODEL_ID', DEFAULT_HEDRA_KLING_V2_PRO_MODEL_ID);
}

/**
 * Resolve the Hedra ai_model_id for a given VideoModelId at call
 * time, honoring per-model env overrides. Returns the descriptor
 * default when the VideoModelId isn't Hedra-hosted (defensive — the
 * dispatcher already routes non-Hedra models elsewhere).
 */
export function resolveHedraModelIdForVideoModel(
  videoModelId: string,
  descriptorDefault: string,
): string {
  if (videoModelId === 'hedra_character_3') return getHedraCharacter3ModelId();
  if (videoModelId === 'hedra_kling_avatar_v2_standard') return getHedraKlingV2StandardModelId();
  if (videoModelId === 'hedra_kling_avatar_v2_pro') return getHedraKlingV2ProModelId();
  return descriptorDefault;
}

function readEnvUuidOrDefault(envName: string, fallback: string): string {
  const raw = process.env[envName];
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

export interface HedraSubmitGenerationResult {
  ok: boolean;
  generationId?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface HedraGenerationSubmitBody {
  type: 'video';
  ai_model_id: string;
  start_keyframe_id: string;
  // Polish-21.0.4 hotfix: audio_id is REQUIRED now. audio_generation
  // union member removed alongside Hedra native TTS.
  audio_id: string;
  generated_video_inputs: {
    text_prompt: string;
    resolution: '540p' | '720p';
    aspect_ratio: '9:16' | '16:9' | '1:1';
    duration_ms: number;
    seed?: number;
  };
}

interface HedraSubmitResponse {
  id?: string;
}

/**
 * Polish-21.0.2: `finalizing` added per the Hedra docs
 * (hedra.com/docs/api-reference/public/get-status status enum lists
 * queued / processing / finalizing / complete / error). Previous
 * enum omitted `finalizing`; a poll response with that value would
 * fall through normalizeHedraStatus and surface as
 * "Hedra status response missing status" mid-generation.
 */
export type HedraGenerationStatus =
  | 'queued'
  | 'processing'
  | 'pending'
  | 'finalizing'
  | 'complete'
  | 'error';

export interface HedraPollStatusInput {
  userId: string;
  apiKey: string;
  generationId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HedraPollStatusResult {
  ok: boolean;
  status?: HedraGenerationStatus;
  downloadUrl?: string;
  assetId?: string;
  /**
   * Polish-21.0.2 hotfix: dedicated flag for 404 responses so the
   * worker can retry them during the initial post-submit window
   * instead of terminating the poll loop. Job 1db50a7c saw a fast
   * 189ms 404 on the first poll — most likely Hedra's status
   * endpoint has an eventual-consistency lag between when POST
   * /generations returns success and when the generation is
   * queryable via GET /generations/{id}/status. Distinguishing 404
   * from other errors lets the worker absorb that window without
   * failing the variant.
   */
  notFound?: true;
  /**
   * Polish-21.0.2: current progress to completion (0-1). Surfaced
   * for operator diagnostics + a future run-detail progress bar.
   * `undefined` when Hedra doesn't return the field.
   */
  progress?: number;
  errorMessage?: string;
  latencyMs: number;
}

interface HedraStatusResponse {
  status?: string;
  url?: string;
  download_url?: string;
  asset_id?: string;
  error_message?: string;
  progress?: number;
}

export interface HedraVoicesListInput {
  userId: string;
  apiKey: string;
}

export interface HedraVoiceRaw {
  id: string;
  name?: string;
  asset?: { labels?: Array<{ name?: string; value?: string }> };
}

export interface HedraVoicesListResult {
  ok: boolean;
  voices?: HedraVoiceRaw[];
  latencyMs: number;
  errorMessage?: string;
}

// -------------------------------------------------------------------
// Asset create — POST /assets
// -------------------------------------------------------------------

export async function createHedraAsset(
  input: HedraCreateAssetInput,
): Promise<HedraCreateAssetResult> {
  const body = { name: input.name, type: input.type };
  const url = `${HEDRA_BASE}/assets`;
  logFirstResponseIfFirstCall('assets-create', input.type, body);
  logHedraRequest('assets-create', 'POST', url, input.apiKey, body);

  const result = await callProvider<HedraCreateAssetResponse>({
    userId: input.userId,
    provider: 'hedra',
    url,
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: ASSET_CREATE_TIMEOUT_MS,
    requestBodyForLog: {
      name: input.name,
      type: input.type,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  logHedraResponse('assets-create', 'POST', url, result.status ?? 0, result.rawBody);
  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateHedraErrorStatus(result.status, result.errorMessage),
    };
  }
  const assetId = result.data.id;
  if (!assetId || typeof assetId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Hedra /assets response missing id',
    };
  }
  return { ok: true, assetId, latencyMs: result.latencyMs };
}

// -------------------------------------------------------------------
// Asset upload — POST /assets/{id}/upload  (multipart)
// -------------------------------------------------------------------
//
// Bypasses chokepoint because callProvider always JSON.stringifies
// the body. We do audit logging manually via logAiProviderApiCall so
// upload calls still land in ai_provider_api_call_logs.

export async function uploadHedraAsset(
  input: HedraUploadAssetInput,
): Promise<HedraUploadAssetResult> {
  const t0 = Date.now();
  const url = `${HEDRA_BASE}/assets/${encodeURIComponent(input.assetId)}/upload`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_UPLOAD_TIMEOUT_MS);

  const uploadRequestSummary = {
    assetId: input.assetId,
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes.byteLength,
  };
  logFirstResponseIfFirstCall('assets-upload', input.contentType, uploadRequestSummary);
  logHedraRequest('assets-upload', 'POST', url, input.apiKey, uploadRequestSummary);

  let status = 0;
  let rawBody: unknown = null;
  let errorMessage: string | undefined;
  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(input.bytes)], { type: input.contentType }),
      input.filename,
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        // NOTE: NO content-type header — the browser/fetch sets a
        // multipart boundary automatically. Setting our own breaks
        // the parser on Hedra's side (verified in the ComfyUI Hedra
        // implementation).
        'x-api-key': input.apiKey,
      },
      body: form,
      signal: controller.signal,
    });
    status = res.status;
    const text = await res.text();
    if (text) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        rawBody = { _non_json_body: text.slice(0, 4096) };
      }
    }
    if (!(status >= 200 && status < 300)) {
      errorMessage = translateHedraErrorStatus(status, extractHedraErrorMessage(rawBody));
    }
    logHedraResponse('assets-upload', 'POST', url, status, rawBody);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `Hedra upload timed out after ${ASSET_UPLOAD_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    rawBody = { _error: errorMessage };
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: 'hedra',
      endpoint: url,
      method: 'POST',
      requestBody: {
        assetId: input.assetId,
        filename: input.filename,
        contentType: input.contentType,
        bytes: input.bytes.byteLength,
      },
      responseStatus: status,
      responseBody: rawBody,
      latencyMs,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
    });
  } catch {
    // See Polish-3 chokepoint rationale — logging failures never crash the caller.
  }

  if (errorMessage) return { ok: false, latencyMs, errorMessage };
  return { ok: true, latencyMs };
}

// -------------------------------------------------------------------
// Generation submit — POST /generations
// -------------------------------------------------------------------

export async function submitHedraGeneration(
  input: HedraSubmitGenerationInput,
): Promise<HedraSubmitGenerationResult> {
  // Polish-21.0.4 hotfix: audioAssetId is required (native TTS path
  // via audio_generation is gone). Fail-fast on empty input so a
  // caller bug surfaces as a clear error instead of a Hedra 422.
  if (!input.audioAssetId) {
    return {
      ok: false,
      latencyMs: 0,
      errorMessage:
        'Hedra submit requires audioAssetId. Polish-21.0.4 removed native TTS — ' +
        'generate audio via ElevenLabs (submitElevenLabsTts) and upload as a Hedra audio asset.',
    };
  }

  const body: HedraGenerationSubmitBody = {
    type: 'video',
    ai_model_id: input.aiModelId,
    start_keyframe_id: input.startKeyframeId,
    // Polish-21.0.4: audio_id at top level (not audio_generation).
    // Matches the hedra-labs/hedra-api-starter uploaded-audio path.
    audio_id: input.audioAssetId,
    generated_video_inputs: {
      text_prompt: input.textPrompt,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      // Polish-21.0.3 hotfix: duration_ms is ALWAYS emitted.
      // Hedra's docs say optional, real API rejects with 422 when
      // missing. See HedraSubmitGenerationInput.durationSeconds
      // JSDoc for the diagnostic.
      duration_ms: clampHedraDurationMs(input.durationSeconds),
      ...(input.seed != null ? { seed: input.seed } : {}),
    },
  };

  const submitUrl = `${HEDRA_BASE}/generations`;
  logFirstResponseIfFirstCall('generations-submit', input.aiModelId, body);
  // Polish-21.0.2 hotfix: log FULL submit body on every call. Job
  // 1db50a7c returned 404 from POST /generations even though the
  // body byte-exactly matches hedra-labs/hedra-api-starter. Wire-
  // level log lets the operator paste the exact payload into a
  // Hedra support ticket for cross-vendor diagnosis.
  logHedraRequest('generations-submit', 'POST', submitUrl, input.apiKey, body);

  const result = await callProvider<HedraSubmitResponse>({
    userId: input.userId,
    provider: 'hedra',
    url: submitUrl,
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      ai_model_id: input.aiModelId,
      start_keyframe_id: input.startKeyframeId,
      audio_id: input.audioAssetId,
      text_chars: input.textPrompt.length,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      duration_seconds: input.durationSeconds,
      seed: input.seed ?? '(default)',
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  logHedraResponse('generations-submit', 'POST', submitUrl, result.status ?? 0, result.rawBody);
  if (!result.ok) {
    // Polish-21.0.3 hotfix: pull the FastAPI-shaped detail out of
    // rawBody. The shared chokepoint's extractErrorMessage doesn't
    // know Hedra's array-detail shape and falls back to "HTTP 422",
    // which erases the field path from the operator-facing error.
    // Ours handles both string-detail and array-detail branches.
    const hedraDetail = extractHedraErrorMessage(result.rawBody);
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateHedraErrorStatus(result.status, hedraDetail ?? result.errorMessage),
    };
  }
  const generationId = result.data.id;
  if (!generationId || typeof generationId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Hedra /generations response missing id',
    };
  }
  return { ok: true, generationId, latencyMs: result.latencyMs };
}

// -------------------------------------------------------------------
// Poll — GET /generations/{id}/status
// -------------------------------------------------------------------
//
// URL path VERIFIED against three authoritative sources during
// Polish-21.0.2 investigation (job 1db50a7c diagnosed a fast 189ms
// 404 on the first poll):
//   - Hedra docs — https://www.hedra.com/docs/api-reference/public/get-status
//   - Official Python starter — hedra-labs/hedra-api-starter/main.py
//     line 204: `session.get(f"/generations/{generation_id}/status")`
//   - Official Node SDK — hedra-labs/hedra-node/src/Client.ts::getStatus
//     line 574: `generations/${core.url.encodePathParam(generationId)}/status`
//
// All three use the exact `{HEDRA_BASE}/generations/{id}/status`
// path we build below. The 189ms 404 is therefore NOT a URL bug —
// most likely an eventual-consistency window between POST
// /generations returning success and the status record becoming
// queryable. The worker's poll loop absorbs the window by treating
// early 404s as `notFound: true` (a keep-polling signal) rather
// than a terminal error.

/** Canonical path segment builder, exported so tests can pin it. */
export function buildHedraStatusUrl(generationId: string): string {
  return `${HEDRA_BASE}/generations/${encodeURIComponent(generationId)}/status`;
}

// Log full response body ONCE per generationId on 404 so operators
// see the exact Hedra response text on the first live case. After
// that the body is elided to keep Inngest log volume sane.
const _hedra404BodyLogged = new Set<string>();

export async function pollHedraGeneration(
  input: HedraPollStatusInput,
): Promise<HedraPollStatusResult> {
  const url = buildHedraStatusUrl(input.generationId);
  logHedraRequest('generations-status', 'GET', url, input.apiKey, {
    generation_id: input.generationId,
  });
  const result = await callProvider<HedraStatusResponse>({
    userId: input.userId,
    provider: 'hedra',
    url,
    method: 'GET',
    headers: {
      'x-api-key': input.apiKey,
    },
    timeoutMs: POLL_TIMEOUT_MS,
    requestBodyForLog: { generation_id: input.generationId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  logHedraResponse('generations-status', 'GET', url, result.status ?? 0, result.rawBody);
  if (!result.ok) {
    // Polish-21.0.2: dedicated 404 flag so the worker can decide
    // between "keep polling, generation not queryable yet" and
    // "terminal error, bail out". Non-404 transport failures still
    // surface as `ok: false, errorMessage: ...`.
    if (result.status === 404) {
      const key = input.generationId;
      if (!_hedra404BodyLogged.has(key)) {
        _hedra404BodyLogged.add(key);
        console.log(
          `[hedra] first 404 on status endpoint for generation=${key}: ` +
            `url=${url} response_body=${JSON.stringify(result.rawBody).slice(0, 2000)}. ` +
            `Treating as eventual-consistency lag; worker will retry.`,
        );
      }
      return { ok: false, notFound: true, latencyMs: result.latencyMs };
    }
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateHedraErrorStatus(result.status, result.errorMessage),
    };
  }
  const status = normalizeHedraStatus(result.data.status);
  if (!status) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: `Hedra status response missing status (got ${JSON.stringify(result.data.status)})`,
    };
  }
  const progress =
    typeof result.data.progress === 'number' && Number.isFinite(result.data.progress)
      ? result.data.progress
      : undefined;
  if (status === 'error') {
    return {
      ok: true,
      status,
      latencyMs: result.latencyMs,
      progress,
      errorMessage: result.data.error_message ?? 'Hedra reported error without a message.',
    };
  }
  if (status === 'complete') {
    // Prefer download_url (from official starter) then fall back to
    // url (ComfyUI Hedra uses this) — the two live starters differ
    // and we take whichever surfaces first.
    const downloadUrl = result.data.download_url ?? result.data.url;
    if (!downloadUrl) {
      return {
        ok: true,
        status,
        progress,
        latencyMs: result.latencyMs,
        errorMessage: 'Hedra reported complete but response missing download_url / url.',
      };
    }
    return {
      ok: true,
      status,
      downloadUrl,
      assetId: result.data.asset_id,
      progress,
      latencyMs: result.latencyMs,
    };
  }
  return { ok: true, status, progress, latencyMs: result.latencyMs };
}

/** TEST-ONLY: reset the per-generationId 404 log memoization. */
export function __resetHedra404LogForTests(): void {
  _hedra404BodyLogged.clear();
}

/**
 * Normalize the raw string status from Hedra into the typed enum.
 * Guards against future case-changes and unknown states — surface
 * the raw value in the caller when this returns undefined.
 */
export function normalizeHedraStatus(raw: unknown): HedraGenerationStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'complete' || lower === 'completed') return 'complete';
  if (lower === 'error' || lower === 'failed' || lower === 'failure') return 'error';
  if (lower === 'processing' || lower === 'running' || lower === 'in_progress') return 'processing';
  if (lower === 'pending') return 'pending';
  if (lower === 'queued') return 'queued';
  // Polish-21.0.2: docs list `finalizing` as a real Hedra status
  // (queued → processing → finalizing → complete). Not handling it
  // would surface as "status missing" mid-generation.
  if (lower === 'finalizing') return 'finalizing';
  return undefined;
}

// -------------------------------------------------------------------
// Voices list — GET /voices  (operator-only helper)
// -------------------------------------------------------------------

export async function listHedraVoices(input: HedraVoicesListInput): Promise<HedraVoicesListResult> {
  const result = await callProvider<HedraVoiceRaw[]>({
    userId: input.userId,
    provider: 'hedra',
    url: `${HEDRA_BASE}/voices`,
    method: 'GET',
    headers: {
      'x-api-key': input.apiKey,
    },
    timeoutMs: VOICES_TIMEOUT_MS,
    requestBodyForLog: {},
  });
  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateHedraErrorStatus(result.status, result.errorMessage),
    };
  }
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'Hedra /voices response was not an array.',
    };
  }
  return { ok: true, voices: result.data, latencyMs: result.latencyMs };
}

// -------------------------------------------------------------------
// Key verification — used by the BYOK connect card
// -------------------------------------------------------------------
//
// GET /voices is the cheapest known authenticated read on Hedra. A
// 200 with an array body confirms the key works.

export async function verifyHedraKey(
  apiKey: string,
): Promise<
  | { ok: true; method: 'api'; statusCode: number }
  | { ok: false; method: 'api'; reason: string; statusCode?: number }
> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICES_TIMEOUT_MS);
  try {
    const res = await fetch(`${HEDRA_BASE}/voices`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
    });
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, method: 'api', statusCode: status };
    let msg = `Hedra rejected the key (HTTP ${status})`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const extracted = extractHedraErrorMessage(body);
      if (extracted) msg = extracted;
    } catch {
      // ignore — status code is enough for the caller
    }
    void (Date.now() - t0);
    return { ok: false, method: 'api', reason: msg, statusCode: status };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const msg = isAbort
      ? `Hedra verify timed out after ${VOICES_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, method: 'api', reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------
// Error translation + first-call diagnostic
// -------------------------------------------------------------------

export function translateHedraErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `Hedra validation failed${fallback ? `: ${fallback}` : ' (check inputs)'}.`;
  if (status === 401)
    return 'Hedra authentication failed. Re-paste your key at /connections/ai-provider.';
  if (status === 402) return 'Insufficient Hedra credits. Top up at hedra.com/api-profile.';
  if (status === 403)
    return 'Hedra forbidden — the API key may lack Character 3 access. Check your Hedra plan.';
  if (status === 404) return `Hedra resource not found${fallback ? `: ${fallback}` : ''}.`;
  if (status === 422) return `Hedra parameter validation failed${fallback ? `: ${fallback}` : ''}.`;
  if (status === 429) return 'Hedra rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `Hedra upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `Hedra request failed${status ? ` (status ${status})` : ''}.`;
}

export function extractHedraErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  if (typeof obj['detail'] === 'string') return obj['detail'];
  // Polish-21.0.3 hotfix: Hedra returns FastAPI-shaped validation
  // errors like {detail: [{type, loc: [...segments], msg}]} on
  // HTTP 422. Extract EACH detail entry into "at body.<path>:
  // <msg>" so the operator sees WHICH field was rejected. Job
  // 2026-07-03 diagnostic ran into this on a missing duration_ms —
  // the old extractor returned undefined and the translated 422
  // message erased the field-level detail from Inngest logs.
  if (Array.isArray(obj['detail'])) {
    const rendered = renderFastApiDetail(obj['detail'] as unknown[]);
    if (rendered) return rendered;
  }
  if (typeof obj['message'] === 'string') return obj['message'];
  if (typeof obj['error'] === 'string') return obj['error'];
  const err = obj['error'];
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>)['message'];
    if (typeof m === 'string') return m;
  }
  if (typeof obj['error_message'] === 'string') return obj['error_message'] as string;
  return undefined;
}

/**
 * Polish-21.0.3 hotfix: render a FastAPI-shaped validation detail
 * array into a human-readable string. Handles the exact shape Hedra
 * returned for the duration_ms case:
 *
 *   [{"type": "missing",
 *     "loc": ["body", "generated_video_inputs", "duration_ms"],
 *     "msg": "Field required"}]
 *
 * → "missing at body.generated_video_inputs.duration_ms: Field required"
 *
 * Joins multiple details with " | ". Returns undefined when the
 * array shape doesn't look FastAPI-y so extractHedraErrorMessage
 * can fall through to the next fallback.
 */
export function renderFastApiDetail(items: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const loc = Array.isArray(rec['loc'])
      ? (rec['loc'] as unknown[]).map((s) => String(s)).join('.')
      : undefined;
    const msg = typeof rec['msg'] === 'string' ? rec['msg'] : undefined;
    const type = typeof rec['type'] === 'string' ? rec['type'] : undefined;
    if (!loc && !msg) continue;
    const prefix = type ? `${type} at ${loc ?? '(no path)'}` : (loc ?? '(no path)');
    parts.push(msg ? `${prefix}: ${msg}` : prefix);
  }
  if (parts.length === 0) return undefined;
  return parts.join(' | ');
}

const _firstCallLogged = new Set<string>();
function logFirstResponseIfFirstCall(
  kind: string,
  key: string,
  body: Record<string, unknown> | HedraGenerationSubmitBody,
): void {
  const logKey = `${kind}:${key}`;
  if (_firstCallLogged.has(logKey)) return;
  _firstCallLogged.add(logKey);
  console.log(`[hedra] first-${kind} for ${key}: body=${JSON.stringify(body).slice(0, 2000)}`);
}

/** TEST-ONLY: clear the first-call log memoization. */
export function __resetHedraFirstCallLogForTests(): void {
  _firstCallLogged.clear();
}

/**
 * Polish-21.0.2 hotfix: wire-level pre-flight + response log for
 * EVERY Hedra call. Job 1db50a7c diagnosed POST /generations
 * returning 404 even though the submit body matches
 * hedra-labs/hedra-api-starter byte-for-byte. Without an always-on
 * request/response log, the operator couldn't attach the exact
 * wire payload to a Hedra support ticket. These logs fire on every
 * call so the full payload + full response body are visible in
 * Inngest logs immediately — critical for cross-vendor diagnostics.
 *
 * Redacts the API key to the first 4 characters + trailing 4 to
 * keep audit rows safe while still identifying which key was in
 * use (useful when the operator rotates between test + prod keys).
 */
export function redactHedraApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 12) return 'x-api-key:(short-key)';
  return `x-api-key:${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export function logHedraRequest(
  kind: string,
  method: string,
  url: string,
  apiKey: string,
  body: unknown,
): void {
  const bodyStr = body == null ? '(no body)' : JSON.stringify(body).slice(0, 3000);
  console.log(
    `[hedra] ${kind} REQUEST: ${method} ${url} ` +
      `auth=${redactHedraApiKey(apiKey)} body=${bodyStr}`,
  );
}

export function logHedraResponse(
  kind: string,
  method: string,
  url: string,
  status: number,
  body: unknown,
): void {
  const bodyStr = body == null ? '(no body)' : JSON.stringify(body).slice(0, 3000);
  console.log(`[hedra] ${kind} RESPONSE: ${method} ${url} → ${status} body=${bodyStr}`);
}
