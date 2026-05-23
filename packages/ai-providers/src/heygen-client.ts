import { computeHeygenCost } from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * HeyGen video generation client. Like Kie.ai, async — submit returns a
 * video_id, caller polls for status.
 *
 * Endpoints (verified against docs.heygen.com, May 2025):
 *   - POST /v2/video/generate
 *   - GET  /v1/video_status.get?video_id=...
 *   - GET  /v2/avatars                          — for avatar matching
 *
 * Auth: `X-Api-Key` header. Note the differing case from other providers.
 */

const HEYGEN_BASE = 'https://api.heygen.com';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const AVATARS_TIMEOUT_MS = 15_000;
const VOICES_TIMEOUT_MS = 15_000;

/**
 * Phase 3f: thrown by the UGC pipeline when neither
 * user_settings.default_heygen_avatar_id nor HEYGEN_DEFAULT_AVATAR_ID
 * env var is set. Surfaced to the job UI verbatim so the operator
 * knows where to fix it.
 */
export class HeyGenAvatarNotConfiguredError extends Error {
  constructor(message = 'Set your default avatar in /settings before generating UGC variants.') {
    super(message);
    this.name = 'HeyGenAvatarNotConfiguredError';
  }
}

/**
 * Phase 3f: translate raw HTTP status from the HeyGen API into a
 * user-facing category the pipeline maps to friendly copy. Anything
 * we don't classify falls through to 'unknown' (generic error message).
 */
export type HeyGenErrorCategory =
  | 'auth' // 401/403 — bad key, revoked, or wrong env
  | 'credits' // 402/429 — out of credits or rate-limited
  | 'avatar_missing' // 404 + "avatar" in error message
  | 'timeout' // request aborted (chokepoint timeout)
  | 'server' // 5xx — HeyGen-side problem
  | 'unknown';

export function classifyHeyGenError(
  status: number | undefined,
  message: string | undefined,
): HeyGenErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'credits';
  if (status === 404 && /avatar/i.test(message ?? '')) return 'avatar_missing';
  if (status === 0 && /timeout|aborted/i.test(message ?? '')) return 'timeout';
  if (typeof status === 'number' && status >= 500) return 'server';
  return 'unknown';
}

/**
 * Polish-4: HeyGen surfaces premium-tier avatars under multiple field
 * names depending on the API version. We check the documented `premium`
 * boolean first, fall back to `tier === 'premium'`, then `is_premium`.
 * If the avatar list is empty (free tier with no avatars seeded) we
 * report 'free'. Override via HEYGEN_TIER_FIELD env if HeyGen renames.
 */
export type HeyGenTier = 'free' | 'pro' | 'premium';

export interface HeyGenAvatar {
  avatar_id: string;
  avatar_name: string;
  gender?: string;
  preview_image_url?: string;
  /** HeyGen surfaces tags inconsistently — we use whatever's present for matching. */
  description?: string;
  /** Polish-4: parsed tier classification, derived in normalizeHeyGenAvatar. */
  tier?: HeyGenTier;
  /** Raw boolean from HeyGen for forensic logging. */
  premium?: boolean;
}

/**
 * Polish-4: read whichever of the documented tier markers HeyGen
 * happens to ship in this response. Defaults to 'free' if no marker.
 */
export function normalizeHeyGenAvatar(raw: Record<string, unknown>): HeyGenAvatar {
  const premium =
    raw.premium === true ||
    raw.is_premium === true ||
    (typeof raw.tier === 'string' && raw.tier.toLowerCase() === 'premium');
  // 'pro' is rarer in the list response; some accounts label brand-approved
  // avatars 'pro'. Treat that as the same access bucket as premium here —
  // gating happens upstream via the connection's tier.
  const isPro = typeof raw.tier === 'string' && raw.tier.toLowerCase() === 'pro';
  return {
    avatar_id: String(raw.avatar_id ?? ''),
    avatar_name: String(raw.avatar_name ?? ''),
    gender: typeof raw.gender === 'string' ? raw.gender : undefined,
    preview_image_url:
      typeof raw.preview_image_url === 'string' ? raw.preview_image_url : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    tier: premium ? 'premium' : isPro ? 'pro' : 'free',
    premium: typeof raw.premium === 'boolean' ? raw.premium : undefined,
  };
}

/**
 * Polish-4: infer the connection-level tier from the avatar list. Logic:
 *   - any premium avatar visible → 'premium'
 *   - any pro avatar visible      → 'pro'
 *   - otherwise                   → 'free'
 *
 * Premium plans see premium avatars in /v2/avatars; free plans don't.
 * This is the cheapest tier-detection signal available without a
 * dedicated billing endpoint.
 */
export function detectHeyGenTier(avatars: HeyGenAvatar[]): HeyGenTier {
  if (avatars.some((a) => a.tier === 'premium')) return 'premium';
  if (avatars.some((a) => a.tier === 'pro')) return 'pro';
  return 'free';
}

/**
 * Polish-4: drop avatars the user's tier can't use. Calling generate
 * with a Premium avatar on a free plan 403s — filter first.
 */
export function filterAvatarsByTier(
  avatars: HeyGenAvatar[],
  userTier: HeyGenTier | null | undefined,
): HeyGenAvatar[] {
  const tier = userTier ?? 'free';
  if (tier === 'premium') return avatars; // premium plan sees everything
  if (tier === 'pro') return avatars.filter((a) => a.tier !== 'premium');
  return avatars.filter((a) => a.tier === 'free' || a.tier === undefined);
}

export interface HeyGenAvatarsListResult {
  ok: boolean;
  avatars: HeyGenAvatar[];
  /** Polish-4: connection-level tier inferred from the avatar list. */
  tier?: HeyGenTier;
  latencyMs: number;
  /** HTTP status from HeyGen (or 0 on timeout/network error). */
  httpStatus?: number;
  errorMessage?: string;
}

/** List avatars accessible to the user's account. Used by the matcher. */
export async function listHeyGenAvatars(input: {
  userId: string;
  apiKey: string;
  generationJobId?: string;
}): Promise<HeyGenAvatarsListResult> {
  const result = await callProvider<{
    error?: { message?: string };
    data?: { avatars?: Array<Record<string, unknown>> };
  }>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_BASE}/v2/avatars`,
    method: 'GET',
    headers: {
      'X-Api-Key': input.apiKey,
    },
    timeoutMs: AVATARS_TIMEOUT_MS,
    requestBodyForLog: { _list_avatars: true },
    generationJobId: input.generationJobId,
  });

  if (!result.ok) {
    return {
      ok: false,
      avatars: [],
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }

  const raw = result.data.data?.avatars ?? [];
  const avatars = raw.map(normalizeHeyGenAvatar);
  return {
    ok: true,
    avatars,
    tier: detectHeyGenTier(avatars),
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

// =========================================================================
// Voices
// =========================================================================

export interface HeyGenVoice {
  voice_id: string;
  language?: string;
  gender?: string;
  name: string;
  preview_audio?: string;
}

export interface HeyGenVoicesListResult {
  ok: boolean;
  voices: HeyGenVoice[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Phase 3f: list the voices available to the user's HeyGen account.
 * Settings UI uses this to render the optional "default voice" picker
 * alongside the avatar picker. Pipeline doesn't call this on every job —
 * if a voice id is configured the submit call uses it directly, and if
 * not HeyGen picks the avatar's default voice automatically.
 */
export async function listHeyGenVoices(input: {
  userId: string;
  apiKey: string;
  generationJobId?: string;
}): Promise<HeyGenVoicesListResult> {
  const result = await callProvider<{
    data?: { voices?: HeyGenVoice[] };
  }>({
    userId: input.userId,
    provider: 'heygen',
    url: `${HEYGEN_BASE}/v2/voices`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey },
    timeoutMs: VOICES_TIMEOUT_MS,
    requestBodyForLog: { _list_voices: true },
    generationJobId: input.generationJobId,
  });

  if (!result.ok) {
    return {
      ok: false,
      voices: [],
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  return {
    ok: true,
    voices: result.data.data?.voices ?? [],
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

/**
 * Heuristic avatar matcher: score each avatar by keyword overlap with the
 * persona descriptors extracted from Gemini's analysis. Returns the
 * top scorer or null if nothing matches above zero.
 *
 * Phase 3b is heuristic — substring matching is good enough for a
 * founding-member catalog. Phase 3.5 can swap to embedding similarity if
 * the avatar pool grows past ~hundreds.
 */
export function pickHeyGenAvatar(
  avatars: HeyGenAvatar[],
  persona: { age?: string; gender?: string; vibe?: string; setting?: string },
  // Polish-4: when set, premium avatars are dropped from the pool if
  // the user's tier can't use them. Defaults to no filtering (i.e. the
  // caller already filtered, OR they're fine with a 403).
  userTier?: HeyGenTier | null,
): HeyGenAvatar | null {
  const pool = userTier === undefined ? avatars : filterAvatarsByTier(avatars, userTier);
  if (pool.length === 0) return null;

  const keywords = [persona.age, persona.gender, persona.vibe, persona.setting]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase());
  if (keywords.length === 0) return null;

  let bestScore = 0;
  let best: HeyGenAvatar | null = null;
  for (const a of pool) {
    const haystack = [a.avatar_name, a.gender ?? '', a.description ?? ''].join(' ').toLowerCase();
    let score = 0;
    for (const k of keywords) {
      if (haystack.includes(k)) score++;
    }
    // Hard gender match boost — getting gender wrong is the worst error.
    if (persona.gender && a.gender && a.gender.toLowerCase() === persona.gender.toLowerCase()) {
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return bestScore > 0 ? best : null;
}

export interface HeyGenSubmitInput {
  userId: string;
  apiKey: string;
  avatarId: string;
  /** Voice ID — caller picks; if unknown, leave undefined and HeyGen uses default. */
  voiceId?: string;
  /** Script the avatar speaks. */
  script: string;
  /** Optional resolution; HeyGen default is 1080p. */
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HeyGenSubmitResult {
  ok: boolean;
  videoId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/** Submit a generation request. Returns the video_id for polling. */
export async function submitHeyGenVideo(input: HeyGenSubmitInput): Promise<HeyGenSubmitResult> {
  const url = `${HEYGEN_BASE}/v2/video/generate`;
  const body = {
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
          ...(input.voiceId ? { voice_id: input.voiceId } : {}),
        },
        background: { type: 'color', value: '#ffffff' },
      },
    ],
    dimension: { width: 720, height: 1280 },
  };

  const result = await callProvider<{
    error?: { message?: string };
    data?: { video_id?: string };
  }>({
    userId: input.userId,
    provider: 'heygen',
    url,
    method: 'POST',
    headers: {
      'X-Api-Key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      avatar_id: input.avatarId,
      voice_id: input.voiceId,
      script_chars: input.script.length,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }

  const videoId = result.data.data?.video_id;
  if (!videoId) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: 'HeyGen response did not include a video_id',
    };
  }
  return { ok: true, videoId, latencyMs: result.latencyMs, httpStatus: result.status };
}

export interface HeyGenCheckInput {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export type HeyGenStatus = 'processing' | 'completed' | 'failed';

export interface HeyGenCheckResult {
  status: HeyGenStatus;
  videoUrl?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/** Single status check. Caller polls via Inngest `step.sleep`. */
export async function checkHeyGenVideoStatus(input: HeyGenCheckInput): Promise<HeyGenCheckResult> {
  const url = `${HEYGEN_BASE}/v1/video_status.get?video_id=${encodeURIComponent(input.videoId)}`;

  const result = await callProvider<{
    error?: { message?: string };
    data?: {
      status?: string;
      video_url?: string;
      error?: { message?: string };
    };
  }>({
    userId: input.userId,
    provider: 'heygen',
    url,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { video_id: input.videoId },
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

  const data = result.data.data ?? {};
  const rawStatus = (data.status ?? '').toLowerCase();
  let status: HeyGenStatus;
  if (rawStatus === 'completed' || rawStatus === 'success') {
    status = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    status = 'failed';
  } else {
    status = 'processing';
  }

  return {
    status,
    videoUrl: data.video_url,
    costUsd: status === 'completed' ? computeHeygenCost() : 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
    errorMessage: status === 'failed' ? data.error?.message : undefined,
  };
}
