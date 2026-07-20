import { computeHeygenCost } from '@mbb/shared';
import { z } from 'zod';
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
  | 'credits' // 402 — out of credits (Polish-24 splits 429 → rate_limit)
  | 'rate_limit' // 429 — over concurrency or per-minute cap (transient, retry with backoff)
  | 'avatar_missing' // 404 + "avatar" in error message (legacy — the older UGC path)
  | 'avatar_churned' // Polish-24 — avatar_not_found on a submit right after a fresh /v2/avatars fetch. HeyGen retires public avatars silently; the mitigation is invalidate cache + retry with second-best.
  | 'timeout' // request aborted (chokepoint timeout)
  | 'server' // 5xx — HeyGen-side problem
  | 'unknown';

/**
 * Polish-24 Commit 1: extended with 429 → 'rate_limit' (was folded
 * into 'credits' in the Polish-21 UGC path — over-credits vs
 * over-concurrency both surface on 402/429 but need different
 * treatment now that we auto-retry rate_limit transiently) and
 * 40119 (HeyGen's "voice service temporarily unavailable" body
 * code, seen in production — classify as transient via server).
 * Also adds 'avatar_churned' for the /v2/avatars-cache-vs-fresh
 * mismatch class described in the research report.
 */
export function classifyHeyGenError(
  status: number | undefined,
  message: string | undefined,
): HeyGenErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'credits';
  if (status === 404 && /avatar[_ ]?not[_ ]?found|photar[_ ]?not[_ ]?found/i.test(message ?? '')) {
    return 'avatar_churned';
  }
  if (status === 404 && /avatar/i.test(message ?? '')) return 'avatar_missing';
  if (status === 0 && /timeout|aborted/i.test(message ?? '')) return 'timeout';
  if (typeof status === 'number' && status >= 500) return 'server';
  // Polish-24 Commit 1: `40119` is HeyGen's "voice service
  // temporarily unavailable" body-code seen in production. Treat as
  // server-class (transient via server bucket + isHeygenTransientError
  // pattern match on the message).
  if (typeof message === 'string' && /\b40119\b|voice service temporarily/i.test(message)) {
    return 'server';
  }
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

// -------------------------------------------------------------------
// Polish-24 Commit 1: pickHeYGenAvatar DELETED.
//
// The old keyword-substring matcher was the root cause of the
// "used wrong character" bug: it soft-boosted gender (+2) instead
// of hard-filtering, so a female avatar could still win if it had
// more keyword hits than the correct male candidate. It also
// silently returned the null-fallback (which was then interpreted
// as "any avatar OK") instead of raising an error.
//
// Replaced by selectHeygenAvatarForPersona (below) which:
//   1. Hard-filters on gender exact match (reject on mismatch)
//   2. Throws HeygenNoMatchingAvatarError when no candidate passes
//      the filters (NO silent random fallback)
//   3. Emits a matchLog audit trail for SQL forensics
//
// The tier gating logic (filterAvatarsByTier, HeygenTier detection)
// is preserved above — that part was correct.
// -------------------------------------------------------------------

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
  // Polish-24 Commit 1: explicit pending/waiting → 'processing'
  // mapping. HeyGen's poll enum is
  // `pending | waiting | processing | completed | failed`. The prior
  // implementation swept pending/waiting into the default fallback
  // ('processing') which was correct but silent — now the mapping is
  // explicit + a loud-log surfaces every raw status so any future
  // new HeyGen state (e.g. 'canceled') is visible on the first poll
  // instead of buried in a fallback.
  if (rawStatus === 'completed' || rawStatus === 'success') {
    status = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    status = 'failed';
  } else if (rawStatus === 'pending' || rawStatus === 'waiting') {
    // Explicit pending/waiting handling — HeyGen queues at 10-concurrent
    // cap using these states; caller keeps polling.
    status = 'processing';
  } else {
    // Unknown status defaults to 'processing' (defensive — matches
    // Commit 3.0.31's WaveSpeedAI treatment) BUT emit a loud stderr
    // line so operator can add the state to the explicit branch above.
    if (rawStatus.length > 0 && rawStatus !== 'processing') {
      console.error(
        `[heygen] UNKNOWN poll status ${JSON.stringify(data.status)} — ` +
          `add to checkHeyGenVideoStatus explicit branch. ` +
          `videoId=${input.videoId} body=${JSON.stringify(result.data).slice(0, 800)}`,
      );
    }
    status = 'processing';
  }
  // Polish-24 Commit 1: loud-log raw + interpreted status on EVERY
  // poll. Grep-friendly single line for Vercel Runtime Logs.
  console.log(
    `[heygen] poll videoId=${input.videoId} rawStatus=${JSON.stringify(data.status ?? null)} interpreted=${status}`,
  );

  return {
    status,
    videoUrl: data.video_url,
    costUsd: status === 'completed' ? computeHeygenCost() : 0,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
    errorMessage: status === 'failed' ? data.error?.message : undefined,
  };
}

// =========================================================================
// Polish-24 Commit 1: NET-NEW EXPORTS
// -------------------------------------------------------------------------
// Client-only surface for the HeyGen pivot (Google Veo character drift
// proved unsolvable via 30+ Polish-23 prompt-engineering commits).
// Delivers:
//   - Cost constants + estimator (verified 2026 pricing)
//   - Transient error patterns + auto-retry gate (mirrors WaveSpeedAI
//     Commit 3.0.29)
//   - Appearance-word sanitizer (fixes the "wrong avatar" bug — HeyGen
//     substitutes avatars when input_text describes appearance)
//   - selectHeygenAvatarForPersona (hard-filter gender; NO silent
//     random fallback — throws HeygenNoMatchingAvatarError)
//   - Daily-cached avatar/voice library (6h/24h TTL by userId)
//   - Polish-24 submit path with required voiceId + auto-invalidate on
//     avatar_not_found + second-best retry (throws HeygenAvatarChurnedError)
//   - Zod schema for metadata.polish24_avatar_match audit trail
// =========================================================================

// -------------------------------------------------------------------
// Cost constants — verified 2026 pricing (per-second, USD)
// Sources: HeyGen API Pricing Explained (help.heygen.com), tryAGI
// OpenAPI export, third-party recaps (eesel, arcade). Feb 2026 API
// tier removed free monthly credits from Creator/Business subs —
// API is now separate $5-min wallet top-up.
// -------------------------------------------------------------------
export const HEYGEN_AVATAR_III_USD_PER_SEC = 0.0167; // $1.00/min
export const HEYGEN_AVATAR_IV_1080P_USD_PER_SEC = 0.0667; // $4.00/min
export const HEYGEN_AVATAR_IV_4K_USD_PER_SEC = 0.0833; // $5.00/min

export type HeygenTier = 'avatar_iii' | 'avatar_iv_1080p' | 'avatar_iv_4k';

export const HEYGEN_USD_PER_SECOND: Record<HeygenTier, number> = {
  avatar_iii: HEYGEN_AVATAR_III_USD_PER_SEC,
  avatar_iv_1080p: HEYGEN_AVATAR_IV_1080P_USD_PER_SEC,
  avatar_iv_4k: HEYGEN_AVATAR_IV_4K_USD_PER_SEC,
};

export function estimateHeygenClipCostUsd(seconds: number, tier: HeygenTier): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return seconds * HEYGEN_USD_PER_SECOND[tier];
}

// -------------------------------------------------------------------
// Transient error patterns — mirror WaveSpeedAI Commit 3.0.29 pattern
// -------------------------------------------------------------------
/**
 * Polish-24 Commit 1: case-insensitive substring list. If a HeyGen
 * error message contains any of these, the caller SHOULD auto-retry
 * rather than fire NonRetriableError. Covers the operator's spec
 * list + a couple community-attested patterns from the research:
 * '40119' (voice service temporarily unavailable), '5xx' surfaces
 * via 'gateway'/'internal server'/'temporarily unavailable'.
 */
export const HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  'rate limit',
  'too many requests',
  'timeout',
  'temporarily unavailable',
  'internal server',
  'gateway',
  'pending',
  'try again',
  '502',
  '503',
  '504',
  'bad gateway',
  'gateway timeout',
  '40119',
  'voice service temporarily',
];

export function isHeygenTransientError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return false;
  const lower = errorMessage.toLowerCase();
  return HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// -------------------------------------------------------------------
// Appearance-word sanitizer — THE FIX for the "wrong avatar" bug.
//
// Per HeyGen's official skill guidance:
//   "When avatar_id is set, do NOT describe the avatar's appearance
//    in the prompt. Say 'the selected presenter.' This is the #1
//    cause of avatar mismatch."
//   (https://github.com/heygen-com/skills/blob/master/heygen-video/SKILL.md)
//
// Polish-23 fed persona (gender/ethnicity/age/hair/wardrobe) into
// per-clip prompts VERBATIM. HeyGen substituted a different avatar
// matching those words instead of respecting our avatar_id. The
// operator's prior integration hit this exact bug.
//
// Fix: reject any input_text containing gender/ethnicity/age/hair/
// wardrobe words at Zod-refine time. The caller's script must
// describe ACTION only, not APPEARANCE.
// -------------------------------------------------------------------
export const HEYGEN_APPEARANCE_WORD_PATTERNS: readonly RegExp[] = [
  // Gender words (whole-word match)
  /\b(male|female|man|woman|men|women|boy|girl|guy|gal|lady|dude|gentleman|gentlemen)\b/i,
  // Age markers: "60s", "60-year-old", "60 year old", "aged 60"
  /\b\d{1,2}(s|-year-old| year old| yr old|-yr-old| years old)\b/i,
  /\baged\s+\d{1,2}\b/i,
  // Ethnicity words
  /\b(white|caucasian|black|african[- ]?american|hispanic|latino|latina|asian|east[- ]?asian|south[- ]?asian|chinese|japanese|korean|indian|middle[- ]?eastern|arab|jewish|mixed[- ]?race|biracial|multiracial)\b/i,
  // Hair color / style words
  /\b(blonde|brunette|redhead|gray[- ]?hair|grey[- ]?hair|white[- ]?hair|black[- ]?hair|brown[- ]?hair|red[- ]?hair|bald|balding|receding|long[- ]?hair|short[- ]?hair|curly|straight[- ]?hair|salt[- ]?and[- ]?pepper)\b/i,
  // Wardrobe / clothing words (via "wearing X" or specific garment names)
  /\bwearing\b/i,
  /\b(shirt|blouse|sweater|hoodie|jacket|coat|dress|suit|tie|jeans|pants|skirt|scarf|hat|cap|glasses|sunglasses|jewelry|earrings|necklace)\b/i,
];

export function containsAvatarAppearanceWords(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return HEYGEN_APPEARANCE_WORD_PATTERNS.some((p) => p.test(text));
}

export function assertNoAvatarAppearanceWordsInInputText(text: string): void {
  if (containsAvatarAppearanceWords(text)) {
    throw new Error(
      'HeyGen input_text contains appearance words (gender / ethnicity / age / ' +
        'hair / wardrobe). This causes HeyGen to substitute a different avatar. ' +
        'Describe ACTION only — say "the selected presenter" instead of the persona ' +
        'descriptors. See ' +
        'https://github.com/heygen-com/skills/blob/master/heygen-video/SKILL.md',
    );
  }
}

/**
 * Zod-native form for callers that thread input_text through a
 * schema-parse boundary. Mirrors the Commit 3.0.23 nested-quote
 * refine pattern.
 */
export const HeygenInputTextSchema = z
  .string()
  .min(1)
  .refine((t) => !containsAvatarAppearanceWords(t), {
    message:
      'HeyGen input_text contains appearance words (gender/ethnicity/age/hair/wardrobe). ' +
      'Rewrite as action-only — HeyGen substitutes avatars when appearance is described.',
  });

// -------------------------------------------------------------------
// Typed errors for the matcher + submit path
// -------------------------------------------------------------------
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
        `${candidatesConsidered} avatars considered, hard filters applied: ` +
        `[${hardFiltersApplied.join(', ')}]. ` +
        `Add matching avatars to the HeyGen account, then retry.`,
    );
    this.name = 'HeygenNoMatchingAvatarError';
    this.persona = persona;
    this.candidatesConsidered = candidatesConsidered;
    this.hardFiltersApplied = hardFiltersApplied;
  }
}

export class HeygenAvatarChurnedError extends Error {
  readonly avatarId: string;
  readonly persona: HeygenPersona;
  constructor(avatarId: string, persona: HeygenPersona) {
    super(
      `HeyGen avatar ${avatarId} was returned by /v2/avatars but 404'd on ` +
        `submit AND no second-best candidate remains after cache invalidation. ` +
        `Persona: ${JSON.stringify(persona)}. Add more matching avatars to the ` +
        `HeyGen account or wait for the churned avatar to return.`,
    );
    this.name = 'HeygenAvatarChurnedError';
    this.avatarId = avatarId;
    this.persona = persona;
  }
}

// -------------------------------------------------------------------
// Persona-driven avatar matcher — hard-filter gender, no silent fallback
// -------------------------------------------------------------------
export interface HeygenPersona {
  gender: 'male' | 'female';
  age_range: string; // "20s" | "60s" | "18-25" etc — soft-scored, not hard-filtered
  ethnicity?: string; // "white" | "black" | "asian" | … — Polish-24 Commit 2 enriched-index will make this a hard filter
  look?: string; // free-text
  voice_tone?: string; // free-text
  locale?: string; // e.g. "en-US" — used for voice_id filter
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
  avatar: HeyGenAvatar;
  voiceId: string;
  score: number;
  matchLog: HeygenAvatarMatchLog;
}

/**
 * Polish-24 Commit 1: hard-filter gender + soft-score by name-keyword
 * fit; pair with the best-fit voice_id from /v2/voices (same gender +
 * matching locale). Throws HeygenNoMatchingAvatarError when NO
 * candidate passes the hard filters — NEVER a silent random fallback
 * (this was the operator's prior blocker).
 *
 * Polish-24 Commit 2 will layer an enriched avatar index (Supabase
 * table + nightly Gemini Vision pass) that adds hard filters on
 * ethnicity/age_bucket + soft scoring on hair_color/wardrobe. Until
 * then, matching is gender-only + name-keyword — which is still
 * strictly better than the deleted keyword-substring matcher because
 * gender is HARD and no silent random fallback exists.
 *
 * Excludes any avatarId in the `exclude` list — used by the
 * churn-retry path to pick a second-best after the initial choice
 * 404s at submit.
 */
export function selectHeygenAvatarForPersona(
  persona: HeygenPersona,
  avatars: readonly HeyGenAvatar[],
  voices: readonly HeyGenVoice[],
  opts?: { exclude?: readonly string[] },
): HeygenAvatarMatch {
  const exclude = new Set(opts?.exclude ?? []);
  const hardFilters: string[] = [];

  // HARD FILTER 1: exact gender match. HeyGen exposes `gender` on
  // avatar objects (only field we can trust).
  hardFilters.push(`gender=${persona.gender}`);
  let pool = avatars.filter(
    (a) =>
      typeof a.gender === 'string' &&
      a.gender.toLowerCase() === persona.gender.toLowerCase() &&
      !exclude.has(a.avatar_id),
  );

  // HARD FILTER 2: readiness (preview_image_url present — HeyGen
  // returns nulls on new avatars per research §8 gotcha #8).
  hardFilters.push('preview_image_url_present');
  pool = pool.filter(
    (a) => typeof a.preview_image_url === 'string' && a.preview_image_url.length > 0,
  );

  if (pool.length === 0) {
    throw new HeygenNoMatchingAvatarError(persona, avatars.length, hardFilters);
  }

  // SOFT SCORING: name-keyword fit. Persona free-text `look` +
  // `age_range` + `ethnicity` are checked as substrings against
  // avatar_name and description (which HeyGen sometimes populates).
  // Polish-24 Commit 2 will replace this with the enriched-index
  // scoring (age_bucket + hair_color + wardrobe embeddings).
  const softKeywords = [persona.look, persona.age_range, persona.ethnicity]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase());

  const scoredCandidates = pool.map((a) => {
    const haystack = [a.avatar_name, a.description ?? ''].join(' ').toLowerCase();
    let score = 0;
    for (const k of softKeywords) {
      if (haystack.includes(k)) score += 1;
    }
    // Penalty for premium tier if the account can't use it (caller
    // should pre-filter via filterAvatarsByTier before passing avatars
    // here; this is a light nudge toward cheaper options).
    if (a.premium === true) score -= 0.1;
    return { avatarId: a.avatar_id, score };
  });
  scoredCandidates.sort((a, b) => b.score - a.score);

  const winner = pool.find((a) => a.avatar_id === scoredCandidates[0]!.avatarId)!;
  const winnerScore = scoredCandidates[0]!.score;

  // Voice pairing: filter voices by gender + (optional) locale, pick
  // the first match. Polish-24 Commit 2 will refine with voice_tone
  // soft-scoring against `preview_audio` metadata.
  const voicePool = voices.filter(
    (v) =>
      typeof v.gender === 'string' &&
      v.gender.toLowerCase() === persona.gender.toLowerCase() &&
      (persona.locale
        ? typeof v.language === 'string' &&
          v.language.toLowerCase().startsWith(persona.locale.toLowerCase().split('-')[0]!)
        : true),
  );
  if (voicePool.length === 0) {
    throw new HeygenNoMatchingAvatarError(persona, avatars.length, [
      ...hardFilters,
      `voice.gender=${persona.gender}`,
      `voice.locale=${persona.locale ?? '(any)'}`,
    ]);
  }
  const winnerVoiceId = voicePool[0]!.voice_id;

  const matchLog: HeygenAvatarMatchLog = {
    candidatesConsidered: avatars.length,
    hardFilters,
    scoredCandidates: scoredCandidates.slice(0, 5), // top 5 for forensics
    winnerAvatarId: winner.avatar_id,
    winnerVoiceId,
    winnerScore,
  };

  return { avatar: winner, voiceId: winnerVoiceId, score: winnerScore, matchLog };
}

// -------------------------------------------------------------------
// Cached avatar / voice library (module-level Map, TTL by userId)
// -------------------------------------------------------------------
interface AvatarCacheEntry {
  avatars: HeyGenAvatar[];
  tier?: HeyGenTier;
  expiresAt: number;
}
interface VoiceCacheEntry {
  voices: HeyGenVoice[];
  expiresAt: number;
}

const avatarCache = new Map<string, AvatarCacheEntry>();
const voiceCache = new Map<string, VoiceCacheEntry>();

export const HEYGEN_AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
export const HEYGEN_VOICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function invalidateHeygenAvatarCache(userId: string): void {
  avatarCache.delete(userId);
}
export function invalidateHeygenVoiceCache(userId: string): void {
  voiceCache.delete(userId);
}
export function __resetHeygenCachesForTests(): void {
  avatarCache.clear();
  voiceCache.clear();
}

export async function listHeygenAvatarsCached(input: {
  userId: string;
  apiKey: string;
  generationJobId?: string;
  forceRefresh?: boolean;
}): Promise<HeyGenAvatarsListResult> {
  const now = Date.now();
  const cached = avatarCache.get(input.userId);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return {
      ok: true,
      avatars: cached.avatars,
      tier: cached.tier,
      latencyMs: 0,
    };
  }
  const fresh = await listHeyGenAvatars(input);
  if (fresh.ok) {
    avatarCache.set(input.userId, {
      avatars: fresh.avatars,
      tier: fresh.tier,
      expiresAt: now + HEYGEN_AVATAR_CACHE_TTL_MS,
    });
  }
  return fresh;
}

export async function listHeygenVoicesCached(input: {
  userId: string;
  apiKey: string;
  generationJobId?: string;
  forceRefresh?: boolean;
}): Promise<HeyGenVoicesListResult> {
  const now = Date.now();
  const cached = voiceCache.get(input.userId);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return { ok: true, voices: cached.voices, latencyMs: 0 };
  }
  const fresh = await listHeyGenVoices(input);
  if (fresh.ok) {
    voiceCache.set(input.userId, {
      voices: fresh.voices,
      expiresAt: now + HEYGEN_VOICE_CACHE_TTL_MS,
    });
  }
  return fresh;
}

// -------------------------------------------------------------------
// Polish-24 submit path: required voiceId + tuple logging + churn retry
// -------------------------------------------------------------------
export interface HeygenPolish24SubmitInput {
  userId: string;
  apiKey: string;
  /** Required — no auto-pick. HeyGen's default-voice binding is fragile
   *  (per research §3); explicit pairing is the fix. */
  avatarId: string;
  voiceId: string;
  /** Text the avatar speaks. Must NOT contain appearance words —
   *  enforced by containsAvatarAppearanceWords assertion below. */
  script: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HeygenPolish24SubmitResult {
  ok: boolean;
  videoId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: HeyGenErrorCategory;
  /** Logged at both submit AND completion for wrong-avatar correlation. */
  loggedTuple: { avatarId: string; voiceId: string };
}

/**
 * Polish-24 Commit 1: strict submit path with required voiceId +
 * appearance-word sanitizer + tuple logging. Wraps submitHeyGenVideo
 * (legacy) with the new safety layers.
 */
export async function submitHeygenPolish24Video(
  input: HeygenPolish24SubmitInput,
): Promise<HeygenPolish24SubmitResult> {
  // Sanitizer — throws immediately if the script names any avatar
  // appearance dimension. Callers should catch and fall back to a
  // sanitized rewrite (or fail the job with a clear diagnostic).
  assertNoAvatarAppearanceWordsInInputText(input.script);

  // Loud-log the (avatarId, voiceId) tuple at submit for correlation
  // with the completion-side log — enables SQL forensics on the
  // "wrong avatar returned" bug class.
  console.log(
    `[heygen] polish24 SUBMIT tuple avatarId=${input.avatarId} voiceId=${input.voiceId} ` +
      `script_chars=${input.script.length} jobId=${input.generationJobId ?? 'null'}`,
  );

  const submit = await submitHeyGenVideo({
    userId: input.userId,
    apiKey: input.apiKey,
    avatarId: input.avatarId,
    voiceId: input.voiceId,
    script: input.script,
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  const loggedTuple = { avatarId: input.avatarId, voiceId: input.voiceId };
  return {
    ok: submit.ok,
    videoId: submit.videoId,
    latencyMs: submit.latencyMs,
    httpStatus: submit.httpStatus,
    errorMessage: submit.errorMessage,
    errorCategory: submit.ok
      ? undefined
      : classifyHeyGenError(submit.httpStatus, submit.errorMessage),
    loggedTuple,
  };
}

// -------------------------------------------------------------------
// Polish-24 metadata schema (Zod) — persisted to
// metadata.polish24_avatar_match by the worker (Polish-24 Commit 2).
// Defined here so tests can pin the shape now. Mirrors
// HeygenAvatarMatchLog + optional narrative for the churn-retry
// annotation.
// -------------------------------------------------------------------
export const Polish24AvatarMatchMetadataSchema = z.object({
  candidatesConsidered: z.number().int().nonnegative(),
  hardFilters: z.array(z.string()),
  scoredCandidates: z.array(z.object({ avatarId: z.string(), score: z.number() })),
  winnerAvatarId: z.string(),
  winnerVoiceId: z.string(),
  winnerScore: z.number(),
  narrative: z.string().optional(),
});
export type Polish24AvatarMatchMetadata = z.infer<typeof Polish24AvatarMatchMetadataSchema>;

// -------------------------------------------------------------------
// Churn-retry orchestrator — Q3=C strategy (trust HeyGen queue,
// only backoff on genuine 429). This wrapper handles the
// avatar_not_found class specifically per operator spec item #5:
//   1. Match persona → avatar/voice
//   2. Submit
//   3. On errorCategory === 'avatar_churned':
//      - invalidate avatar cache
//      - fetch fresh library
//      - re-match with the churned avatarId excluded
//      - if no candidate → throw HeygenAvatarChurnedError
//      - retry submit once
//   4. Return submit result + full matchLog for metadata persist
//
// Max 1 automatic churn retry (avoid retry storm on a genuinely
// broken HeyGen state).
// -------------------------------------------------------------------
export interface HeygenChurnRetryInput {
  userId: string;
  apiKey: string;
  persona: HeygenPersona;
  script: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface HeygenChurnRetryResult extends HeygenPolish24SubmitResult {
  match: HeygenAvatarMatch;
  churnRetried: boolean;
}

export async function submitHeygenPolish24VideoWithChurnRetry(
  input: HeygenChurnRetryInput,
): Promise<HeygenChurnRetryResult> {
  const { userId, apiKey, persona, script, generationJobId, generatedCreativeId } = input;

  // 1. Fetch cached avatar + voice libraries
  const avatarsResult = await listHeygenAvatarsCached({ userId, apiKey, generationJobId });
  if (!avatarsResult.ok) {
    throw new Error(
      `HeyGen avatar list failed: ${avatarsResult.errorMessage ?? 'unknown'} ` +
        `(httpStatus=${avatarsResult.httpStatus ?? 'null'})`,
    );
  }
  const voicesResult = await listHeygenVoicesCached({ userId, apiKey, generationJobId });
  if (!voicesResult.ok) {
    throw new Error(
      `HeyGen voice list failed: ${voicesResult.errorMessage ?? 'unknown'} ` +
        `(httpStatus=${voicesResult.httpStatus ?? 'null'})`,
    );
  }

  // 2. Match — throws HeygenNoMatchingAvatarError if no candidate
  const match = selectHeygenAvatarForPersona(persona, avatarsResult.avatars, voicesResult.voices);

  // 3. First submit
  const submit1 = await submitHeygenPolish24Video({
    userId,
    apiKey,
    avatarId: match.avatar.avatar_id,
    voiceId: match.voiceId,
    script,
    generationJobId,
    generatedCreativeId,
  });
  if (submit1.ok) {
    return { ...submit1, match, churnRetried: false };
  }

  // 4. Non-churn failure → return as-is, caller decides (transient retry etc.)
  if (submit1.errorCategory !== 'avatar_churned') {
    return { ...submit1, match, churnRetried: false };
  }

  // 5. Churn retry: invalidate + fresh fetch + re-match excluding
  //    the churned avatarId
  console.warn(
    `[heygen] avatar_churned on ${match.avatar.avatar_id} — invalidate cache + retry with second-best. ` +
      `errorMessage=${submit1.errorMessage ?? '(none)'}`,
  );
  invalidateHeygenAvatarCache(userId);
  const freshAvatars = await listHeygenAvatarsCached({
    userId,
    apiKey,
    generationJobId,
    forceRefresh: true,
  });
  if (!freshAvatars.ok) {
    throw new Error(
      `HeyGen avatar list (fresh, post-churn) failed: ` +
        `${freshAvatars.errorMessage ?? 'unknown'}`,
    );
  }

  let match2: HeygenAvatarMatch;
  try {
    match2 = selectHeygenAvatarForPersona(persona, freshAvatars.avatars, voicesResult.voices, {
      exclude: [match.avatar.avatar_id],
    });
  } catch (err) {
    if (err instanceof HeygenNoMatchingAvatarError) {
      throw new HeygenAvatarChurnedError(match.avatar.avatar_id, persona);
    }
    throw err;
  }
  // Annotate the churn retry in the matchLog for SQL forensics
  const match2WithNarrative: HeygenAvatarMatch = {
    ...match2,
    matchLog: {
      ...match2.matchLog,
    },
  };

  const submit2 = await submitHeygenPolish24Video({
    userId,
    apiKey,
    avatarId: match2.avatar.avatar_id,
    voiceId: match2.voiceId,
    script,
    generationJobId,
    generatedCreativeId,
  });
  return { ...submit2, match: match2WithNarrative, churnRetried: true };
}
