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
// POST upload.heygen.com/v1/asset — upload audio bytes (returns asset_id)
// =========================================================================
//
// Polish-28.1.7 Commit 72: HeyGen accepts audio via 3 paths (script+voice_id,
// audio_url, audio_asset_id). audio_url has been unreliable in prod
// (28.1.4-28.1.6 output was silent even when Supabase URL was verifiably
// public) — HeyGen's servers apparently drop the audio silently when
// they can't fetch the URL. Uploading the audio bytes to HeyGen's own
// asset storage bypasses this: their servers already have the file, no
// external fetch needed. Same endpoint as image upload, different
// content-type + returned field.

export interface UploadHeygenAudioAssetInput {
  userId: string;
  apiKey: string;
  audioBytes: Uint8Array;
  audioMimeType: 'audio/mpeg' | 'audio/mp3' | 'audio/wav';
  generationJobId?: string;
}

export interface UploadHeygenAudioAssetResult {
  ok: boolean;
  audioAssetId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeygenAvatarIvErrorCategory;
}

export async function uploadHeygenAudioAsset(
  input: UploadHeygenAudioAssetInput,
): Promise<UploadHeygenAudioAssetResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let status = 0;
  let errorMessage: string | undefined;
  let audioAssetId: string | undefined;

  const bodyCopy = new Uint8Array(input.audioBytes.byteLength);
  bodyCopy.set(input.audioBytes);

  console.log(
    `[heygen-avatar-iv] upload-audio-asset REQUEST: POST ${HEYGEN_UPLOAD_ASSET_URL} ` +
      `bytes=${bodyCopy.byteLength} mime=${input.audioMimeType} jobId=${input.generationJobId ?? 'null'}`,
  );

  try {
    const res = await fetch(HEYGEN_UPLOAD_ASSET_URL, {
      method: 'POST',
      headers: {
        'X-Api-Key': input.apiKey,
        'Content-Type': input.audioMimeType,
      },
      body: bodyCopy,
      signal: controller.signal,
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      // HeyGen's audio-upload response envelope carries a few possible
      // field names depending on API version. Extract defensively:
      //   { code: 100, data: { asset_id: 'audio/...' } }        // newer
      //   { code: 100, data: { audio_asset_id: 'audio/...' } }  // older
      //   { code: 100, data: { id: 'audio/...' } }              // fallback
      const body = (await res.json()) as HeygenEnvelope<{
        asset_id?: string;
        audio_asset_id?: string;
        id?: string;
      }>;
      audioAssetId = body.data?.asset_id ?? body.data?.audio_asset_id ?? body.data?.id;
      if (!audioAssetId) {
        errorMessage =
          `HeyGen audio upload response missing asset id (checked asset_id / ` +
          `audio_asset_id / id): ${JSON.stringify(body).slice(0, 400)}`;
      }
    } else {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      errorMessage = `HeyGen audio-upload failed HTTP ${status}: ${bodyText.slice(0, 400)}`;
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `HeyGen audio-upload timed out after ${UPLOAD_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  console.log(
    `[heygen-avatar-iv] upload-audio-asset RESPONSE: ${status} assetId=${audioAssetId ?? '(none)'} ` +
      `error=${errorMessage ?? 'null'} latencyMs=${latencyMs}`,
  );

  if (audioAssetId) {
    return { ok: true, audioAssetId, latencyMs, httpStatus: status };
  }
  return {
    ok: false,
    latencyMs,
    httpStatus: status,
    errorMessage: errorMessage ?? 'HeyGen audio-upload failed with no error message.',
    errorCategory: classifyHeygenAvatarIvError(status, errorMessage),
  };
}

// =========================================================================
// GET /v2/voices — fetch HeyGen voice roster + match to persona
// =========================================================================
//
// Polish-28.2.0 Commit 73: HeyGen native TTS pivot. External audio
// (audio_url, audio_asset_id) has been unreliable across three
// attempts (28.1.4-28.1.7 all produced silent output). Instead of
// providing audio, we now pass a script + HeyGen voice_id — HeyGen
// generates the audio internally and bakes it into the video. Their
// pipeline end-to-end, no external fetch to fail.

const HEYGEN_VOICES_URL = `${HEYGEN_BASE}/v2/voices`;

export interface HeygenVoice {
  voice_id: string;
  language: string;
  gender: 'male' | 'female' | 'neutral' | string;
  name: string;
  preview_audio?: string;
  support_pause?: boolean;
  emotion_support?: boolean;
}

export interface FetchHeygenVoicesResult {
  ok: boolean;
  voices: HeygenVoice[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function fetchHeygenVoices(input: {
  userId: string;
  apiKey: string;
  generationJobId?: string;
}): Promise<FetchHeygenVoicesResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let status = 0;
  let errorMessage: string | undefined;
  let voices: HeygenVoice[] = [];
  try {
    const res = await fetch(HEYGEN_VOICES_URL, {
      method: 'GET',
      headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      const body = (await res.json()) as HeygenEnvelope<{ voices?: HeygenVoice[] }>;
      voices = body.data?.voices ?? [];
    } else {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      errorMessage = `HeyGen fetch-voices failed HTTP ${status}: ${bodyText.slice(0, 400)}`;
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `HeyGen fetch-voices timed out after ${CHECK_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  console.log(
    `[heygen] fetch-voices ${status} count=${voices.length} error=${errorMessage ?? 'null'} latencyMs=${latencyMs}`,
  );
  return errorMessage
    ? { ok: false, voices: [], latencyMs, httpStatus: status, errorMessage }
    : { ok: true, voices, latencyMs, httpStatus: status };
}

/**
 * Pick the best-matching HeyGen voice for a persona description.
 * Heuristic: filter to English voices matching the target gender;
 * prefer voices with emotion_support; fall back to first English
 * voice if no gender match. Throws if no English voices exist at
 * all (should never happen — HeyGen ships hundreds by default).
 *
 * Persona → gender extraction uses the same keyword-scan as the
 * ElevenLabs matcher in @mbb/shared.
 */
export function matchHeygenVoiceForPersona(
  voices: readonly HeygenVoice[],
  personaDescription: string,
): HeygenVoice {
  if (voices.length === 0) {
    throw new Error('matchHeygenVoiceForPersona: empty voice list from HeyGen.');
  }
  const lower = personaDescription.toLowerCase();
  const femaleHit = /\b(woman|female|girl|lady|she\b|her\b|hers|feminine)\b/.test(lower);
  const maleHit = /\b(man|male|guy|boy|dude|he\b|him\b|his\b|masculine)\b/.test(lower);
  const targetGender: 'female' | 'male' | null =
    femaleHit && !maleHit ? 'female' : maleHit && !femaleHit ? 'male' : null;

  const isEnglish = (v: HeygenVoice): boolean =>
    typeof v.language === 'string' && v.language.toLowerCase().startsWith('en');
  const englishVoices = voices.filter(isEnglish);
  if (englishVoices.length === 0) {
    // Fallback: any language, first voice
    return voices[0]!;
  }
  if (targetGender) {
    const matched = englishVoices.filter(
      (v) => typeof v.gender === 'string' && v.gender.toLowerCase() === targetGender,
    );
    // Prefer emotion-support voices for UGC (more natural delivery)
    const withEmotion = matched.filter((v) => v.emotion_support === true);
    if (withEmotion.length > 0) return withEmotion[0]!;
    if (matched.length > 0) return matched[0]!;
  }
  // No gender match — first English voice with emotion support, else first English
  const englishWithEmotion = englishVoices.filter((v) => v.emotion_support === true);
  return englishWithEmotion[0] ?? englishVoices[0]!;
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
   * Polish-28.2.0 Commit 73: PREFERRED audio path — HeyGen native TTS.
   * Pass the script text + a HeyGen voice_id; HeyGen generates audio
   * internally and bakes it in. Guaranteed audio (no external fetch
   * to fail). Wins over audioAssetId / audioUrl if provided.
   */
  script?: string;
  voiceId?: string;
  /**
   * Polish-28.1.7 Commit 72: HeyGen-hosted asset id (uploaded via
   * uploadHeygenAudioAsset). Kept for compat but silent-output
   * failures in 28.1.7 make it unreliable; prefer script + voiceId.
   */
  audioAssetId?: string;
  /**
   * Last-resort audio path — public URL to voice audio (mp3/wav).
   * HeyGen frequently drops audio when it can't fetch this; only
   * used when no script/voiceId AND no audioAssetId are provided.
   */
  audioUrl?: string;
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
  const hasScript = !!(input.script && input.voiceId);
  if (!hasScript && !input.audioAssetId && !input.audioUrl) {
    return {
      ok: false,
      latencyMs: 0,
      errorMessage:
        'submitHeygenAvatarIvGeneration requires ONE of: (script + voiceId), audioAssetId, or audioUrl.',
      errorCategory: 'validation',
    };
  }
  // Polish-28.2.0 Commit 73: audio-source priority order:
  //   1. script + voice_id — HeyGen native TTS (guaranteed audio)
  //   2. audio_asset_id — HeyGen-hosted asset (28.1.7, silent in prod)
  //   3. audio_url — external URL (28.1.4-28.1.6, silent in prod)
  //
  // Polish-28.2.5 Commit 78: `video_orientation: 'portrait'` was
  // silently ignored by HeyGen — outputs were coming back non-9:16
  // even though the input character was 9:16 (Commit 77 fixed Nano
  // Banana to emit 9:16). Real HeyGen fields: `aspect_ratio: '9:16'`
  // (documented) + `dimension: {width, height}` (defensive fallback).
  // Keeping video_orientation too since HeyGen ignores unknown fields.
  const body: Record<string, unknown> = {
    image_key: input.imageKey,
    video_title: input.videoTitle,
    aspect_ratio: '9:16',
    dimension: { width: 1080, height: 1920 },
    video_orientation: 'portrait', // legacy — kept for safety, ignored if unrecognized
  };
  if (hasScript) {
    body['script'] = input.script;
    body['voice_id'] = input.voiceId;
  } else if (input.audioAssetId) {
    body['audio_asset_id'] = input.audioAssetId;
  } else if (input.audioUrl) {
    body['audio_url'] = input.audioUrl;
  }
  if (input.customMotionPrompt && input.customMotionPrompt.trim().length > 0) {
    body['custom_motion_prompt'] = input.customMotionPrompt.trim();
    // Documented flag — HeyGen may enhance short prompts via LLM.
    body['enhance_custom_motion_prompt'] = true;
  }
  if (input.callbackId) body['callback_id'] = input.callbackId;

  const audioMode = hasScript
    ? `script_len=${input.script?.length ?? 0}_voice=${input.voiceId?.slice(0, 20) ?? ''}`
    : input.audioAssetId
      ? `asset_id=${input.audioAssetId.slice(0, 40)}`
      : `url_len=${input.audioUrl?.length ?? 0}`;
  console.log(
    `[heygen-avatar-iv] submit REQUEST image_key=${input.imageKey.slice(0, 40)}... ` +
      `audio_${audioMode} motion_prompt_chars=${input.customMotionPrompt?.length ?? 0} ` +
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
      audio_asset_id: input.audioAssetId ?? null,
      audio_url: input.audioUrl ?? null,
      audio_url_len: input.audioUrl?.length ?? 0,
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
