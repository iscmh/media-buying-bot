/**
 * Polish-26 Commit 61: HeyGen v3 API client for the Polish-26
 * managed Instant UGC pipeline.
 *
 * Deliberately parallel to the legacy Polish-24 heygen-client.ts —
 * that file wraps the v1/v2 avatar-talking-head flow behind BYOK
 * per user. This file targets the v3 endpoints on a PAYG platform
 * key (HEYGEN_MANAGED_KEY env, resolved via resolve-heygen-
 * managed-key.ts) so both can coexist during the Polish-26 rollout.
 *
 * Endpoints (verified via developer portal + tryAGI OpenAPI mirror,
 * see docs.heygen.com/reference/*):
 *   - Base: https://api.heygen.com
 *   - GET  /v2/avatars                          — full stock avatar list
 *   - GET  /v2/voices                           — full voice list
 *   - POST /v3/videos                           — create video (Avatar V default)
 *   - GET  /v1/video_status.get?video_id=<id>   — poll status
 *   - POST /v1/webhook/endpoint.add             — register webhook (Commit 62)
 *
 * v3 was chosen over v2 because v1+v2 sunset October 31, 2026 —
 * shipping on v2 today would just repay the migration cost in Q4.
 * (The legacy Polish-24 client still uses v1/v2 — planned deprecation
 * once the new track is proven.)
 *
 * Auth: X-Api-Key header (NOT Authorization: Bearer). Same for all
 * endpoints — one platform key, full account access, no per-key
 * scoping (a real ops concern documented in the pricing research).
 *
 * PAYG pricing (2026, from developer portal):
 *   - Avatar V (default engine): $0.05/sec = $3/min = $1.50/30-sec video
 *   - Avatar IV (photoreal 1080p): $4/min = $2.00/30-sec video
 *   - Avatar IV 4K: $5/min = $2.50/30-sec video
 * There is NO Avatar III API tier anymore — the $1/min figure quoted
 * pre-Feb 2026 was legacy Studio-plan credit pricing, not API dollars.
 */
import { z } from 'zod';
import { callProvider } from './chokepoint';

const HEYGEN_BASE = 'https://api.heygen.com';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const AVATARS_TIMEOUT_MS = 30_000;
const VOICES_TIMEOUT_MS = 30_000;

// =========================================================================
// Types
// =========================================================================

export interface HeygenAvatarV3 {
  avatar_id: string;
  avatar_name: string;
  gender: string; // "male" | "female" (HeyGen uses lowercase)
  preview_image_url: string;
  preview_video_url?: string;
  premium?: boolean;
  type?: string; // "studio_avatar" | "digital_twin" | "photo_avatar"
  tags?: string[];
}

export interface HeygenVoiceV3 {
  voice_id: string;
  name: string;
  language?: string;
  gender?: string;
  preview_audio_url?: string;
  support_pause?: boolean;
  emotion_support?: boolean;
}

export type HeygenVideoStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type HeygenErrorCategory =
  | 'auth' // 401
  | 'not_found' // 404
  | 'validation' // 400
  | 'quota_exceeded' // 402 or credit-exhausted body
  | 'rate_limit' // 429
  | 'moderation' // 400/422 with moderation-language body
  | 'server' // 5xx
  | 'timeout' // status=0 with timeout in message
  | 'unknown';

export type HeygenEngine = 'avatar_v' | 'avatar_iv';

// =========================================================================
// Cost constants + estimator
// =========================================================================

/** Avatar V default engine — per-second billing. $3/min = $0.05/sec. */
export const HEYGEN_USD_PER_SECOND_AVATAR_V = 0.05;
/** Avatar IV photoreal 1080p. $4/min = ~$0.0667/sec. */
export const HEYGEN_USD_PER_SECOND_AVATAR_IV_1080P = 4 / 60;
/** Avatar IV photoreal 4K. $5/min = ~$0.0833/sec. */
export const HEYGEN_USD_PER_SECOND_AVATAR_IV_4K = 5 / 60;

/** Default video length assumption when caller doesn't know yet. */
export const HEYGEN_DEFAULT_VIDEO_SECONDS = 30;

export interface EstimateHeygenVideoCostInput {
  engine?: HeygenEngine;
  seconds?: number;
  /** Only meaningful for engine='avatar_iv'. Default 1080p. */
  resolution?: '1080p' | '4k';
}

export function estimateHeygenVideoCostUsd(input: EstimateHeygenVideoCostInput = {}): number {
  const seconds = input.seconds ?? HEYGEN_DEFAULT_VIDEO_SECONDS;
  const engine = input.engine ?? 'avatar_v';
  if (engine === 'avatar_v') {
    return HEYGEN_USD_PER_SECOND_AVATAR_V * seconds;
  }
  // avatar_iv
  const perSec =
    input.resolution === '4k'
      ? HEYGEN_USD_PER_SECOND_AVATAR_IV_4K
      : HEYGEN_USD_PER_SECOND_AVATAR_IV_1080P;
  return perSec * seconds;
}

// =========================================================================
// Typed errors (mirror MakeUGC pattern)
// =========================================================================

export interface HeygenPersona {
  gender: 'male' | 'female';
  age_range: string;
  ethnicity?: string;
  look?: string;
  voice_tone?: string;
  language?: string;
}

export class HeygenNoMatchingAvatarError extends Error {
  readonly persona: HeygenPersona;
  readonly candidatesConsidered: number;
  readonly hardFiltersApplied: readonly string[];
  constructor(
    persona: HeygenPersona,
    candidatesConsidered: number,
    hardFiltersApplied: readonly string[],
  ) {
    super(
      `No HeyGen avatar matches persona ` +
        `{gender: ${persona.gender}, age_range: ${persona.age_range}, ` +
        `ethnicity: ${persona.ethnicity ?? '(any)'}}. ` +
        `${candidatesConsidered} avatars considered, hard filters: ` +
        `[${hardFiltersApplied.join(', ')}]. ` +
        `Refresh the HeyGen avatar index or loosen the persona filters.`,
    );
    this.name = 'HeygenNoMatchingAvatarError';
    this.persona = persona;
    this.candidatesConsidered = candidatesConsidered;
    this.hardFiltersApplied = hardFiltersApplied;
  }
}

export class HeygenQuotaExhaustedError extends Error {
  constructor(rawMessage?: string) {
    super(
      `HeyGen account is out of credit / PAYG balance. Top up at app.heygen.com. ` +
        `Raw: ${rawMessage ?? '(none)'}`,
    );
    this.name = 'HeygenQuotaExhaustedError';
  }
}

export class HeygenModerationRejectedError extends Error {
  readonly rawMessage: string;
  constructor(rawMessage: string) {
    super(
      `HeyGen rejected the script under its content policy. ` +
        `Aggressive-vertical language (guaranteed income, get-rich claims, ` +
        `explicit crypto returns, scammy-tone hooks) is likely to trip ` +
        `moderation — rewrite the script or route through the Polish-25 ` +
        `MakeUGC pipeline (weaker moderation). Raw: ${rawMessage}`,
    );
    this.name = 'HeygenModerationRejectedError';
    this.rawMessage = rawMessage;
  }
}

// HeyGen's script length cap. The docs say 1–5000 chars per input block;
// our Claude condenser targets the same 1500-char cap MakeUGC uses so
// the same POLISH25_CLAUDE_SCRIPT_CONDENSER_SYSTEM_PROMPT stays fit-for-
// purpose. Ceiling here is defense-in-depth against a longer script
// slipping through — HeyGen would reject with a validation error anyway.
export const HEYGEN_VOICE_SCRIPT_MAX_CHARS = 5000;

export class HeygenScriptTooLongError extends Error {
  readonly chars: number;
  constructor(chars: number) {
    super(
      `HeyGen script is ${chars} chars — max ${HEYGEN_VOICE_SCRIPT_MAX_CHARS} per input block. ` +
        `Trim the script or split into multiple video_inputs entries.`,
    );
    this.name = 'HeygenScriptTooLongError';
    this.chars = chars;
  }
}

export function assertHeygenScriptLength(script: string): void {
  if (typeof script !== 'string') {
    throw new HeygenScriptTooLongError(0);
  }
  if (script.length > HEYGEN_VOICE_SCRIPT_MAX_CHARS) {
    throw new HeygenScriptTooLongError(script.length);
  }
}

// =========================================================================
// Transient error detection
// =========================================================================

export const HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  'timeout',
  '502',
  '503',
  '504',
  'try again',
  'rate limit',
  'server error',
  'temporarily',
  'gateway',
  'bad gateway',
  'gateway timeout',
  'internal server',
];

export function isHeygenTransientError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return false;
  const lower = errorMessage.toLowerCase();
  return HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// =========================================================================
// Error classifier
// =========================================================================

export function classifyHeygenError(
  status: number | undefined,
  message: string | undefined,
): HeygenErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota_exceeded';
  if (typeof message === 'string') {
    if (/moderation|content policy|policy violation|violates/i.test(message)) {
      return 'moderation';
    }
    if (/credit|balance|insufficient|quota/i.test(message)) {
      return 'quota_exceeded';
    }
    if (status === 400 || status === 422) return 'validation';
    if (status === 0 && /timeout|aborted/i.test(message)) return 'timeout';
  }
  if (typeof status === 'number' && status >= 500) return 'server';
  if (status === 400 || status === 422) return 'validation';
  return 'unknown';
}

// =========================================================================
// Response envelope helpers
// =========================================================================

/** HeyGen v3 envelope: { error: null|{code,message}, data: {...} }. */
interface HeygenEnvelope<T> {
  error?: { code?: string; message?: string } | null;
  data?: T;
  // Some legacy v1 endpoints return top-level {code, message, data} —
  // we defensively read both shapes.
  code?: number;
  message?: string;
}

interface HeygenAvatarListData {
  avatars?: HeygenAvatarV3[];
}

interface HeygenVoiceListData {
  voices?: HeygenVoiceV3[];
}

interface HeygenCreateVideoData {
  video_id?: string;
}

interface HeygenStatusData {
  status?: string;
  video_url?: string;
  url?: string;
  thumbnail_url?: string;
  duration?: number;
  caption_url?: string;
  error?: { message?: string } | null;
}

// =========================================================================
// GET /v2/avatars
// =========================================================================

export interface ListHeygenAvatarsInput {
  userId: string;
  apiKey: string;
  generationJobId?: string;
}

export interface HeygenAvatarsListResult {
  ok: boolean;
  avatars: HeygenAvatarV3[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function listHeygenAvatars(
  input: ListHeygenAvatarsInput,
): Promise<HeygenAvatarsListResult> {
  const result = await callProvider<HeygenEnvelope<HeygenAvatarListData>>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_BASE}/v2/avatars`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: AVATARS_TIMEOUT_MS,
    requestBodyForLog: { _list_avatars: true },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      avatars: [],
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  }
  const envelope = result.data;
  if (envelope.error && envelope.error.code) {
    return {
      ok: false,
      avatars: [],
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: envelope.error.message ?? envelope.error.code,
    };
  }
  const raw = Array.isArray(envelope.data?.avatars) ? envelope.data!.avatars! : [];
  return {
    ok: true,
    avatars: raw,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { httpStatus: result.status } : {}),
  };
}

// =========================================================================
// GET /v2/voices
// =========================================================================

export interface ListHeygenVoicesInput {
  userId: string;
  apiKey: string;
  generationJobId?: string;
}

export interface HeygenVoicesListResult {
  ok: boolean;
  voices: HeygenVoiceV3[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function listHeygenVoices(
  input: ListHeygenVoicesInput,
): Promise<HeygenVoicesListResult> {
  const result = await callProvider<HeygenEnvelope<HeygenVoiceListData>>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_BASE}/v2/voices`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: VOICES_TIMEOUT_MS,
    requestBodyForLog: { _list_voices: true },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      voices: [],
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  }
  const envelope = result.data;
  if (envelope.error && envelope.error.code) {
    return {
      ok: false,
      voices: [],
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: envelope.error.message ?? envelope.error.code,
    };
  }
  const raw = Array.isArray(envelope.data?.voices) ? envelope.data!.voices! : [];
  return {
    ok: true,
    voices: raw,
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { httpStatus: result.status } : {}),
  };
}

// =========================================================================
// POST /v2/video/generate
//
// We intentionally target v2 (not v3) for the initial Commit 61 landing
// because the v3 create-video schema is still being refined per HeyGen
// changelog and the v2 shape is widely documented + stable through the
// October 31, 2026 sunset. Migrating to v3 is planned for Commit 62-63.
// =========================================================================

const HEYGEN_CREATE_VIDEO_URL = `${HEYGEN_BASE}/v2/video/generate`;

export interface SubmitHeygenVideoInput {
  userId: string;
  apiKey: string;
  avatarId: string;
  voiceId: string;
  script: string;
  /** "9:16" | "16:9" | "1:1" | "4:5". Default 9:16 for Reels/Stories/TikTok. */
  aspectRatio?: '9:16' | '16:9' | '1:1' | '4:5';
  /** Correlation ID echoed back in the webhook payload (Commit 62). */
  callbackId?: string;
  /** Test render — watermarked, non-billed. Use in dev/dry-run only. */
  test?: boolean;
  videoName?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface SubmitHeygenVideoResult {
  ok: boolean;
  videoId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeygenErrorCategory;
}

export async function submitHeygenVideo(
  input: SubmitHeygenVideoInput,
): Promise<SubmitHeygenVideoResult> {
  assertHeygenScriptLength(input.script);

  const body: Record<string, unknown> = {
    test: input.test ?? false,
    aspect_ratio: input.aspectRatio ?? '9:16',
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: input.avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: input.script,
          voice_id: input.voiceId,
        },
      },
    ],
  };
  if (input.videoName) body['title'] = input.videoName;
  if (input.callbackId) body['callback_id'] = input.callbackId;

  console.log(
    `[heygen-v3] submit tuple avatarId=${input.avatarId} voiceId=${input.voiceId} ` +
      `script_chars=${input.script.length} aspectRatio=${input.aspectRatio ?? '9:16'} ` +
      `test=${input.test ?? false} jobId=${input.generationJobId ?? 'null'}`,
  );

  const result = await callProvider<HeygenEnvelope<HeygenCreateVideoData>>({
    userId: input.userId,
    provider: 'heygen',
    url: HEYGEN_CREATE_VIDEO_URL,
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'content-type': 'application/json',
      Accept: 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      avatar_id: input.avatarId,
      voice_id: input.voiceId,
      script_chars: input.script.length,
      aspect_ratio: input.aspectRatio ?? '9:16',
      test: input.test ?? false,
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
      errorCategory: classifyHeygenError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  const errMsg = envelope.error?.message ?? envelope.message;
  if (envelope.error?.code || (envelope.code && envelope.code !== 100)) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: errMsg ?? 'HeyGen submit returned a non-success envelope.',
      errorCategory: classifyHeygenError(result.status, errMsg),
    };
  }
  const videoId = envelope.data?.video_id;
  if (!videoId || typeof videoId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: 'HeyGen submit response is missing data.video_id.',
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
// GET /v1/video_status.get
// =========================================================================

const HEYGEN_STATUS_URL = `${HEYGEN_BASE}/v1/video_status.get`;

export interface CheckHeygenVideoStatusInput {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface CheckHeygenVideoStatusResult {
  ok: boolean;
  status: HeygenVideoStatus;
  url?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  captionUrl?: string;
  reason?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeygenErrorCategory;
}

export async function checkHeygenVideoStatus(
  input: CheckHeygenVideoStatusInput,
): Promise<CheckHeygenVideoStatusResult> {
  const result = await callProvider<HeygenEnvelope<HeygenStatusData>>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_STATUS_URL}?video_id=${encodeURIComponent(input.videoId)}`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { video_id: input.videoId },
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
      errorCategory: classifyHeygenError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  const envErrMsg = envelope.error?.message ?? envelope.message;
  if (envelope.error?.code || (envelope.code && envelope.code !== 100)) {
    return {
      ok: false,
      status: 'failed',
      latencyMs: result.latencyMs,
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      errorMessage: envErrMsg ?? 'HeyGen status returned a non-success envelope.',
      errorCategory: classifyHeygenError(result.status, envErrMsg),
    };
  }
  const data = envelope.data ?? {};
  const rawStatus = (data.status ?? '').toLowerCase();
  let interpreted: HeygenVideoStatus;
  if (rawStatus === 'completed' || rawStatus === 'success') {
    interpreted = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    interpreted = 'failed';
  } else if (rawStatus === 'processing' || rawStatus === 'pending' || rawStatus === 'waiting') {
    interpreted = rawStatus === 'pending' ? 'pending' : 'processing';
  } else {
    if (rawStatus.length > 0) {
      console.error(
        `[heygen-v3] UNKNOWN poll status ${JSON.stringify(data.status)} — ` +
          `videoId=${input.videoId} body=${JSON.stringify(result.data).slice(0, 800)}`,
      );
    }
    interpreted = 'processing';
  }
  console.log(
    `[heygen-v3] poll videoId=${input.videoId} rawStatus=${JSON.stringify(data.status ?? null)} interpreted=${interpreted}`,
  );
  const videoUrl = data.video_url ?? data.url;
  const rawReason = data.error?.message;
  return {
    ok: true,
    status: interpreted,
    ...(typeof videoUrl === 'string' ? { url: videoUrl } : {}),
    ...(typeof data.thumbnail_url === 'string' ? { thumbnailUrl: data.thumbnail_url } : {}),
    ...(typeof data.duration === 'number' ? { durationSeconds: data.duration } : {}),
    ...(typeof data.caption_url === 'string' ? { captionUrl: data.caption_url } : {}),
    ...(typeof rawReason === 'string' ? { reason: rawReason } : {}),
    latencyMs: result.latencyMs,
    ...(result.status !== undefined ? { httpStatus: result.status } : {}),
  };
}

// =========================================================================
// Enriched persona-driven avatar matcher
//
// Reads from heygen_avatar_index (populated by refresh-heygen-avatar-
// index cron via the shared MakeUGC Gemini vision prompt). Same hard-
// filter + soft-score approach as selectMakeugcAvatarForPersonaFromIndex
// — gender is a HARD filter (never cross-gender bind), age-bucket is
// HARD ±2 (softer than MakeUGC's ±1 because HeyGen's library skews
// younger and would starve on ±1), ethnicity/hair/wardrobe are SOFT
// scores. Throws HeygenNoMatchingAvatarError on empty pool — never
// silently falls back to a random avatar (that's the bug MakeUGC
// Commit 1 shipped and had to reverse).
// =========================================================================

export interface HeygenEnrichedAvatar {
  avatarId: string;
  avatarName: string;
  thumbnailUrl: string;
  heygenGender: string; // "male" | "female"
  ageBucket: string; // "20s" | "30s" | ... | "80s+"
  ethnicity: string;
  hairColor: string;
  hairStyle: string | null;
  facialHair: string | null;
  wardrobeStyle: string | null;
  wardrobeSummary: string | null;
  backgroundSetting: string | null;
}

export interface HeygenAvatarMatchLog {
  candidatesConsidered: number;
  hardFilters: string[];
  scoredCandidates: Array<{ avatarId: string; score: number }>;
  winnerAvatarId: string;
  winnerVoiceId: string;
  winnerScore: number;
}

export interface HeygenAvatarMatch {
  avatar: HeygenEnrichedAvatar;
  voice: HeygenVoiceV3;
  score: number;
  matchLog: HeygenAvatarMatchLog;
}

const HEYGEN_AGE_ORDER = ['20s', '30s', '40s', '50s', '60s', '70s', '80s+'] as const;

/** Age-bucket neighbours ±2 (wider than MakeUGC's ±1 due to library skew). */
function heygenAgeBucketNeighbors(bucket: string): string[] {
  const idx = HEYGEN_AGE_ORDER.indexOf(bucket as (typeof HEYGEN_AGE_ORDER)[number]);
  if (idx < 0) return HEYGEN_AGE_ORDER.slice();
  const out = new Set<string>();
  for (let d = -2; d <= 2; d++) {
    const target = HEYGEN_AGE_ORDER[idx + d];
    if (target) out.add(target);
  }
  return Array.from(out);
}

function personaAgeToBucket(ageRange: string): string {
  // Very forgiving parse — accepts "25-35", "30s", "40 to 50", "middle-aged".
  const match = ageRange.match(/\d+/);
  if (!match) return '30s';
  const n = parseInt(match[0] ?? '30', 10);
  if (n < 30) return '20s';
  if (n < 40) return '30s';
  if (n < 50) return '40s';
  if (n < 60) return '50s';
  if (n < 70) return '60s';
  if (n < 80) return '70s';
  return '80s+';
}

const HEYGEN_ENRICHED_SCORE_WEIGHTS = {
  ethnicityExact: 10,
  hair: 5,
  facialHair: 3,
  wardrobe: 2,
} as const;

function fuzzyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na.includes(nb) || nb.includes(na);
}

export function selectHeygenAvatarForPersonaFromIndex(
  persona: HeygenPersona,
  enrichedAvatars: HeygenEnrichedAvatar[],
  voices: HeygenVoiceV3[],
  opts: { preferPremium?: boolean } = {},
): HeygenAvatarMatch {
  const targetGender = persona.gender; // 'male' | 'female'
  const targetBucket = personaAgeToBucket(persona.age_range);
  const allowedBuckets = new Set(heygenAgeBucketNeighbors(targetBucket));

  const hardFilters: string[] = [
    `gender=${targetGender}`,
    `age∈{${[...allowedBuckets].join(',')}}`,
  ];

  const genderFiltered = enrichedAvatars.filter(
    (a) => a.heygenGender.toLowerCase() === targetGender,
  );
  const ageFiltered = genderFiltered.filter((a) => allowedBuckets.has(a.ageBucket));

  if (ageFiltered.length === 0) {
    throw new HeygenNoMatchingAvatarError(persona, enrichedAvatars.length, hardFilters);
  }

  const scoredCandidates = ageFiltered.map((a) => {
    let score = 0;
    if (persona.ethnicity && fuzzyMatch(a.ethnicity, persona.ethnicity)) {
      score += HEYGEN_ENRICHED_SCORE_WEIGHTS.ethnicityExact;
    }
    if (persona.look) {
      if (fuzzyMatch(a.hairStyle, persona.look) || fuzzyMatch(a.hairColor, persona.look)) {
        score += HEYGEN_ENRICHED_SCORE_WEIGHTS.hair;
      }
      if (fuzzyMatch(a.facialHair, persona.look)) {
        score += HEYGEN_ENRICHED_SCORE_WEIGHTS.facialHair;
      }
      if (
        fuzzyMatch(a.wardrobeStyle, persona.look) ||
        fuzzyMatch(a.wardrobeSummary, persona.look)
      ) {
        score += HEYGEN_ENRICHED_SCORE_WEIGHTS.wardrobe;
      }
    }
    return { avatarId: a.avatarId, score, avatar: a };
  });

  scoredCandidates.sort((x, y) => y.score - x.score);
  const winner = scoredCandidates[0]!;

  // Voice picker: match language when persona says so, otherwise
  // English default. Gender not filtered — HeyGen voices are less
  // strongly gendered and callers may want a specific tone.
  const preferredLang = (persona.language ?? 'English').toLowerCase();
  const voiceCandidates = voices.filter((v) => {
    if (!v.language) return true;
    return v.language.toLowerCase().includes(preferredLang);
  });
  const pickedVoice = voiceCandidates[0] ?? voices[0];
  if (!pickedVoice) {
    throw new HeygenNoMatchingAvatarError(persona, enrichedAvatars.length, [
      ...hardFilters,
      `voice_language~=${preferredLang}`,
    ]);
  }

  void opts.preferPremium; // reserved for a future scoring dimension

  return {
    avatar: winner.avatar,
    voice: pickedVoice,
    score: winner.score,
    matchLog: {
      candidatesConsidered: enrichedAvatars.length,
      hardFilters,
      scoredCandidates: scoredCandidates.map((c) => ({ avatarId: c.avatarId, score: c.score })),
      winnerAvatarId: winner.avatarId,
      winnerVoiceId: pickedVoice.voice_id,
      winnerScore: winner.score,
    },
  };
}

// =========================================================================
// Zod schemas for job metadata (audit-trail on generation_jobs.metadata)
// =========================================================================

export const Polish26HeygenAvatarMatchMetadataSchema = z.object({
  winnerAvatarId: z.string(),
  winnerVoiceId: z.string(),
  winnerScore: z.number(),
  candidatesConsidered: z.number(),
  hardFilters: z.array(z.string()),
  fallbackUsed: z.enum(['none', 'live-listing-gender-only', 'legacy']).default('none'),
});

export const Polish26HeygenCostMetadataSchema = z.object({
  engine: z.enum(['avatar_v', 'avatar_iv']),
  seconds: z.number(),
  usdPerSecond: z.number(),
  costUsd: z.number(),
  at: z.string(),
});
