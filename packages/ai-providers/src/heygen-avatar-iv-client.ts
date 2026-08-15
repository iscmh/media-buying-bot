/**
 * Polish-28.0.0 Commit 64: HeyGen Avatar IV image-to-video BYOK client.
 *
 * DISTINCT from packages/ai-providers/src/heygen-v3-client.ts:
 *   - heygen-v3-client: Pre-cast avatar (avatar_id from library) →
 *     talking-head video. Used by the Polish-26 pipeline (nuked in
 *     Polish-27 Commit 63).
 *   - THIS file: caller-supplied REFERENCE IMAGE + audio → lip-synced
 *     video via HeyGen's Avatar IV image-to-video head. New surface
 *     for the Polish-28 rebuild.
 *
 * Two-step API dance (v2):
 *   1. POST /v2/upload/asset
 *        Uploads reference image bytes (or audio bytes if you want to
 *        supply audio via asset ID rather than URL). Returns
 *        `data.image_key` (or `data.asset_id` for audio).
 *   2. POST /v2/video/av4/generate
 *        Body: { image_key, script | audio_url | audio_asset_id,
 *                video_title, video_orientation, custom_motion_prompt? }
 *        Returns `data.video_id`.
 *   3. GET /v1/video_status.get?video_id=<id>
 *        Poll until status in {'completed', 'failed'}. Response carries
 *        `video_url` on success, `error` on failure.
 *
 * Auth: X-Api-Key header, same as heygen-v3-client. BYOK per user (not
 * platform-managed) — the operator's affiliate customers each connect
 * their own HeyGen key at /settings/connections.
 *
 * Retail pricing verified via Phase 1 investigation:
 *   - 1080p: $4/min = $0.0667/sec ≈ $2.00 per 30s video
 *   - 4K:    $5/min = $0.0833/sec ≈ $2.50 per 30s
 *   - Duration cap: 180s per generation
 *   - Aspect ratios: 9:16 or 16:9 ONLY (no square). Polish-28 locks
 *     to 9:16 for Meta Reels / TikTok / IG Reels output.
 */
import { callProvider } from './chokepoint';

const HEYGEN_BASE = 'https://api.heygen.com';
/** Polish-28.1.1: separate subdomain for asset uploads — HeyGen splits
 *  the upload traffic away from api.heygen.com. */
const HEYGEN_UPLOAD_BASE = 'https://upload.heygen.com';
const UPLOAD_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Polish-28 output aspect ratio. Locked per operator spec — no user
 * choice; every Polish-28 generation is 9:16 vertical for Meta Reels
 * / TikTok / IG Reels. HeyGen Avatar IV doesn't support 1:1 anyway.
 */
export const POLISH28_ASPECT_RATIO = '9:16' as const;
export type Polish28AspectRatio = typeof POLISH28_ASPECT_RATIO;

/**
 * Per-second retail cost. Env-overridable so a HeyGen pricing shift
 * doesn't require a code deploy — read at estimate + submit time.
 * Defaults to the 1080p rate from Phase 1 investigation ($4/min).
 */
const DEFAULT_AVATAR_IV_COST_PER_SEC_USD = 0.0667;

export function heygenAvatarIvCostPerSecUsd(): number {
  const raw = process.env['HEYGEN_AVATAR_IV_COST_PER_SEC_USD']?.trim();
  if (!raw) return DEFAULT_AVATAR_IV_COST_PER_SEC_USD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AVATAR_IV_COST_PER_SEC_USD;
}

export function estimateHeygenAvatarIvCostUsd(durationSeconds: number): number {
  return Math.max(0, durationSeconds) * heygenAvatarIvCostPerSecUsd();
}

// =========================================================================
// Types
// =========================================================================

export type HeygenAvatarIvVideoStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type HeygenAvatarIvErrorCategory =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'quota_exceeded'
  | 'rate_limit'
  | 'moderation'
  | 'server'
  | 'timeout'
  | 'unknown';

interface HeygenEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
  error?: { code?: string; message?: string };
}

// =========================================================================
// Custom errors (mirror heygen-v3-client's shape for parallel handling)
// =========================================================================

export class HeygenAvatarIvAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeygenAvatarIvAuthError';
  }
}

export class HeygenAvatarIvModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeygenAvatarIvModerationError';
  }
}

export class HeygenAvatarIvQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeygenAvatarIvQuotaError';
  }
}

// =========================================================================
// Error classification
// =========================================================================

export function classifyHeygenAvatarIvError(
  status: number | undefined,
  message: string | undefined,
): HeygenAvatarIvErrorCategory {
  const msg = (message ?? '').toLowerCase();
  if (status === 401 || msg.includes('unauthorized')) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429 || msg.includes('rate')) return 'rate_limit';
  if (status === 402 || msg.includes('quota') || msg.includes('insufficient'))
    return 'quota_exceeded';
  if (
    msg.includes('moderation') ||
    msg.includes('policy') ||
    msg.includes('celebrity') ||
    msg.includes('nsfw')
  ) {
    return 'moderation';
  }
  if (status !== undefined && status >= 500) return 'server';
  if (status === 0 && (msg.includes('timeout') || msg.includes('abort'))) return 'timeout';
  if (status === 400 || status === 422) return 'validation';
  return 'unknown';
}

// =========================================================================
// POST upload.heygen.com/v1/asset — upload reference image bytes
// =========================================================================
//
// Polish-28.1.1 Commit 66 hotfix: the Polish-28.0.0 Phase 1 investigation
// encoded `${HEYGEN_BASE}/v2/upload/asset` which returned HTTP 404
// with an HTML "Not Found" page in prod (28.1.0 first HeyGen-reaching
// test). That URL does not exist on HeyGen's API surface.
//
// HeyGen's actual asset upload lives on a SEPARATE subdomain
// (upload.heygen.com, not api.heygen.com) at /v1/asset. Raw binary
// body with the image MIME as content-type. Response envelope:
//   { code: 100, data: { image_key: 'image/...', url: '...' } }
//
// The image_key field name matches what /v2/video/av4/generate
// consumes downstream — no downstream changes needed.
//
// If this URL also 404s in prod (would mean HeyGen deprecated it
// entirely), the fallback is /v3/assets on api.heygen.com which
// uses multipart/form-data and returns asset_id — that would
// require also renaming image_key -> image_asset_id in the av4
// generate call. Ship that as Commit 67 if the legacy URL is dead.

const HEYGEN_UPLOAD_ASSET_URL = `${HEYGEN_UPLOAD_BASE}/v1/asset`;

export interface UploadHeygenImageAssetInput {
  userId: string;
  apiKey: string;
  imageBytes: Uint8Array;
  imageMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  generationJobId?: string;
}

export interface UploadHeygenImageAssetResult {
  ok: boolean;
  imageKey?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeygenAvatarIvErrorCategory;
}

/**
 * Upload reference image bytes to HeyGen. Returns an `image_key` that
 * downstream Avatar IV generation calls reference.
 *
 * The endpoint takes a raw binary body (NOT multipart) with the
 * content-type header set to the image MIME. Response shape:
 *   { code: 100, data: { image_key: 'image/...' } }
 *
 * Uses fetch() directly rather than callProvider() because the body
 * is binary bytes and callProvider stringifies everything as JSON.
 */
export async function uploadHeygenImageAsset(
  input: UploadHeygenImageAssetInput,
): Promise<UploadHeygenImageAssetResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let status = 0;
  let errorMessage: string | undefined;
  let imageKey: string | undefined;

  // Copy into a fresh ArrayBuffer for Blob compatibility (see the
  // same pattern in elevenlabs.ts createInstantVoiceClone).
  const bodyCopy = new Uint8Array(input.imageBytes.byteLength);
  bodyCopy.set(input.imageBytes);

  console.log(
    `[heygen-avatar-iv] upload-asset REQUEST: POST ${HEYGEN_UPLOAD_ASSET_URL} ` +
      `bytes=${bodyCopy.byteLength} mime=${input.imageMimeType} jobId=${input.generationJobId ?? 'null'}`,
  );

  try {
    const res = await fetch(HEYGEN_UPLOAD_ASSET_URL, {
      method: 'POST',
      headers: {
        'X-Api-Key': input.apiKey,
        'Content-Type': input.imageMimeType,
      },
      body: bodyCopy,
      signal: controller.signal,
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      const body = (await res.json()) as HeygenEnvelope<{ image_key?: string; url?: string }>;
      imageKey = body.data?.image_key;
      if (!imageKey) {
        errorMessage =
          `HeyGen upload-asset response missing data.image_key: ` +
          JSON.stringify(body).slice(0, 400);
      }
    } else {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '(unreadable body)';
      }
      errorMessage = `HeyGen upload-asset failed HTTP ${status}: ${bodyText.slice(0, 500)}`;
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `HeyGen upload-asset timed out after ${UPLOAD_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  console.log(
    `[heygen-avatar-iv] upload-asset RESPONSE: ${status} imageKey=${imageKey ?? '(none)'} ` +
      `error=${errorMessage ?? 'null'} latencyMs=${latencyMs}`,
  );

  if (imageKey) {
    return { ok: true, imageKey, latencyMs, httpStatus: status };
  }
  return {
    ok: false,
    latencyMs,
    httpStatus: status,
    errorMessage: errorMessage ?? 'HeyGen upload-asset failed with no error message.',
    errorCategory: classifyHeygenAvatarIvError(status, errorMessage),
  };
}

// =========================================================================
// POST /v2/video/av4/generate — submit Avatar IV image-to-video job
// =========================================================================

const HEYGEN_AVATAR_IV_GENERATE_URL = `${HEYGEN_BASE}/v2/video/av4/generate`;

export interface SubmitHeygenAvatarIvInput {
  userId: string;
  apiKey: string;
  /** From uploadHeygenImageAsset — HeyGen's opaque handle for the ref image. */
  imageKey: string;
  /**
   * Public URL to the voice audio (mp3/wav). ElevenLabs TTS output
   * uploaded to Supabase → the resulting public URL goes here.
   */
  audioUrl: string;
  /** Human-readable title for the HeyGen dashboard. */
  videoTitle: string;
  /**
   * Optional motion/style prompt. Per Polish-28 spec: leave empty —
   * default motion is the desired look.
   */
  customMotionPrompt?: string;
  /** Correlation ID echoed back on webhook payloads (if configured). */
  callbackId?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface SubmitHeygenAvatarIvResult {
  ok: boolean;
  videoId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeygenAvatarIvErrorCategory;
}

export async function submitHeygenAvatarIvGeneration(
  input: SubmitHeygenAvatarIvInput,
): Promise<SubmitHeygenAvatarIvResult> {
  const body: Record<string, unknown> = {
    image_key: input.imageKey,
    audio_url: input.audioUrl,
    video_title: input.videoTitle,
    video_orientation: 'portrait', // 9:16
  };
  if (input.customMotionPrompt && input.customMotionPrompt.trim().length > 0) {
    body['custom_motion_prompt'] = input.customMotionPrompt.trim();
    // Documented flag — HeyGen may enhance short prompts via LLM.
    body['enhance_custom_motion_prompt'] = true;
  }
  if (input.callbackId) body['callback_id'] = input.callbackId;

  console.log(
    `[heygen-avatar-iv] submit REQUEST image_key=${input.imageKey.slice(0, 40)}... ` +
      `audio_url_len=${input.audioUrl.length} motion_prompt_chars=${input.customMotionPrompt?.length ?? 0} ` +
      `jobId=${input.generationJobId ?? 'null'}`,
  );

  const result = await callProvider<HeygenEnvelope<{ video_id?: string }>>({
    userId: input.userId,
    provider: 'heygen',
    url: HEYGEN_AVATAR_IV_GENERATE_URL,
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'content-type': 'application/json',
      Accept: 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      image_key_prefix: input.imageKey.slice(0, 40),
      audio_url_len: input.audioUrl.length,
      video_title: input.videoTitle,
      video_orientation: 'portrait',
      motion_prompt_chars: input.customMotionPrompt?.length ?? 0,
    },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    ...(input.generatedCreativeId ? { generatedCreativeId: input.generatedCreativeId } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      errorCategory: classifyHeygenAvatarIvError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  const errMsg = envelope.error?.message ?? envelope.message;
  if (envelope.error?.code || (envelope.code && envelope.code !== 100)) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: errMsg ?? 'HeyGen Avatar IV submit returned a non-success envelope.',
      errorCategory: classifyHeygenAvatarIvError(result.status, errMsg),
    };
  }
  const videoId = envelope.data?.video_id;
  if (!videoId || typeof videoId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: 'HeyGen Avatar IV submit response is missing data.video_id.',
      errorCategory: 'unknown',
    };
  }
  return {
    ok: true,
    videoId,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { httpStatus: result.status } : {}),
  };
}

// =========================================================================
// GET /v1/video_status.get — poll Avatar IV job status
// =========================================================================

const HEYGEN_VIDEO_STATUS_URL = `${HEYGEN_BASE}/v1/video_status.get`;

export interface CheckHeygenAvatarIvStatusInput {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface CheckHeygenAvatarIvStatusResult {
  ok: boolean;
  status: HeygenAvatarIvVideoStatus;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  errorMessage?: string;
  errorCategory?: HeygenAvatarIvErrorCategory;
  latencyMs: number;
  httpStatus?: number;
}

export async function checkHeygenAvatarIvStatus(
  input: CheckHeygenAvatarIvStatusInput,
): Promise<CheckHeygenAvatarIvStatusResult> {
  const url = `${HEYGEN_VIDEO_STATUS_URL}?video_id=${encodeURIComponent(input.videoId)}`;

  const result = await callProvider<
    HeygenEnvelope<{
      status?: string;
      video_url?: string;
      thumbnail_url?: string;
      duration?: number;
      error?: { message?: string };
    }>
  >({
    userId: input.userId,
    provider: 'heygen',
    url,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { _video_status: input.videoId },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    ...(input.generatedCreativeId ? { generatedCreativeId: input.generatedCreativeId } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      status: 'failed',
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      errorCategory: classifyHeygenAvatarIvError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  const rawStatus = envelope.data?.status ?? 'unknown';
  const normalizedStatus = normalizeAvatarIvStatus(rawStatus);
  const errFromEnvelope = envelope.error?.message ?? envelope.data?.error?.message;

  const base: CheckHeygenAvatarIvStatusResult = {
    ok: true,
    status: normalizedStatus,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { httpStatus: result.status } : {}),
  };
  if (envelope.data?.video_url) base.videoUrl = envelope.data.video_url;
  if (envelope.data?.thumbnail_url) base.thumbnailUrl = envelope.data.thumbnail_url;
  if (typeof envelope.data?.duration === 'number') base.durationSeconds = envelope.data.duration;
  if (normalizedStatus === 'failed') {
    base.errorMessage = errFromEnvelope ?? `HeyGen Avatar IV reported status='${rawStatus}'.`;
    base.errorCategory = classifyHeygenAvatarIvError(result.status, base.errorMessage);
  }
  return base;
}

function normalizeAvatarIvStatus(raw: string): HeygenAvatarIvVideoStatus {
  const s = raw.toLowerCase();
  if (s === 'completed' || s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'processing' || s === 'running' || s === 'queued' || s === 'waiting')
    return 'processing';
  if (s === 'pending' || s === 'created' || s === 'submitted') return 'pending';
  return 'pending';
}

export function isTerminalAvatarIvStatus(status: HeygenAvatarIvVideoStatus): boolean {
  return status === 'completed' || status === 'failed';
}
