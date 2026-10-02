/**
 * Polish-30.0.0 Commit 172: HeyGen Video 1.0 (`heygen-video-1`) client.
 *
 * HeyGen Video is HeyGen's new foundation model (announced Sep 2026).
 * Built on MiniMax H3, post-trained by HeyGen. ONE API call renders
 * subject + setting + sound + lip-sync in a single pass — eliminating
 * the whole Nano-Banana-still → Omni-seed-clip → V2V-extend-chain →
 * server-side-concat pipeline we built for polish30. Promo pricing
 * $0.01/sec through October 2026, normally $0.02/sec.
 *
 * Three generation modes:
 *   - text_to_video    : plain prompt → video
 *   - image_to_video   : prompt + one `image` → video that starts from
 *                        the image, animated and lip-synced
 *   - reference_to_video : prompt + up to 9 `reference_images` of the
 *                        SAME character → character consistency across
 *                        clips (this is the mode polish31 uses — one
 *                        Nano Banana char still becomes the reference
 *                        for every clip in a variation).
 *
 * This is the SINGLE most important simplification across the project:
 * polish23 (kie.ai Veo), polish25/26 (HeyGen v3 pre-cast), polish28
 * (HeyGen Avatar IV lip-sync BYOK), polish29 (Dreamina/Seedance credits),
 * polish30 (Omni/Google Flow credits) can all be replaced by one direct
 * HeyGen Video 1.0 call per clip. The user explicitly asked to converge
 * on ONE simple API — this is it.
 *
 * ## Auth
 *
 * HeyGen Video 1.0 ships on the v3 API with x-api-key header auth.
 * Same key the polish28/26 clients use. BYOK per user.
 *
 * ## Endpoints
 *
 *   POST https://api.heygen.com/v3/models/videos           — submit
 *   GET  https://api.heygen.com/v3/models/videos/{id}      — poll
 *   POST https://api.heygen.com/v3/assets                   — upload asset
 *                                                             (image/audio/video)
 *
 * ## Submit response
 *
 *   { data: { video_id: "..." } }
 *
 * ## Poll response
 *
 *   { data: {
 *       status: "pending" | "processing" | "completed" | "failed",
 *       video_url?: "...",     // only when status === "completed"
 *       error?: { message, code },
 *     } }
 *
 * ## Asset response
 *
 *   { data: { id: "asset_..." } }
 */

import type { Buffer } from 'node:buffer';
import { callProvider } from './chokepoint';

const HEYGEN_V3_BASE = 'https://api.heygen.com/v3';
// Polish-30.0.3 Commit 175: bumped submit 45s → 120s and poll 20s → 45s.
// First real-world submit timed out somewhere with "Provider call timed
// out after 60000ms" during the per-clip submit chain; even though the
// chokepoint message doesn't match any explicit timeout in this file,
// the simplest explanation is HeyGen's /v3/models/videos endpoint is
// slow to respond under load. Doubling the budget removes any chance
// this file is the culprit and makes the next failure error-message
// unambiguous.
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 45_000;
const ASSET_UPLOAD_TIMEOUT_MS = 180_000;

export type HeygenVideo1Mode = 'text_to_video' | 'image_to_video' | 'reference_to_video';

export type HeygenVideo1Resolution = '480p' | '768p';

/**
 * Supported aspect ratios on heygen-video-1 per the launch spec.
 * 9:16 is the one polish31 uses — vertical UGC. Everything else is
 * listed for forward compatibility; downstream workers don't branch on
 * it beyond passing through.
 */
export type HeygenVideo1AspectRatio = '9:16' | '16:9' | '1:1' | '4:3' | '3:4';

/**
 * Clip duration in whole seconds. HeyGen Video 1.0 accepts 5-15s
 * inclusive. polish31 uses 8s to match the Seedance clip length we've
 * been proving the shared ugc-prose-prompt builder against — same
 * ~24 words-per-clip pacing lands cleanly on either model.
 */
export type HeygenVideo1DurationSeconds = 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export interface SubmitHeygenVideo1Input {
  userId: string;
  apiKey: string;
  prompt: string;
  mode: HeygenVideo1Mode;
  durationSeconds: HeygenVideo1DurationSeconds;
  resolution?: HeygenVideo1Resolution;
  aspectRatio?: HeygenVideo1AspectRatio;
  /** Optional deterministic seed for reproducibility. */
  seed?: number;
  /** image_to_video: a single starting image, as an asset_id. */
  image?: { assetId: string };
  /**
   * reference_to_video: up to 9 reference images of the same subject.
   * Pass asset_ids returned by uploadHeygenAsset. polish31 uses ONE
   * reference image (the Nano Banana char still) replicated across
   * every clip of a variation for character consistency.
   */
  referenceImages?: Array<{ assetId: string }>;
  /** Optional reference audio asset for voice conditioning. */
  referenceAudio?: { assetId: string };
  /**
   * Prompt enhancement mode. Polish-30.0.2 Commit 174: HeyGen's
   * `prompt_enhancement` field is a STRING ENUM (one of 'turbo' |
   * 'quality' | 'default' | 'disabled'), not a boolean as my Commit-172
   * guess assumed. First live run hit:
   *   "Input should be 'turbo', 'quality', 'default' or 'disabled'"
   *
   * Default omitted so HeyGen picks its own default (our ugc-prose-
   * prompt builder already supplies the full scene/camera/delivery
   * prose so we don't need enhancement). polish31 can pass 'disabled'
   * if we observe HeyGen injecting cinematic language on top of our
   * hand-tuned prose.
   */
  promptEnhancement?: 'turbo' | 'quality' | 'default' | 'disabled';
  generationJobId?: string;
}

export interface SubmitHeygenVideo1Result {
  ok: boolean;
  videoId?: string;
  errorMessage?: string;
  status: number;
  latencyMs: number;
}

export interface PollHeygenVideo1Input {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId?: string;
}

export type HeygenVideo1Status = 'pending' | 'processing' | 'completed' | 'failed';

export interface PollHeygenVideo1Result {
  status: HeygenVideo1Status;
  videoUrl?: string;
  errorMessage?: string;
  rawStatus: string | null;
  raw: Record<string, unknown>;
}

export interface UploadHeygenAssetInput {
  userId: string;
  apiKey: string;
  buffer: Buffer;
  filename: string;
  /** MIME type — e.g. image/png, image/jpeg, audio/mpeg. */
  contentType: string;
  generationJobId?: string;
}

export interface UploadHeygenAssetResult {
  ok: boolean;
  assetId?: string;
  errorMessage?: string;
  status: number;
  latencyMs: number;
}

// -----------------------------------------------------------------
// Submit
// -----------------------------------------------------------------

export async function submitHeygenVideo1(
  input: SubmitHeygenVideo1Input,
): Promise<SubmitHeygenVideo1Result> {
  const body: Record<string, unknown> = {
    model: 'heygen-video-1',
    prompt: input.prompt,
    mode: input.mode,
    duration_seconds: input.durationSeconds,
    resolution: input.resolution ?? '768p',
    aspect_ratio: input.aspectRatio ?? '9:16',
  };
  // Polish-30.0.2 Commit 174: only send prompt_enhancement when the
  // caller explicitly set it. HeyGen rejects a boolean here — the
  // field is a string enum ('turbo' | 'quality' | 'default' |
  // 'disabled'). Omit → HeyGen picks its own default.
  if (input.promptEnhancement) {
    body['prompt_enhancement'] = input.promptEnhancement;
  }
  // Polish-30.0.4 Commit 176: HeyGen's media-reference fields are
  // DISCRIMINATED UNIONS. Attempt 1 (Commit 172) sent bare
  // `{ asset_id: '...' }` which HeyGen's Pydantic validator rejected
  // with "Unable to extract tag using discriminator 'type'". The
  // documented tag shape across HeyGen v2 / v3 is
  //   { type: 'asset', asset_id: '...' }
  // mirroring their avatar shape (`{ type: 'avatar', avatar_id: ... }`).
  // Applied to image_to_video / reference_to_video image/audio refs.
  if (typeof input.seed === 'number') body['seed'] = input.seed;
  if (input.image) {
    body['image'] = { type: 'asset', asset_id: input.image.assetId };
  }
  if (input.referenceImages && input.referenceImages.length > 0) {
    body['reference_images'] = input.referenceImages
      .slice(0, 9)
      .map((r) => ({ type: 'asset', asset_id: r.assetId }));
  }
  if (input.referenceAudio) {
    body['reference_audio'] = { type: 'asset', asset_id: input.referenceAudio.assetId };
  }

  const r = await callProvider<Record<string, unknown>>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_V3_BASE}/models/videos`,
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: body,
    generationJobId: input.generationJobId,
  });

  if (!r.ok) {
    return {
      ok: false,
      errorMessage: `HeyGen Video 1.0 submit failed: ${r.errorMessage}`,
      status: r.status,
      latencyMs: r.latencyMs,
    };
  }

  const videoId = extractVideoId(r.data);
  if (!videoId) {
    return {
      ok: false,
      errorMessage: `HeyGen Video 1.0 submit: no video_id in response`,
      status: r.status,
      latencyMs: r.latencyMs,
    };
  }

  return { ok: true, videoId, status: r.status, latencyMs: r.latencyMs };
}

function extractVideoId(data: Record<string, unknown>): string | undefined {
  const d = data['data'] as Record<string, unknown> | undefined;
  const direct = d?.['video_id'];
  if (typeof direct === 'string' && direct) return direct;
  const flat = data['video_id'];
  if (typeof flat === 'string' && flat) return flat;
  return undefined;
}

// -----------------------------------------------------------------
// Poll
// -----------------------------------------------------------------

export async function pollHeygenVideo1(
  input: PollHeygenVideo1Input,
): Promise<PollHeygenVideo1Result> {
  const r = await callProvider<Record<string, unknown>>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_V3_BASE}/models/videos/${encodeURIComponent(input.videoId)}`,
    method: 'GET',
    headers: {
      'x-api-key': input.apiKey,
    },
    timeoutMs: POLL_TIMEOUT_MS,
    generationJobId: input.generationJobId,
  });

  if (!r.ok) {
    return {
      status: 'failed',
      errorMessage: `HeyGen Video 1.0 poll failed: ${r.errorMessage}`,
      rawStatus: null,
      raw: (r.rawBody as Record<string, unknown>) ?? {},
    };
  }

  const raw = r.data;
  const payload = (raw['data'] as Record<string, unknown> | undefined) ?? raw;
  const rawStatus = typeof payload['status'] === 'string' ? (payload['status'] as string) : null;
  const status = normalizeStatus(rawStatus);
  const videoUrl =
    typeof payload['video_url'] === 'string' ? (payload['video_url'] as string) : undefined;
  const errObj = payload['error'] as Record<string, unknown> | undefined;
  const errorMessage =
    typeof errObj?.['message'] === 'string'
      ? (errObj['message'] as string)
      : typeof payload['error_message'] === 'string'
        ? (payload['error_message'] as string)
        : undefined;

  return { status, videoUrl, errorMessage, rawStatus, raw };
}

function normalizeStatus(raw: string | null): HeygenVideo1Status {
  const s = (raw ?? '').toLowerCase();
  if (s === 'completed' || s === 'succeeded' || s === 'done') return 'completed';
  if (s === 'failed' || s === 'error' || s === 'canceled' || s === 'cancelled') return 'failed';
  if (s === 'processing' || s === 'running') return 'processing';
  return 'pending';
}

// -----------------------------------------------------------------
// Asset upload
// -----------------------------------------------------------------

/**
 * Uploads one asset (image/audio/video) to HeyGen's asset store.
 *
 * Polish-30.0.1 Commit 173 hotfix: HeyGen's /v3/assets endpoint is
 * MULTIPART, not raw binary. First live test failed with:
 *   "File is required. Send a multipart/form-data request with a
 *    'file' field."
 * My Commit-172 wrapper sent raw bytes with Content-Type: image/png
 * + x-filename header on the assumption HeyGen Video 1.0 reused the
 * raw-binary pattern some other providers use (useapi.net's Dreamina
 * asset upload, Replicate signed URLs). HeyGen wants a classic
 * multipart form with a `file` field. Fix: build a FormData with
 * the buffer wrapped in a Blob under the field name "file", drop the
 * x-filename header (filename rides as the third arg to form.append),
 * and let fetch pick its own multipart boundary (don't send a manual
 * content-type — overriding the boundary would corrupt the body).
 */
export async function uploadHeygenAsset(
  input: UploadHeygenAssetInput,
): Promise<UploadHeygenAssetResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ASSET_UPLOAD_TIMEOUT_MS);
  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.contentType });
    form.append('file', blob, input.filename);
    const res = await fetch(`${HEYGEN_V3_BASE}/assets`, {
      method: 'POST',
      headers: {
        'x-api-key': input.apiKey,
        // No content-type — undici sets multipart/form-data with the
        // right boundary when we pass a FormData body.
      },
      body: form,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { _non_json_body: text.slice(0, 2048) };
    }
    const latencyMs = Date.now() - t0;
    if (res.status < 200 || res.status >= 300) {
      const errorMessage = extractErrorMessage(parsed) ?? `HTTP ${res.status}`;
      return {
        ok: false,
        errorMessage: `HeyGen asset upload failed: ${errorMessage}`,
        status: res.status,
        latencyMs,
      };
    }
    const assetId = extractAssetId(parsed);
    if (!assetId) {
      return {
        ok: false,
        errorMessage: `HeyGen asset upload: no asset id in response`,
        status: res.status,
        latencyMs,
      };
    }
    return { ok: true, assetId, status: res.status, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const errorMessage = isAbort
      ? `HeyGen asset upload timed out after ${ASSET_UPLOAD_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, errorMessage, status: 0, latencyMs };
  } finally {
    clearTimeout(timeout);
  }
}

function extractAssetId(data: Record<string, unknown>): string | undefined {
  const d = data['data'] as Record<string, unknown> | undefined;
  const direct = d?.['id'];
  if (typeof direct === 'string' && direct) return direct;
  const flat = data['id'];
  if (typeof flat === 'string' && flat) return flat;
  const assetId = d?.['asset_id'] ?? data['asset_id'];
  if (typeof assetId === 'string' && assetId) return assetId;
  return undefined;
}

function extractErrorMessage(body: Record<string, unknown>): string | null {
  const err = body['error'];
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>)['message'];
    if (typeof msg === 'string') return msg;
  }
  if (typeof body['message'] === 'string') return body['message'] as string;
  if (typeof body['msg'] === 'string') return body['msg'] as string;
  return null;
}

// -----------------------------------------------------------------
// Pricing (launch promo $0.01/sec through October 2026).
// -----------------------------------------------------------------

/** $/sec at launch promo rate. */
export const HEYGEN_VIDEO_1_PROMO_USD_PER_SEC = 0.01;
/** $/sec at post-launch rate. */
export const HEYGEN_VIDEO_1_STANDARD_USD_PER_SEC = 0.02;

/**
 * Current effective rate. The promo window closes end of October 2026;
 * after that, bump the default to STANDARD. Kept as a function so the
 * runtime value picks the right rate without a redeploy on Nov 1.
 */
export function heygenVideo1UsdPerSecond(now: Date = new Date()): number {
  const PROMO_END = Date.UTC(2026, 10, 1); // Nov 1 2026 UTC (month is 0-indexed)
  return now.getTime() < PROMO_END
    ? HEYGEN_VIDEO_1_PROMO_USD_PER_SEC
    : HEYGEN_VIDEO_1_STANDARD_USD_PER_SEC;
}

export function estimateHeygenVideo1ClipUsd(durationSeconds: number, now?: Date): number {
  return Math.max(0, durationSeconds) * heygenVideo1UsdPerSecond(now);
}
