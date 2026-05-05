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

export interface HeyGenAvatar {
  avatar_id: string;
  avatar_name: string;
  gender?: string;
  preview_image_url?: string;
  /** HeyGen surfaces tags inconsistently — we use whatever's present for matching. */
  description?: string;
}

export interface HeyGenAvatarsListResult {
  ok: boolean;
  avatars: HeyGenAvatar[];
  latencyMs: number;
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
    data?: { avatars?: HeyGenAvatar[] };
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
      errorMessage: result.errorMessage,
    };
  }

  return {
    ok: true,
    avatars: result.data.data?.avatars ?? [],
    latencyMs: result.latencyMs,
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
): HeyGenAvatar | null {
  if (avatars.length === 0) return null;

  const keywords = [persona.age, persona.gender, persona.vibe, persona.setting]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase());
  if (keywords.length === 0) return null;

  let bestScore = 0;
  let best: HeyGenAvatar | null = null;
  for (const a of avatars) {
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
        },
        voice: {
          type: 'text',
          input_text: input.script,
          ...(input.voiceId ? { voice_id: input.voiceId } : {}),
        },
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
    return { ok: false, latencyMs: result.latencyMs, errorMessage: result.errorMessage };
  }

  const videoId = result.data.data?.video_id;
  if (!videoId) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'HeyGen response did not include a video_id',
    };
  }
  return { ok: true, videoId, latencyMs: result.latencyMs };
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
    errorMessage: status === 'failed' ? data.error?.message : undefined,
  };
}
