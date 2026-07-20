/**
 * Polish-25 Commit 1: MakeUGC client tests.
 *
 * Mirrors the Polish-24 HeyGen client discipline patterns:
 *   - Endpoint contract (URL, X-Api-Key header, snake_case body)
 *   - Response-envelope parsing (status:bool + data:{...})
 *   - Poll-state normalization (processing/completed/failed + defensive
 *     unknown → processing fallback)
 *   - Persona matcher: hard-filter gender + NO silent fallback
 *   - Script-length Zod refine
 *   - Transient error patterns
 *   - Cost estimator
 *   - Daily cache TTL + invalidate
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetMakeugcCachesForTests,
  assertMakeugcScriptLength,
  checkMakeugcVideoStatus,
  classifyMakeugcError,
  estimateMakeugcVideoCostUsd,
  invalidateMakeugcAvatarCache,
  isMakeugcTransientError,
  listMakeugcAvatars,
  listMakeugcAvatarsCached,
  listMakeugcVoices,
  MakeugcNoMatchingAvatarError,
  MakeugcScriptTooLongError,
  MakeugcVoiceScriptSchema,
  MAKEUGC_AVATAR_CACHE_TTL_MS,
  MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS,
  MAKEUGC_USD_PER_CREDIT_STARTER,
  MAKEUGC_VOICE_CACHE_TTL_MS,
  MAKEUGC_VOICE_SCRIPT_MAX_CHARS,
  normalizeMakeugcVoice,
  Polish25AvatarMatchMetadataSchema,
  Polish25CreditsUsedMetadataSchema,
  selectMakeugcAvatarForPersona,
  submitMakeugcVideo,
  type MakeugcAvatar,
  type MakeugcVoice,
} from '../src/makeugc-client';
import { MakeugcProvider } from '../src/makeugc';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetchOnce(response: { status: number; body: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: response.status,
    text: async () => JSON.stringify(response.body),
  } as Response) as typeof globalThis.fetch;
}

function captureFetch(response: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

// -------------------------------------------------------------------
// Endpoint contract: URL + auth + response envelope
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: listMakeugcAvatars — endpoint + auth + envelope', () => {
  it('hits GET /video/avatars with X-Api-Key header + parses envelope', async () => {
    const calls = captureFetch({
      status: 200,
      body: {
        status: true,
        message: 'ok',
        data: [
          { id: 'a1', name: 'David', thumbnail: 'https://cdn/a1.jpg', gender: 'Male' },
          { id: 'a2', name: 'Linda', thumbnail: 'https://cdn/a2.jpg', gender: 'Female' },
        ],
      },
    });
    const r = await listMakeugcAvatars({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.avatars).toHaveLength(2);
    expect(r.avatars[0]!.id).toBe('a1');
    expect(r.avatars[0]!.gender).toBe('Male');
    // URL + auth header assertions
    expect(calls[0]!.url).toBe('https://app.makeugc.ai/api/platform/video/avatars');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('k');
  });

  it('threads gender query param when provided', async () => {
    const calls = captureFetch({
      status: 200,
      body: { status: true, data: [] },
    });
    await listMakeugcAvatars({ userId: 'u', apiKey: 'k', gender: 'Male' });
    expect(calls[0]!.url).toBe('https://app.makeugc.ai/api/platform/video/avatars?gender=Male');
  });

  it('propagates 401 auth failure with httpStatus', async () => {
    mockFetchOnce({ status: 401, body: { status: false, message: 'Invalid API key' } });
    const r = await listMakeugcAvatars({ userId: 'u', apiKey: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(401);
  });

  it('surfaces status:false envelope even on HTTP 200', async () => {
    mockFetchOnce({
      status: 200,
      body: { status: false, message: 'Unexpected server error' },
    });
    const r = await listMakeugcAvatars({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Unexpected server error/);
  });
});

describe('Polish-25 Commit 1: listMakeugcVoices — endpoint + envelope', () => {
  it('hits GET /video/voices + parses camelCase voice.voiceId field', async () => {
    const calls = captureFetch({
      status: 200,
      body: {
        status: true,
        data: [
          {
            id: 'row_1',
            name: 'Male US News',
            language: 'English',
            gender: 'Male',
            voiceId: '21m00Tcm4TlvDq8ikWAM',
            accent: 'American',
            country: 'US',
            isCustom: false,
          },
        ],
      },
    });
    const r = await listMakeugcVoices({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.voices).toHaveLength(1);
    // MakeUGC returns BOTH `id` (its own UUID reference) and `voiceId`
    // (the TTS engine's internal identifier — e.g. an ElevenLabs
    // voice UUID). Client preserves both. Polish-25 Commit 5:
    // downstream submit uses `id` (MakeUGC's UUID) — `voiceId` is
    // retained for audit / debugging only.
    expect(r.voices[0]!.id).toBe('row_1');
    expect(r.voices[0]!.voiceId).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(calls[0]!.url).toBe('https://app.makeugc.ai/api/platform/video/voices');
  });

  it('threads gender+language filters when both provided', async () => {
    const calls = captureFetch({ status: 200, body: { status: true, data: [] } });
    await listMakeugcVoices({
      userId: 'u',
      apiKey: 'k',
      gender: 'Female',
      language: 'English',
    });
    expect(calls[0]!.url).toContain('gender=Female');
    expect(calls[0]!.url).toContain('language=English');
  });
});

// -------------------------------------------------------------------
// Submit + poll
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: submitMakeugcVideo — script length + body shape + envelope', () => {
  it('sends snake_case body with avatar_id + voice_script + voice_id + envelope-parses videoId', async () => {
    const calls = captureFetch({
      status: 200,
      body: { status: true, data: { video_id: 'vid_new_abc' } },
    });
    const r = await submitMakeugcVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a1',
      voiceScript: 'I tried this app for two weeks and honestly the savings were real.',
      voiceId: 'v1_male_us',
    });
    expect(r.ok).toBe(true);
    expect(r.videoId).toBe('vid_new_abc');
    expect(calls[0]!.url).toBe('https://app.makeugc.ai/api/platform/video/generate');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.avatar_id).toBe('a1');
    expect(body.voice_id).toBe('v1_male_us');
    expect(body.voice_script).toMatch(/I tried this app/);
  });

  it('THROWS MakeugcScriptTooLongError when voice_script > 1500 chars (BEFORE any HTTP call)', async () => {
    let fetchCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCalled = true;
      return { status: 200, text: async () => '{}' } as Response;
    }) as typeof globalThis.fetch;
    const longScript = 'x'.repeat(1501);
    await expect(
      submitMakeugcVideo({
        userId: 'u',
        apiKey: 'k',
        avatarId: 'a1',
        voiceScript: longScript,
        voiceId: 'v1',
      }),
    ).rejects.toThrow(MakeugcScriptTooLongError);
    expect(fetchCalled).toBe(false);
  });

  it('accepts EXACTLY 1500 char script (boundary anchor)', async () => {
    mockFetchOnce({
      status: 200,
      body: { status: true, data: { video_id: 'vid_boundary' } },
    });
    const script = 'y'.repeat(1500);
    const r = await submitMakeugcVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a1',
      voiceScript: script,
      voiceId: 'v1',
    });
    expect(r.ok).toBe(true);
  });

  it('surfaces 400 with credit-in-message as insufficient_credits errorCategory', async () => {
    mockFetchOnce({
      status: 400,
      body: { status: false, message: 'Insufficient credits (need 1)' },
    });
    const r = await submitMakeugcVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a1',
      voiceScript: 'hi',
      voiceId: 'v1',
    });
    expect(r.ok).toBe(false);
    expect(r.errorCategory).toBe('insufficient_credits');
  });

  it('surfaces missing video_id in response as unknown-error', async () => {
    mockFetchOnce({
      status: 200,
      body: { status: true, data: {} }, // no video_id
    });
    const r = await submitMakeugcVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a1',
      voiceScript: 'hi',
      voiceId: 'v1',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing video_id/i);
  });
});

describe('Polish-25 Commit 1: checkMakeugcVideoStatus — envelope + poll-state normalization', () => {
  it("processing envelope → status='processing'", async () => {
    mockFetchOnce({
      status: 200,
      body: { status: true, message: 'Video is processing', data: { status: 'processing' } },
    });
    const r = await checkMakeugcVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('processing');
    expect(r.url).toBeUndefined();
  });

  it("completed envelope → status='completed' + url extracted from data.url", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        status: true,
        message: 'Video is completed',
        data: { status: 'completed', url: 'https://cloudfront.net/signed.mp4' },
      },
    });
    const r = await checkMakeugcVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('completed');
    expect(r.url).toBe('https://cloudfront.net/signed.mp4');
  });

  it("failed envelope → status='failed' + reason extracted from data.reason", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        status: true,
        data: { status: 'failed', reason: 'Request timeout due to high load' },
      },
    });
    const r = await checkMakeugcVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/high load/);
  });

  it('unknown data.status → defaults to processing (defensive, mirrors kie.ai 3.0.31 pattern)', async () => {
    // A future MakeUGC state (e.g. "queued", "pending", "initializing")
    // should NOT terminal-fail the job. Keep polling until the state
    // resolves; operator adds it to the explicit branch next commit.
    mockFetchOnce({
      status: 200,
      body: { status: true, data: { status: 'queued' } },
    });
    const r = await checkMakeugcVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('processing');
  });
});

// -------------------------------------------------------------------
// Error classifier
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: classifyMakeugcError — HTTP status → category', () => {
  it('401/403 → auth', () => {
    expect(classifyMakeugcError(401, 'invalid api key')).toBe('auth');
    expect(classifyMakeugcError(403, 'forbidden')).toBe('auth');
  });
  it('402 → insufficient_credits', () => {
    expect(classifyMakeugcError(402, 'out of credits')).toBe('insufficient_credits');
  });
  it('400 with credit substring → insufficient_credits (MakeUGC returns 400 for out-of-credits per docs)', () => {
    expect(classifyMakeugcError(400, 'Insufficient credits')).toBe('insufficient_credits');
    expect(classifyMakeugcError(400, 'balance is too low')).toBe('insufficient_credits');
    expect(classifyMakeugcError(400, 'insufficient balance')).toBe('insufficient_credits');
  });
  it('400 without credit substring → validation', () => {
    expect(classifyMakeugcError(400, 'voice_script too long')).toBe('validation');
    expect(classifyMakeugcError(400, 'malformed request')).toBe('validation');
  });
  it('404 → not_found', () => {
    expect(classifyMakeugcError(404, 'avatar not found')).toBe('not_found');
  });
  it('429 → rate_limit', () => {
    expect(classifyMakeugcError(429, 'rate limited')).toBe('rate_limit');
  });
  it('500/502/503/504 → server', () => {
    expect(classifyMakeugcError(500, 'oops')).toBe('server');
    expect(classifyMakeugcError(502, 'bad gateway')).toBe('server');
    expect(classifyMakeugcError(503, 'unavailable')).toBe('server');
    expect(classifyMakeugcError(504, 'timeout')).toBe('server');
  });
  it('status 0 + timeout in message → timeout', () => {
    expect(classifyMakeugcError(0, 'request timeout')).toBe('timeout');
    expect(classifyMakeugcError(0, 'aborted')).toBe('timeout');
  });
  it('unknown → unknown', () => {
    expect(classifyMakeugcError(418, "I'm a teapot")).toBe('unknown');
    expect(classifyMakeugcError(undefined, undefined)).toBe('unknown');
  });
});

// -------------------------------------------------------------------
// Transient error patterns
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: isMakeugcTransientError — auto-retry gate', () => {
  it('exports the operator-spec pattern list', () => {
    expect(MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS.length).toBeGreaterThanOrEqual(8);
    expect(MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS).toContain('timeout');
    expect(MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS).toContain('502');
    expect(MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS).toContain('rate limit');
    expect(MAKEUGC_TRANSIENT_ERROR_MESSAGE_PATTERNS).toContain('temporarily');
  });
  it('matches case-insensitive transient patterns', () => {
    expect(isMakeugcTransientError('HTTP 502 Bad Gateway')).toBe(true);
    expect(isMakeugcTransientError('HTTP 503 Service Unavailable')).toBe(true);
    expect(isMakeugcTransientError('HTTP 504 Gateway Timeout')).toBe(true);
    expect(isMakeugcTransientError('Request Timeout')).toBe(true);
    expect(isMakeugcTransientError('please try again later')).toBe(true);
    expect(isMakeugcTransientError('Rate Limit Exceeded')).toBe(true);
    expect(isMakeugcTransientError('Internal Server Error')).toBe(true);
    expect(isMakeugcTransientError('Service Temporarily Unavailable')).toBe(true);
  });
  it('does NOT match terminal auth/validation errors', () => {
    expect(isMakeugcTransientError('Invalid API key')).toBe(false);
    expect(isMakeugcTransientError('Insufficient credits')).toBe(false);
    expect(isMakeugcTransientError('avatar_not_found')).toBe(false);
    expect(isMakeugcTransientError('voice_script too long')).toBe(false);
  });
  it('rejects non-string / empty / null / undefined', () => {
    expect(isMakeugcTransientError('')).toBe(false);
    expect(isMakeugcTransientError(null)).toBe(false);
    expect(isMakeugcTransientError(undefined)).toBe(false);
    expect(isMakeugcTransientError(42)).toBe(false);
    expect(isMakeugcTransientError({ msg: 'timeout' })).toBe(false);
  });
});

// -------------------------------------------------------------------
// Script length validator
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: assertMakeugcScriptLength + Zod refine', () => {
  it('constant anchor: MAKEUGC_VOICE_SCRIPT_MAX_CHARS = 1500', () => {
    expect(MAKEUGC_VOICE_SCRIPT_MAX_CHARS).toBe(1500);
  });
  it('accepts scripts <= 1500 chars, throws on > 1500', () => {
    expect(() => assertMakeugcScriptLength('x'.repeat(1500))).not.toThrow();
    expect(() => assertMakeugcScriptLength('x'.repeat(1501))).toThrow(MakeugcScriptTooLongError);
  });
  it('Zod schema rejects > 1500 char scripts at parse time', () => {
    expect(MakeugcVoiceScriptSchema.safeParse('x'.repeat(1500)).success).toBe(true);
    expect(MakeugcVoiceScriptSchema.safeParse('x'.repeat(1501)).success).toBe(false);
    expect(MakeugcVoiceScriptSchema.safeParse('').success).toBe(false); // min(1)
  });
});

// -------------------------------------------------------------------
// Persona matcher — hard-filter gender, NO silent random fallback
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: selectMakeugcAvatarForPersona — hard filter + NO silent fallback', () => {
  const mkAvatar = (id: string, gender: string, name = id): MakeugcAvatar => ({
    id,
    name,
    gender,
    thumbnail: `https://cdn/${id}.jpg`,
  });
  const mkVoice = (voiceId: string, gender: string, language = 'English'): MakeugcVoice => ({
    id: `row_${voiceId}`,
    name: voiceId,
    language,
    gender,
    voiceId,
  });

  it('returns valid match when gender + language candidate exists', () => {
    const persona = {
      gender: 'male' as const,
      age_range: '60s',
      ethnicity: 'white',
      look: 'gray hair',
    };
    const avatars = [mkAvatar('a1', 'Male', 'David gray hair'), mkAvatar('a2', 'Female', 'Linda')];
    const voices = [mkVoice('v_male', 'Male'), mkVoice('v_female', 'Female')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices);
    expect(match.avatar.id).toBe('a1');
    expect(match.voice.voiceId).toBe('v_male');
    expect(match.matchLog.hardFilters).toContain('gender=male');
    expect(match.matchLog.hardFilters).toContain('voice.gender=male');
    expect(match.matchLog.hardFilters).toContain('voice.language=English');
  });

  it('THROWS MakeugcNoMatchingAvatarError when NO gender candidate — no silent random fallback', () => {
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('a1', 'Female'), mkAvatar('a2', 'Female')];
    const voices = [mkVoice('v_female', 'Female')];
    expect(() => selectMakeugcAvatarForPersona(persona, avatars, voices)).toThrow(
      MakeugcNoMatchingAvatarError,
    );
  });

  it('THROWS when no gender-matching voice exists (voice hard filter)', () => {
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('a1', 'Male')];
    const voices = [mkVoice('v_female', 'Female')]; // no Male voice
    expect(() => selectMakeugcAvatarForPersona(persona, avatars, voices)).toThrow(
      MakeugcNoMatchingAvatarError,
    );
  });

  it('THROWS when no language-matching voice exists', () => {
    const persona = { gender: 'male' as const, age_range: '60s', language: 'Spanish' };
    const avatars = [mkAvatar('a1', 'Male')];
    const voices = [mkVoice('v_male_en', 'Male', 'English')]; // no Spanish
    expect(() => selectMakeugcAvatarForPersona(persona, avatars, voices)).toThrow(
      MakeugcNoMatchingAvatarError,
    );
  });

  it('excludes churned avatarId from second-best selection', () => {
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [
      mkAvatar('a1', 'Male', 'First choice'),
      mkAvatar('a2', 'Male', 'Second choice'),
    ];
    const voices = [mkVoice('v_male', 'Male')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices, {
      exclude: ['a1'],
    });
    expect(match.avatar.id).toBe('a2');
  });

  it('matchLog captures candidatesConsidered + hardFilters + winner', () => {
    const persona = { gender: 'male' as const, age_range: '60s', look: 'gray' };
    const avatars = [
      mkAvatar('a1', 'Male', 'Gray-hair David'),
      mkAvatar('a2', 'Male', 'Bald Bob'),
      mkAvatar('a3', 'Female', 'Linda'),
    ];
    const voices = [mkVoice('v_male', 'Male'), mkVoice('v_female', 'Female')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices);
    expect(match.matchLog.candidatesConsidered).toBe(3);
    expect(match.matchLog.hardFilters).toContain('gender=male');
    expect(match.matchLog.scoredCandidates.length).toBeGreaterThan(0);
    expect(match.matchLog.winnerAvatarId).toBe(match.avatar.id);
    // Polish-25 Commit 5: winnerVoiceId is the MakeUGC UUID (voice.id)
    // — NOT voice.voiceId (TTS engine identifier). Root cause fix for
    // job 9a9522c9 "Voice not found" submit failure.
    expect(match.matchLog.winnerVoiceId).toBe(match.voice.id);
    expect(match.matchLog.winnerVoiceId).not.toBe(match.voice.voiceId);
  });
});

describe('Polish-25 Commit 5: matcher returns voice.id (MakeUGC UUID) — NOT voice.voiceId (TTS)', () => {
  // Reproduces the exact shape from job 9a9522c9:
  //   - voice.id       = MakeUGC UUID   (e.g. row_makeugc_uuid_1)
  //   - voice.voiceId  = ElevenLabs opaque (e.g. dmeLYJsj2pZfEwysJhtw)
  //   - submit endpoint accepts .id, rejects .voiceId with "Voice not found"
  const mkAvatar = (id: string, gender: string): MakeugcAvatar => ({
    id,
    name: id,
    gender,
  });
  const mkVoiceBothIds = (
    makeugcUuid: string,
    ttsOpaque: string,
    gender: string,
  ): MakeugcVoice => ({
    id: makeugcUuid,
    name: makeugcUuid,
    gender,
    language: 'English',
    voiceId: ttsOpaque,
  });

  it('winnerVoiceId is voice.id (MakeUGC UUID)', () => {
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('avatar_uuid_1', 'Male')];
    const voices = [mkVoiceBothIds('makeugc_uuid_v1', 'dmeLYJsj2pZfEwysJhtw', 'Male')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices);
    expect(match.matchLog.winnerVoiceId).toBe('makeugc_uuid_v1');
    expect(match.matchLog.winnerVoiceId).not.toBe('dmeLYJsj2pZfEwysJhtw');
  });

  it('preserves both voice.id + voice.voiceId in the returned MakeugcVoice for audit', () => {
    const persona = { gender: 'female' as const, age_range: '30s' };
    const avatars = [mkAvatar('avatar_uuid_2', 'Female')];
    const voices = [mkVoiceBothIds('makeugc_uuid_v2', '21m00Tcm4TlvDq8ikWAM', 'Female')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices);
    // Both fields intact on the raw voice object — Commit 5 keeps
    // voice.voiceId reachable for SQL forensics without adding a
    // second lookup roundtrip.
    expect(match.voice.id).toBe('makeugc_uuid_v2');
    expect(match.voice.voiceId).toBe('21m00Tcm4TlvDq8ikWAM');
    // What downstream submit uses:
    expect(match.matchLog.winnerVoiceId).toBe(match.voice.id);
  });

  it('re-parsed job 9a9522c9 shape: submit-facing id must be UUID-shaped, not opaque TTS string', () => {
    // The literal voice.voiceId from the failing job.
    const jobFailureTtsId = 'dmeLYJsj2pZfEwysJhtw';
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('avatar_makeugc_uuid', 'Male')];
    const voices = [mkVoiceBothIds('voice_makeugc_uuid', jobFailureTtsId, 'Male')];
    const match = selectMakeugcAvatarForPersona(persona, avatars, voices);
    // Regression pin: winnerVoiceId MUST NOT be the ElevenLabs opaque
    // string. If a future refactor swaps `.id` back to `.voiceId`
    // (the Commit 1-4 bug), this test flips to red.
    expect(match.matchLog.winnerVoiceId).not.toBe(jobFailureTtsId);
    expect(match.matchLog.winnerVoiceId).toBe('voice_makeugc_uuid');
  });

  it('listMakeugcVoices raw parser preserves both id + voiceId fields separately', async () => {
    // Duplicates the endpoint parser sanity check to nail down that
    // Commit 5's fix depends on both fields surviving normalization.
    const raw = {
      id: 'row_1',
      name: 'Male US News',
      language: 'English',
      gender: 'Male',
      voiceId: 'dmeLYJsj2pZfEwysJhtw',
      accent: 'American',
      country: 'US',
      isCustom: false,
    };
    const parsed = normalizeMakeugcVoice(raw);
    expect(parsed.id).toBe('row_1');
    expect(parsed.voiceId).toBe('dmeLYJsj2pZfEwysJhtw');
    expect(parsed.id).not.toBe(parsed.voiceId);
  });
});

// -------------------------------------------------------------------
// Cost estimator
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: cost constants + estimator', () => {
  it('MAKEUGC_USD_PER_CREDIT_STARTER matches $99 / 2000 credits = $0.0495', () => {
    expect(MAKEUGC_USD_PER_CREDIT_STARTER).toBeCloseTo(0.0495, 4);
  });
  it('estimateMakeugcVideoCostUsd() defaults to starter tier ($0.0495)', () => {
    expect(estimateMakeugcVideoCostUsd()).toBeCloseTo(0.0495, 4);
    expect(estimateMakeugcVideoCostUsd('starter')).toBeCloseTo(0.0495, 4);
  });
  it('estimateMakeugcVideoCostUsd(pro) is cheaper per credit', () => {
    expect(estimateMakeugcVideoCostUsd('pro')).toBeLessThan(0.0495);
  });
});

// -------------------------------------------------------------------
// Daily cache TTL + invalidate
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: listMakeugc*Cached — TTL cache + invalidate', () => {
  it('avatar cache TTL constant = 6h', () => {
    expect(MAKEUGC_AVATAR_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
  it('voice cache TTL constant = 24h', () => {
    expect(MAKEUGC_VOICE_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
  it('second call within TTL returns cached avatars (single HTTP call)', async () => {
    __resetMakeugcCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ status: true, data: [{ id: 'a1', name: 'A', gender: 'Male' }] }),
      } as Response;
    }) as typeof globalThis.fetch;
    await listMakeugcAvatarsCached({ userId: 'u1', apiKey: 'k' });
    await listMakeugcAvatarsCached({ userId: 'u1', apiKey: 'k' });
    expect(fetchCount).toBe(1);
  });
  it('invalidateMakeugcAvatarCache forces refetch on next call', async () => {
    __resetMakeugcCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () => JSON.stringify({ status: true, data: [] }),
      } as Response;
    }) as typeof globalThis.fetch;
    await listMakeugcAvatarsCached({ userId: 'u2', apiKey: 'k' });
    invalidateMakeugcAvatarCache('u2');
    await listMakeugcAvatarsCached({ userId: 'u2', apiKey: 'k' });
    expect(fetchCount).toBe(2);
  });
  it('forceRefresh:true bypasses cache', async () => {
    __resetMakeugcCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () => JSON.stringify({ status: true, data: [] }),
      } as Response;
    }) as typeof globalThis.fetch;
    await listMakeugcAvatarsCached({ userId: 'u3', apiKey: 'k' });
    await listMakeugcAvatarsCached({ userId: 'u3', apiKey: 'k', forceRefresh: true });
    expect(fetchCount).toBe(2);
  });
  it('gender-filtered cache is isolated from unfiltered cache (different key)', async () => {
    __resetMakeugcCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () => JSON.stringify({ status: true, data: [] }),
      } as Response;
    }) as typeof globalThis.fetch;
    await listMakeugcAvatarsCached({ userId: 'u4', apiKey: 'k' });
    await listMakeugcAvatarsCached({ userId: 'u4', apiKey: 'k', gender: 'Male' });
    // Different cache keys — both should fetch.
    expect(fetchCount).toBe(2);
  });
});

// -------------------------------------------------------------------
// Metadata schema
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: Polish25AvatarMatchMetadataSchema Zod round-trip', () => {
  it('accepts a valid match metadata object', () => {
    const parsed = Polish25AvatarMatchMetadataSchema.safeParse({
      candidatesConsidered: 100,
      hardFilters: ['gender=male', 'voice.gender=male', 'voice.language=English'],
      scoredCandidates: [
        { avatarId: 'a1', score: 2 },
        { avatarId: 'a2', score: 1 },
      ],
      winnerAvatarId: 'a1',
      winnerVoiceId: 'v_male_us',
      winnerScore: 2,
    });
    expect(parsed.success).toBe(true);
  });
  it('rejects missing required fields', () => {
    const parsed = Polish25AvatarMatchMetadataSchema.safeParse({
      candidatesConsidered: 100,
      // missing everything else
    });
    expect(parsed.success).toBe(false);
  });
  it('Polish25CreditsUsedMetadataSchema pins credits + tier + at', () => {
    const parsed = Polish25CreditsUsedMetadataSchema.safeParse({
      creditsUsed: 1,
      costUsd: 0.0495,
      tier: 'starter',
      at: '2026-07-20T12:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    // Rejects invalid tier
    expect(
      Polish25CreditsUsedMetadataSchema.safeParse({
        creditsUsed: 1,
        costUsd: 0.05,
        tier: 'enterprise',
        at: '2026-07-20T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

// -------------------------------------------------------------------
// Provider adapter (MakeugcProvider)
// -------------------------------------------------------------------

describe('Polish-25 Commit 1: MakeugcProvider.verifyKey', () => {
  it('happy path — 200 on GET /video/avatars?gender=Male → ok:true', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response) as typeof globalThis.fetch;
    const p = new MakeugcProvider();
    const r = await p.verifyKey('valid_key');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('api');
  });
  it('auth failure — 401 → ok:false with re-paste guidance', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response) as typeof globalThis.fetch;
    const p = new MakeugcProvider();
    const r = await p.verifyKey('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/rejected this key/);
      expect(r.statusCode).toBe(401);
    }
  });
  it('403 also → auth failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as Response) as typeof globalThis.fetch;
    const p = new MakeugcProvider();
    const r = await p.verifyKey('bad');
    expect(r.ok).toBe(false);
  });
  it('generateVariants throws (Polish-25 Commit 2 wires the worker)', async () => {
    const p = new MakeugcProvider();
    await expect(
      p.generateVariants({
        userId: 'u',
        apiKey: 'k',
        concept: {} as unknown as never,
      } as unknown as never),
    ).rejects.toThrow(/Polish-25 Commit 2/);
  });
});
