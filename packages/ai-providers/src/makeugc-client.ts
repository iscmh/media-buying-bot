/**
 * Polish-25 Commit 1: MakeUGC video-generation client.
 *
 * MakeUGC (makeugc.ai) is the pay-per-video UGC ad generator that
 * replaces the Polish-24 HeyGen pivot after avatar-quality rejection.
 * $99/mo API Starter tier = 2,000 credits/mo = $0.0495/video
 * (20-50x cheaper than HeyGen/Veo alternatives).
 *
 * Endpoints (verified 2026 via docs.makeugc.ai + third-party reviews;
 * primary docs page is Cloudflare-gated so shape triangulated from
 * apidog + community threads):
 *   - Base: https://app.makeugc.ai/api/platform
 *   - GET  /video/avatars?gender=Male|Female
 *   - GET  /video/voices?gender=Male|Female&language=English
 *   - POST /video/generate — { avatar_id, voice_script<=1500, voice_id?, video_name?, voice_settings?, webhook_url? }
 *   - GET  /video/status?id=<videoId>
 *
 * Auth: X-Api-Key header (NOT Authorization: Bearer).
 *
 * Response envelope pattern: { status: true|false, message: "...",
 * data: {...} }. Outer `status` is transport-level; the video state
 * lives at data.status. This shape MUST be parsed defensively — the
 * primary docs are gated and shape drift is a known risk.
 *
 * Mirrors the Polish-24 HeyGen client discipline patterns:
 *   - Typed errors (no-match, script-too-long, insufficient-credits)
 *   - Persona-driven avatar matcher with hard-filter gender + NO
 *     silent random fallback
 *   - Daily caches for avatar/voice libraries (6h/24h TTL by userId)
 *   - Transient error auto-retry gate (mirror WaveSpeedAI 3.0.29)
 *   - Loud-log raw poll status every tick (mirror kie.ai 3.0.31)
 *   - Zod-validated metadata audit trail for SQL forensics
 */
import { z } from 'zod';
import { callProvider } from './chokepoint';

const MAKEUGC_BASE = 'https://app.makeugc.ai/api/platform';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const AVATARS_TIMEOUT_MS = 15_000;
const VOICES_TIMEOUT_MS = 15_000;

// =========================================================================
// Types
// =========================================================================

export interface MakeugcAvatar {
  id: string;
  name: string;
  thumbnail?: string;
  /** MakeUGC returns "Male" / "Female" (title-case) — preserve verbatim. */
  gender?: string;
}

export interface MakeugcVoice {
  /**
   * MakeUGC's internal UUID reference. THIS is the value to send as
   * `voice_id` in POST /video/generate.
   *
   * Polish-25 Commit 5: verified by real-world job 9a9522c9 —
   * submit endpoint rejects the opaque TTS-engine string
   * (voiceId below) with "Voice not found" and accepts the
   * MakeUGC UUID (this `id` field). Prior to Commit 5, the
   * matcher returned voiceId to submit — root cause of the bug.
   */
  id: string;
  name: string;
  language?: string;
  gender?: string;
  templateUrl?: string;
  thumbnail?: string;
  /**
   * TTS engine's internal identifier (e.g. ElevenLabs voice
   * reference like `21m00Tcm4TlvDq8ikWAM`, `dmeLYJsj2pZfEwysJhtw`).
   * Kept for audit / debugging correlation only — NOT what the
   * MakeUGC submit endpoint expects. See job 9a9522c9 for the
   * Commit-5 bug proof.
   */
  voiceId: string;
  accent?: string;
  country?: string;
  isCustom?: boolean;
}

export type MakeugcVideoStatus = 'processing' | 'completed' | 'failed';

export type MakeugcErrorCategory =
  | 'auth' // 401 — bad key
  | 'not_found' // 404
  | 'validation' // 400
  | 'insufficient_credits' // 400 with 'credit' in message OR 402
  | 'rate_limit' // 429
  | 'server' // 5xx
  | 'timeout' // status=0 with timeout in message
  | 'unknown';

// =========================================================================
// Persona-driven avatar matcher
// =========================================================================

export interface MakeugcPersona {
  gender: 'male' | 'female';
  age_range: string;
  ethnicity?: string;
  look?: string;
  voice_tone?: string;
  /** e.g. "English" — used as MakeUGC's voice-language filter default. */
  language?: string;
}

export interface MakeugcAvatarMatchLog {
  candidatesConsidered: number;
  hardFilters: string[];
  scoredCandidates: Array<{ avatarId: string; score: number }>;
  winnerAvatarId: string;
  winnerVoiceId: string;
  winnerScore: number;
}

export interface MakeugcAvatarMatch {
  avatar: MakeugcAvatar;
  voice: MakeugcVoice;
  score: number;
  matchLog: MakeugcAvatarMatchLog;
}

// =========================================================================
// Typed errors
// =========================================================================

export class MakeugcNoMatchingAvatarError extends Error {
  readonly persona: MakeugcPersona;
  readonly candidatesConsidered: number;
  readonly hardFiltersApplied: readonly string[];
  constructor(
    persona: MakeugcPersona,
    candidatesConsidered: number,
    hardFiltersApplied: readonly string[],
  ) {
    super(
      `No MakeUGC avatar matches persona ` +
        `{gender: ${persona.gender}, age_range: ${persona.age_range}, ` +
        `ethnicity: ${persona.ethnicity ?? '(any)'}}. ` +
        `${candidatesConsidered} avatars considered, hard filters: ` +
        `[${hardFiltersApplied.join(', ')}]. ` +
        `Add matching MakeUGC actors or lift the persona filters.`,
    );
    this.name = 'MakeugcNoMatchingAvatarError';
    this.persona = persona;
    this.candidatesConsidered = candidatesConsidered;
    this.hardFiltersApplied = hardFiltersApplied;
  }
}

export class MakeugcInsufficientCreditsError extends Error {
  constructor(rawMessage?: string) {
    super(
      `MakeUGC account is out of credits. Top up at makeugc.ai/pricing. ` +
        `Raw: ${rawMessage ?? '(none)'}`,
    );
    this.name = 'MakeugcInsufficientCreditsError';
  }
}

export class MakeugcScriptTooLongError extends Error {
  readonly chars: number;
  constructor(chars: number) {
    super(
      `MakeUGC voice_script is ${chars} chars — max 1500. ` +
        `Trim the script (Polish-25 Commit 2 will add a Claude-based ` +
        `condenser before submit).`,
    );
    this.name = 'MakeugcScriptTooLongError';
    this.chars = chars;
  }
}

// =========================================================================
// Cost constants + estimator
// =========================================================================

export const MAKEUGC_CREDITS_PER_VIDEO = 1;

/** API Starter tier: $99 / 2000 credits = $0.0495/credit. */
export const MAKEUGC_USD_PER_CREDIT_STARTER = 99 / 2000;

/**
 * API Pro tier: $299/mo. Credit count NOT publicly documented and
 * pricing pages are Cloudflare-gated to our proxy. Placeholder ratio
 * assumes Pro delivers a bulk discount over Starter (~35% cheaper
 * per credit at 9000 credits/mo). MUST be dashboard-verified before
 * used in production billing. Estimator returns starter tier by
 * default until Polish-25 Commit 2 confirms the real number.
 */
export const MAKEUGC_USD_PER_CREDIT_PRO_APPROX = 299 / 9000;

export type MakeugcTier = 'starter' | 'pro';

export function estimateMakeugcVideoCostUsd(tier: MakeugcTier = 'starter'): number {
  const perCredit =
    tier === 'starter' ? MAKEUGC_USD_PER_CREDIT_STARTER : MAKEUGC_USD_PER_CREDIT_PRO_APPROX;
  return MAKEUGC_CREDITS_PER_VIDEO * perCredit;
}

// =========================================================================
// Transient error patterns (mirror WaveSpeedAI 3.0.29 pattern)
// =========================================================================

export const MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS: readonly string[] = [
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

export function isMakeugcTransientError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return false;
  const lower = errorMessage.toLowerCase();
  return MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// =========================================================================
// Script length validator + Zod refine
// =========================================================================

export const MAKEUGC_VOICE_SCRIPT_MAX_CHARS = 1500;

export function assertMakeugcScriptLength(script: string): void {
  if (typeof script !== 'string') {
    throw new MakeugcScriptTooLongError(0);
  }
  if (script.length > MAKEUGC_VOICE_SCRIPT_MAX_CHARS) {
    throw new MakeugcScriptTooLongError(script.length);
  }
}

export const MakeugcVoiceScriptSchema = z
  .string()
  .min(1)
  .max(MAKEUGC_VOICE_SCRIPT_MAX_CHARS, {
    message: `MakeUGC voice_script exceeds ${MAKEUGC_VOICE_SCRIPT_MAX_CHARS} chars.`,
  });

// =========================================================================
// Error classifier
// =========================================================================

export function classifyMakeugcError(
  status: number | undefined,
  message: string | undefined,
): MakeugcErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'insufficient_credits';
  if (status === 400) {
    if (typeof message === 'string' && /credit|balance|insufficient/i.test(message)) {
      return 'insufficient_credits';
    }
    return 'validation';
  }
  if (status === 0 && typeof message === 'string' && /timeout|aborted/i.test(message)) {
    return 'timeout';
  }
  if (typeof status === 'number' && status >= 500) return 'server';
  return 'unknown';
}

// =========================================================================
// Response envelope helpers
// =========================================================================

interface MakeugcEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

interface MakeugcAvatarRaw {
  id?: string;
  name?: string;
  thumbnail?: string;
  gender?: string;
}

interface MakeugcVoiceRaw {
  id?: string;
  name?: string;
  language?: string;
  gender?: string;
  templateUrl?: string;
  thumbnail?: string;
  voiceId?: string;
  accent?: string;
  country?: string;
  isCustom?: boolean;
}

interface MakeugcSubmitData {
  video_id?: string;
  videoId?: string;
  id?: string;
}

interface MakeugcStatusData {
  status?: string;
  url?: string;
  reason?: string;
}

export function normalizeMakeugcAvatar(raw: MakeugcAvatarRaw): MakeugcAvatar {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
    gender: typeof raw.gender === 'string' ? raw.gender : undefined,
  };
}

export function normalizeMakeugcVoice(raw: MakeugcVoiceRaw): MakeugcVoice {
  return {
    // Polish-25 Commit 5: `id` is MakeUGC's internal UUID — the value
    // downstream code sends as voice_id to POST /video/generate.
    // Verified against real-world submission (job 9a9522c9).
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    language: typeof raw.language === 'string' ? raw.language : undefined,
    gender: typeof raw.gender === 'string' ? raw.gender : undefined,
    templateUrl: typeof raw.templateUrl === 'string' ? raw.templateUrl : undefined,
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
    // TTS engine's internal identifier (ElevenLabs voice UUID etc).
    // Preserved for audit + debugging correlation. NOT what the
    // MakeUGC submit endpoint expects — see MakeugcVoice.id.
    // Fall back to `id` when the raw payload omits it so old / custom
    // avatar rows still have a non-empty string here.
    voiceId: String(raw.voiceId ?? raw.id ?? ''),
    accent: typeof raw.accent === 'string' ? raw.accent : undefined,
    country: typeof raw.country === 'string' ? raw.country : undefined,
    isCustom: typeof raw.isCustom === 'boolean' ? raw.isCustom : undefined,
  };
}

// =========================================================================
// GET /video/avatars
// =========================================================================

export interface ListMakeugcAvatarsInput {
  userId: string;
  apiKey: string;
  /** Optional MakeUGC-side filter. Case-sensitive per API: "Male" | "Female". */
  gender?: 'Male' | 'Female';
  generationJobId?: string;
}

export interface MakeugcAvatarsListResult {
  ok: boolean;
  avatars: MakeugcAvatar[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function listMakeugcAvatars(
  input: ListMakeugcAvatarsInput,
): Promise<MakeugcAvatarsListResult> {
  const query = input.gender ? `?gender=${encodeURIComponent(input.gender)}` : '';
  const result = await callProvider<MakeugcEnvelope<MakeugcAvatarRaw[]>>({
    userId: input.userId,
    provider: 'makeugc',
    url: `${MAKEUGC_BASE}/video/avatars${query}`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: AVATARS_TIMEOUT_MS,
    requestBodyForLog: { _list_avatars: true, gender: input.gender ?? '(any)' },
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
  const envelope = result.data;
  if (envelope.status === false) {
    return {
      ok: false,
      avatars: [],
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: envelope.message ?? 'MakeUGC returned status:false without a message.',
    };
  }
  const raw = Array.isArray(envelope.data) ? envelope.data : [];
  return {
    ok: true,
    avatars: raw.map(normalizeMakeugcAvatar),
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

// =========================================================================
// GET /video/voices
// =========================================================================

export interface ListMakeugcVoicesInput {
  userId: string;
  apiKey: string;
  gender?: 'Male' | 'Female';
  language?: string;
  generationJobId?: string;
}

export interface MakeugcVoicesListResult {
  ok: boolean;
  voices: MakeugcVoice[];
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function listMakeugcVoices(
  input: ListMakeugcVoicesInput,
): Promise<MakeugcVoicesListResult> {
  const params = new URLSearchParams();
  if (input.gender) params.set('gender', input.gender);
  if (input.language) params.set('language', input.language);
  const query = params.toString() ? `?${params.toString()}` : '';
  const result = await callProvider<MakeugcEnvelope<MakeugcVoiceRaw[]>>({
    userId: input.userId,
    provider: 'makeugc',
    url: `${MAKEUGC_BASE}/video/voices${query}`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: VOICES_TIMEOUT_MS,
    requestBodyForLog: {
      _list_voices: true,
      gender: input.gender ?? '(any)',
      language: input.language ?? '(any)',
    },
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
  const envelope = result.data;
  if (envelope.status === false) {
    return {
      ok: false,
      voices: [],
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: envelope.message ?? 'MakeUGC returned status:false without a message.',
    };
  }
  const raw = Array.isArray(envelope.data) ? envelope.data : [];
  return {
    ok: true,
    voices: raw.map(normalizeMakeugcVoice),
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

// =========================================================================
// POST /video/generate
// =========================================================================

export interface MakeugcSubmitInput {
  userId: string;
  apiKey: string;
  avatarId: string;
  voiceScript: string;
  /** Optional at raw-API level (avatar has a default voice). Polish-25
   *  worker (Commit 2) SHOULD always pass this to avoid silent voice
   *  binding drift — mirrors the HeyGen Polish-24 discipline. */
  voiceId?: string;
  videoName?: string;
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  /** Optional pre-recorded audio URL. Overrides voiceId + avatar default
   *  per MakeUGC's resolution order: voice_url → voice_id → default. */
  voiceUrl?: string;
  webhookUrl?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface MakeugcSubmitResult {
  ok: boolean;
  videoId?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: MakeugcErrorCategory;
}

export async function submitMakeugcVideo(input: MakeugcSubmitInput): Promise<MakeugcSubmitResult> {
  // Zod-refine at parse boundary so callers can't skip the length check.
  // Throws MakeugcScriptTooLongError before any HTTP call.
  assertMakeugcScriptLength(input.voiceScript);

  const body: Record<string, unknown> = {
    avatar_id: input.avatarId,
    voice_script: input.voiceScript,
  };
  if (input.voiceId) body['voice_id'] = input.voiceId;
  if (input.videoName) body['video_name'] = input.videoName;
  if (input.voiceSettings) body['voice_settings'] = input.voiceSettings;
  if (input.voiceUrl) body['voice_url'] = input.voiceUrl;
  if (input.webhookUrl) body['webhook_url'] = input.webhookUrl;

  // Polish-25 Commit 1: loud-log (avatarId, voiceId) tuple at submit
  // for wrong-avatar-bug correlation (mirror HeyGen Commit 1 pattern).
  console.log(
    `[makeugc] submit tuple avatarId=${input.avatarId} voiceId=${input.voiceId ?? '(default)'} ` +
      `script_chars=${input.voiceScript.length} jobId=${input.generationJobId ?? 'null'}`,
  );

  const result = await callProvider<MakeugcEnvelope<MakeugcSubmitData>>({
    userId: input.userId,
    provider: 'makeugc',
    url: `${MAKEUGC_BASE}/video/generate`,
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
      voice_id: input.voiceId ?? '(default)',
      script_chars: input.voiceScript.length,
      has_voice_url: !!input.voiceUrl,
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
      errorCategory: classifyMakeugcError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  if (envelope.status === false) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: envelope.message ?? 'MakeUGC returned status:false without a message.',
      errorCategory: classifyMakeugcError(result.status, envelope.message),
    };
  }
  // Try multiple response shapes — MakeUGC docs show data.video_id but
  // some endpoints use data.id or data.videoId (per apidog captures).
  const videoId = envelope.data?.video_id ?? envelope.data?.videoId ?? envelope.data?.id;
  if (!videoId || typeof videoId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: 'MakeUGC submit response is missing video_id (data.video_id/videoId/id).',
      errorCategory: 'unknown',
    };
  }
  return {
    ok: true,
    videoId,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

// =========================================================================
// GET /video/status
// =========================================================================

export interface MakeugcCheckInput {
  userId: string;
  apiKey: string;
  videoId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface MakeugcCheckResult {
  ok: boolean;
  status: MakeugcVideoStatus;
  url?: string;
  reason?: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  errorCategory?: MakeugcErrorCategory;
}

export async function checkMakeugcVideoStatus(
  input: MakeugcCheckInput,
): Promise<MakeugcCheckResult> {
  const result = await callProvider<MakeugcEnvelope<MakeugcStatusData>>({
    userId: input.userId,
    provider: 'makeugc',
    url: `${MAKEUGC_BASE}/video/status?id=${encodeURIComponent(input.videoId)}`,
    method: 'GET',
    headers: { 'X-Api-Key': input.apiKey, Accept: 'application/json' },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { video_id: input.videoId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      status: 'failed',
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
      errorCategory: classifyMakeugcError(result.status, result.errorMessage),
    };
  }
  const envelope = result.data;
  if (envelope.status === false) {
    return {
      ok: false,
      status: 'failed',
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: envelope.message ?? 'MakeUGC returned status:false without a message.',
      errorCategory: classifyMakeugcError(result.status, envelope.message),
    };
  }

  const data = envelope.data ?? {};
  const rawStatus = (data.status ?? '').toLowerCase();
  // Polish-25 Commit 1: loud-log raw + interpreted status on every
  // poll (mirror kie.ai 3.0.31 pattern). Any future new state
  // surfaces on FIRST poll instead of after N production runs.
  let interpreted: MakeugcVideoStatus;
  if (rawStatus === 'completed' || rawStatus === 'success') {
    interpreted = 'completed';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    interpreted = 'failed';
  } else {
    // Unknown / processing / queued / pending — default to processing
    // (mirror WaveSpeedAI Commit 3.0.31: defensive keep-polling on
    // unknown states rather than terminal-fail).
    if (rawStatus.length > 0 && rawStatus !== 'processing') {
      console.error(
        `[makeugc] UNKNOWN poll status ${JSON.stringify(data.status)} — ` +
          `add to checkMakeugcVideoStatus explicit branch. ` +
          `videoId=${input.videoId} body=${JSON.stringify(result.data).slice(0, 800)}`,
      );
    }
    interpreted = 'processing';
  }
  console.log(
    `[makeugc] poll videoId=${input.videoId} rawStatus=${JSON.stringify(data.status ?? null)} interpreted=${interpreted}`,
  );

  return {
    ok: true,
    status: interpreted,
    url: typeof data.url === 'string' ? data.url : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

// =========================================================================
// selectMakeugcAvatarForPersona — hard-filter gender, NO silent fallback
// =========================================================================

/**
 * Polish-25 Commit 1: mirrors the Polish-24 HeyGen matcher discipline.
 * Hard-filter by gender exact (MakeUGC returns "Male"/"Female"
 * title-case — normalize via toLowerCase). NO silent random fallback:
 * throws MakeugcNoMatchingAvatarError on empty candidate set.
 *
 * Voice pairing: hard-filter by gender + language match ("English"
 * default per operator's spec). Winner voice = first eligible in
 * the returned voice pool.
 *
 * Excludes any avatarId in the `exclude` list — used by the worker
 * (Polish-25 Commit 2) to retry a second-best if the primary
 * choice fails at submit for a non-transient reason.
 */
export function selectMakeugcAvatarForPersona(
  persona: MakeugcPersona,
  avatars: readonly MakeugcAvatar[],
  voices: readonly MakeugcVoice[],
  opts?: { exclude?: readonly string[]; language?: string },
): MakeugcAvatarMatch {
  const exclude = new Set(opts?.exclude ?? []);
  const language = opts?.language ?? persona.language ?? 'English';
  const hardFilters: string[] = [];

  // HARD FILTER 1: gender exact match (case-insensitive on MakeUGC's
  // title-case "Male"/"Female").
  hardFilters.push(`gender=${persona.gender}`);
  const pool = avatars.filter(
    (a) =>
      typeof a.gender === 'string' &&
      a.gender.toLowerCase() === persona.gender.toLowerCase() &&
      !exclude.has(a.id),
  );

  if (pool.length === 0) {
    throw new MakeugcNoMatchingAvatarError(persona, avatars.length, hardFilters);
  }

  // SOFT SCORING: name-keyword overlap on look/age_range/ethnicity.
  const softKeywords = [persona.look, persona.age_range, persona.ethnicity]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase());
  const scoredCandidates = pool.map((a) => {
    const haystack = a.name.toLowerCase();
    let score = 0;
    for (const k of softKeywords) {
      if (haystack.includes(k)) score += 1;
    }
    return { avatarId: a.id, score };
  });
  scoredCandidates.sort((a, b) => b.score - a.score);
  const winner = pool.find((a) => a.id === scoredCandidates[0]!.avatarId)!;
  const winnerScore = scoredCandidates[0]!.score;

  // VOICE HARD FILTERS: gender + language.
  hardFilters.push(`voice.gender=${persona.gender}`);
  hardFilters.push(`voice.language=${language}`);
  const voicePool = voices.filter(
    (v) =>
      typeof v.gender === 'string' &&
      v.gender.toLowerCase() === persona.gender.toLowerCase() &&
      typeof v.language === 'string' &&
      v.language.toLowerCase() === language.toLowerCase(),
  );
  if (voicePool.length === 0) {
    throw new MakeugcNoMatchingAvatarError(persona, avatars.length, hardFilters);
  }
  const winnerVoice = voicePool[0]!;

  // Polish-25 Commit 5: loud-log BOTH voice identifiers at match
  // time. Job 9a9522c9 root cause was matcher returning the TTS
  // engine ID (voice.voiceId) instead of the MakeUGC UUID (voice.id).
  // Logging both makes any future submit-endpoint drift or field-
  // swap regression visible in one Vercel Runtime Logs line.
  console.log(
    `[makeugc-match] winner voice.id=${winnerVoice.id} voice.voiceId=${winnerVoice.voiceId} ` +
      `(submit will receive voice.id) avatar.id=${winner.id} avatar.name=${JSON.stringify(winner.name)}`,
  );

  const matchLog: MakeugcAvatarMatchLog = {
    candidatesConsidered: avatars.length,
    hardFilters,
    scoredCandidates: scoredCandidates.slice(0, 5),
    winnerAvatarId: winner.id,
    // Polish-25 Commit 5: report the value that will be SENT to submit
    // (voice.id, the MakeUGC UUID) — NOT voice.voiceId (TTS opaque
    // string). Historical: this line was `winnerVoice.voiceId` in
    // Commits 1-4 and caused every submit to fail with "Voice not
    // found" once real ElevenLabs-style voiceIds appeared in the
    // MakeUGC voice pool.
    winnerVoiceId: winnerVoice.id,
    winnerScore,
  };
  return { avatar: winner, voice: winnerVoice, score: winnerScore, matchLog };
}

// =========================================================================
// Polish-25 Commit 7: enriched-index matcher
// =========================================================================

/**
 * Enriched avatar row — the shape the polish25-makeugc worker
 * hydrates from makeugc_avatar_index (populated by the nightly
 * refresh worker). Fields mirror the SQL table + Gemini vision
 * schema in packages/jobs/src/lib/makeugc-avatar-vision-prompt.ts.
 *
 * Deliberately loose typing on the descriptor strings — the
 * matcher does string-equality comparisons (age_bucket exact +
 * ethnicity exact) and case-insensitive substring checks (hair
 * / facial hair / wardrobe fuzzy scoring). Callers Zod-validate
 * upstream if they want stricter enum guarantees.
 */
export interface MakeugcEnrichedAvatar {
  avatarId: string;
  avatarName: string;
  makeugcGender: string; // "Male" | "Female"
  ageBucket: string; // "20s" | ... | "80s+"
  ethnicity: string;
  hairColor: string;
  hairStyle: string | null;
  facialHair: string | null;
  wardrobeStyle: string | null;
  wardrobeSummary: string | null;
  backgroundSetting: string | null;
}

export interface MakeugcEnrichedMatchLog {
  candidatesConsidered: number;
  hardFilters: string[];
  scoredCandidates: Array<{
    avatarId: string;
    score: number;
    breakdown: {
      ethnicity: number;
      hair: number;
      facialHair: number;
      wardrobe: number;
    };
  }>;
  winnerAvatarId: string;
  winnerVoiceId: string;
  winnerScore: number;
  matchStrategy: 'enriched-index' | 'gender-only-fallback';
}

export interface MakeugcEnrichedMatchResult {
  avatar: MakeugcEnrichedAvatar;
  voice: MakeugcVoice;
  score: number;
  matchLog: MakeugcEnrichedMatchLog;
}

/** Persona-decade → age bucket. Persona.age_range can be free-form
 *  ("60s", "mid-60s", "60-year-old", "senior") — extract the first
 *  1-2 digit decade tag and map to the closed MakeUGC bucket set.
 *  Returns null for genuinely unparseable ranges; caller decides
 *  whether to apply an age hard-filter or skip it. */
export function personaAgeRangeToBucket(rawAgeRange: string): string | null {
  if (typeof rawAgeRange !== 'string' || rawAgeRange.trim().length === 0) return null;
  const s = rawAgeRange.toLowerCase();
  // 80+ collapses to a single bucket. Match "80", "80s", "82",
  // "80-year-old", "aged 82", 90s, etc. — the leading `\b` requires a
  // word boundary, so incidental substrings like "180" don't hit.
  if (/\b(8|9)\d/.test(s)) return '80s+';
  // 2-digit ages 20-79 (e.g. "62", "60", "38", "42-year-old"). We
  // don't require a trailing \b because "60s" has no boundary between
  // the digits and the 's'.
  const twoDigit = s.match(/\b([2-7])\d/);
  if (twoDigit && twoDigit[1]) return `${twoDigit[1]}0s`;
  // Word forms.
  if (/\btwenties?\b|\btwentysomething\b/.test(s)) return '20s';
  if (/\bthirties?\b|\bthirtysomething\b/.test(s)) return '30s';
  if (/\bforties?\b|\bfortysomething\b/.test(s)) return '40s';
  if (/\bfiftie?s?\b|\bfifty\b|\bfiftysomething\b/.test(s)) return '50s';
  if (/\bsixtie?s?\b|\bsixty\b|\bsixtysomething\b/.test(s)) return '60s';
  if (/\bseventie?s?\b|\bseventy\b|\bseventysomething\b/.test(s)) return '70s';
  if (/\beightie?s?\b|\beighty\b|\bninet(y|ies)\b|\belderly\b|\bsenior\b/.test(s)) return '80s+';
  return null;
}

const AGE_BUCKET_ORDER = ['20s', '30s', '40s', '50s', '60s', '70s', '80s+'] as const;

/** Returns buckets within ±1 slot of the target — the hard-filter
 *  tolerance for the enriched matcher. e.g. target "60s" →
 *  ["50s","60s","70s"]. */
export function ageBucketNeighbors(target: string): string[] {
  const idx = AGE_BUCKET_ORDER.indexOf(target as (typeof AGE_BUCKET_ORDER)[number]);
  if (idx < 0) return [];
  const out: string[] = [];
  if (idx > 0) out.push(AGE_BUCKET_ORDER[idx - 1]!);
  out.push(AGE_BUCKET_ORDER[idx]!);
  if (idx < AGE_BUCKET_ORDER.length - 1) out.push(AGE_BUCKET_ORDER[idx + 1]!);
  return out;
}

/**
 * Score contributions per operator's spec:
 *   - ethnicity exact match: +10
 *   - hair fuzzy (persona.look substring on avatar.hairColor OR
 *     avatar.hairStyle): +5
 *   - facial hair fuzzy: +3
 *   - wardrobe fuzzy (persona.look substring on avatar.wardrobeStyle
 *     OR wardrobeSummary): +2
 *
 * Age is a HARD FILTER (±1 bucket) not a scored dimension — mismatched
 * age never makes it into the candidate pool.
 */
export const MAKEUGC_ENRICHED_SCORE_WEIGHTS = {
  ethnicityExact: 10,
  hair: 5,
  facialHair: 3,
  wardrobe: 2,
} as const;

/** Bidirectional fuzzy: true when either side contains the other after
 *  normalizing hyphens / underscores → spaces. Handles cases like
 *  persona.look="clean-shaven" against avatar.facialHair="clean_shaven",
 *  or persona.look="blue polo shirt" against wardrobeSummary="navy
 *  blue polo shirt". */
function bidiFuzzy(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, ' ');
  const aN = norm(a);
  const bN = norm(b);
  if (aN.length === 0 || bN.length === 0) return false;
  return aN.includes(bN) || bN.includes(aN);
}

function scoreEnrichedAvatar(
  avatar: MakeugcEnrichedAvatar,
  persona: MakeugcPersona,
  personaAgeBucket: string | null,
): {
  total: number;
  breakdown: { ethnicity: number; hair: number; facialHair: number; wardrobe: number };
} {
  const w = MAKEUGC_ENRICHED_SCORE_WEIGHTS;

  // Ethnicity exact (case-insensitive; persona.ethnicity may be
  // absent — worth zero, not negative).
  const ethnicity =
    typeof persona.ethnicity === 'string' &&
    persona.ethnicity.trim().length > 0 &&
    avatar.ethnicity.toLowerCase() === persona.ethnicity.toLowerCase()
      ? w.ethnicityExact
      : 0;

  // Hair fuzzy: hair_color OR hair_style either-way substring match
  // against persona.look ("gray hair" in look → avatar.hairColor="gray"
  // scores; also handles the reverse direction).
  const look = typeof persona.look === 'string' ? persona.look : '';
  const hair = bidiFuzzy(look, avatar.hairColor) || bidiFuzzy(look, avatar.hairStyle) ? w.hair : 0;

  // Facial hair fuzzy: persona.look="clean-shaven" ↔ avatar.facialHair
  // ="clean_shaven" — bidiFuzzy normalizes hyphens + underscores.
  const facialHair = bidiFuzzy(look, avatar.facialHair) ? w.facialHair : 0;

  // Wardrobe fuzzy: match against wardrobe_style enum OR the
  // freeform wardrobe_summary — either direction.
  const wardrobe =
    bidiFuzzy(look, avatar.wardrobeStyle) || bidiFuzzy(look, avatar.wardrobeSummary)
      ? w.wardrobe
      : 0;

  // Age bucket exact match beats age bucket ±1 (soft bonus so the
  // exact hit outranks a same-score-otherwise ±1 candidate).
  const ageBonus = personaAgeBucket && avatar.ageBucket === personaAgeBucket ? 1 : 0;

  return {
    total: ethnicity + hair + facialHair + wardrobe + ageBonus,
    breakdown: { ethnicity, hair, facialHair, wardrobe },
  };
}

/**
 * Polish-25 Commit 7: enriched-index matcher.
 *
 * HARD FILTERS (throw MakeugcNoMatchingAvatarError on empty result):
 *   1. makeugcGender exact match ("Male" ↔ persona.gender="male")
 *   2. ageBucket ∈ neighbors(persona.age_range) (±1 bucket
 *      tolerance). If persona.age_range can't be parsed to a
 *      known bucket, the age filter is skipped and hardFilters
 *      records "age=unparseable" for audit.
 *   3. Voice pool has ≥1 candidate matching gender + language
 *      (mirror Commit 1 voice discipline).
 *
 * SOFT SCORING: see MAKEUGC_ENRICHED_SCORE_WEIGHTS.
 *
 * `exclude` skips avatarIds (used by the worker for second-best
 * retry after a submit-side non-transient failure — mirrors
 * Commit 1 pattern).
 *
 * NO silent random fallback — throws when the candidate pool is
 * empty after hard filters. The worker owns the empty-index
 * fallback (drops to Commit 1's gender-only matcher).
 */
export function selectMakeugcAvatarForPersonaFromIndex(
  persona: MakeugcPersona,
  enrichedAvatars: readonly MakeugcEnrichedAvatar[],
  voices: readonly MakeugcVoice[],
  opts?: { exclude?: readonly string[]; language?: string },
): MakeugcEnrichedMatchResult {
  const exclude = new Set(opts?.exclude ?? []);
  const language = opts?.language ?? persona.language ?? 'English';
  const hardFilters: string[] = [];

  // HARD FILTER 1: gender.
  hardFilters.push(`gender=${persona.gender}`);
  const genderPool = enrichedAvatars.filter(
    (a) =>
      typeof a.makeugcGender === 'string' &&
      a.makeugcGender.toLowerCase() === persona.gender.toLowerCase() &&
      !exclude.has(a.avatarId),
  );
  if (genderPool.length === 0) {
    throw new MakeugcNoMatchingAvatarError(persona, enrichedAvatars.length, hardFilters);
  }

  // HARD FILTER 2: age bucket ±1 (if parseable).
  const personaBucket = personaAgeRangeToBucket(persona.age_range);
  let agePool: MakeugcEnrichedAvatar[];
  if (personaBucket === null) {
    hardFilters.push('age=unparseable(skipped)');
    agePool = genderPool;
  } else {
    const neighbors = new Set(ageBucketNeighbors(personaBucket));
    hardFilters.push(`age∈${JSON.stringify(Array.from(neighbors))}`);
    agePool = genderPool.filter((a) => neighbors.has(a.ageBucket));
    if (agePool.length === 0) {
      throw new MakeugcNoMatchingAvatarError(persona, enrichedAvatars.length, hardFilters);
    }
  }

  // Score every survivor.
  const scored = agePool.map((a) => {
    const { total, breakdown } = scoreEnrichedAvatar(a, persona, personaBucket);
    return { avatarId: a.avatarId, score: total, breakdown };
  });
  scored.sort((a, b) => b.score - a.score);
  const winnerScored = scored[0]!;
  const winnerAvatar = agePool.find((a) => a.avatarId === winnerScored.avatarId)!;

  // HARD FILTER 3: voice pool (mirror Commit 1).
  hardFilters.push(`voice.gender=${persona.gender}`);
  hardFilters.push(`voice.language=${language}`);
  const voicePool = voices.filter(
    (v) =>
      typeof v.gender === 'string' &&
      v.gender.toLowerCase() === persona.gender.toLowerCase() &&
      typeof v.language === 'string' &&
      v.language.toLowerCase() === language.toLowerCase(),
  );
  if (voicePool.length === 0) {
    throw new MakeugcNoMatchingAvatarError(persona, enrichedAvatars.length, hardFilters);
  }
  const winnerVoice = voicePool[0]!;

  console.log(
    `[makeugc-match:enriched] winner avatar.id=${winnerAvatar.avatarId} ` +
      `age=${winnerAvatar.ageBucket} ethnicity=${winnerAvatar.ethnicity} ` +
      `score=${winnerScored.score} breakdown=${JSON.stringify(winnerScored.breakdown)} ` +
      `voice.id=${winnerVoice.id} voice.voiceId=${winnerVoice.voiceId}`,
  );

  const matchLog: MakeugcEnrichedMatchLog = {
    candidatesConsidered: enrichedAvatars.length,
    hardFilters,
    scoredCandidates: scored.slice(0, 5),
    winnerAvatarId: winnerAvatar.avatarId,
    winnerVoiceId: winnerVoice.id,
    winnerScore: winnerScored.score,
    matchStrategy: 'enriched-index',
  };
  return { avatar: winnerAvatar, voice: winnerVoice, score: winnerScored.score, matchLog };
}

// =========================================================================
// Daily-cached avatar / voice library (module-level Map, TTL by userId)
// =========================================================================

interface MakeugcAvatarCacheEntry {
  avatars: MakeugcAvatar[];
  expiresAt: number;
}
interface MakeugcVoiceCacheEntry {
  voices: MakeugcVoice[];
  expiresAt: number;
}

const makeugcAvatarCache = new Map<string, MakeugcAvatarCacheEntry>();
const makeugcVoiceCache = new Map<string, MakeugcVoiceCacheEntry>();

export const MAKEUGC_AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
export const MAKEUGC_VOICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function invalidateMakeugcAvatarCache(userId: string): void {
  // Cache keys are `${userId}|${gender ?? ''}` — a single userId may
  // have multiple cache entries (unfiltered + gender-filtered).
  // Delete all entries for this userId in one sweep.
  const prefix = `${userId}|`;
  for (const key of Array.from(makeugcAvatarCache.keys())) {
    if (key === userId || key.startsWith(prefix)) {
      makeugcAvatarCache.delete(key);
    }
  }
}
export function invalidateMakeugcVoiceCache(userId: string): void {
  const prefix = `${userId}|`;
  for (const key of Array.from(makeugcVoiceCache.keys())) {
    if (key === userId || key.startsWith(prefix)) {
      makeugcVoiceCache.delete(key);
    }
  }
}
export function __resetMakeugcCachesForTests(): void {
  makeugcAvatarCache.clear();
  makeugcVoiceCache.clear();
}

export async function listMakeugcAvatarsCached(input: {
  userId: string;
  apiKey: string;
  gender?: 'Male' | 'Female';
  generationJobId?: string;
  forceRefresh?: boolean;
}): Promise<MakeugcAvatarsListResult> {
  const now = Date.now();
  // Cache key includes gender filter so filtered fetches don't share
  // with the full-list fetch. Different gender = different bucket.
  const cacheKey = `${input.userId}|${input.gender ?? ''}`;
  const cached = makeugcAvatarCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return { ok: true, avatars: cached.avatars, latencyMs: 0 };
  }
  const fresh = await listMakeugcAvatars(input);
  if (fresh.ok) {
    makeugcAvatarCache.set(cacheKey, {
      avatars: fresh.avatars,
      expiresAt: now + MAKEUGC_AVATAR_CACHE_TTL_MS,
    });
  }
  return fresh;
}

export async function listMakeugcVoicesCached(input: {
  userId: string;
  apiKey: string;
  gender?: 'Male' | 'Female';
  language?: string;
  generationJobId?: string;
  forceRefresh?: boolean;
}): Promise<MakeugcVoicesListResult> {
  const now = Date.now();
  const cacheKey = `${input.userId}|${input.gender ?? ''}|${input.language ?? ''}`;
  const cached = makeugcVoiceCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return { ok: true, voices: cached.voices, latencyMs: 0 };
  }
  const fresh = await listMakeugcVoices(input);
  if (fresh.ok) {
    makeugcVoiceCache.set(cacheKey, {
      voices: fresh.voices,
      expiresAt: now + MAKEUGC_VOICE_CACHE_TTL_MS,
    });
  }
  return fresh;
}

// =========================================================================
// Polish-25 metadata schemas (Zod)
// =========================================================================

export const Polish25AvatarMatchMetadataSchema = z.object({
  candidatesConsidered: z.number().int().nonnegative(),
  hardFilters: z.array(z.string()),
  scoredCandidates: z.array(z.object({ avatarId: z.string(), score: z.number() })),
  winnerAvatarId: z.string(),
  winnerVoiceId: z.string(),
  winnerScore: z.number(),
  narrative: z.string().optional(),
});
export type Polish25AvatarMatchMetadata = z.infer<typeof Polish25AvatarMatchMetadataSchema>;

export const Polish25CreditsUsedMetadataSchema = z.object({
  creditsUsed: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  tier: z.enum(['starter', 'pro']),
  at: z.string(), // ISO timestamp
});
export type Polish25CreditsUsedMetadata = z.infer<typeof Polish25CreditsUsedMetadataSchema>;
