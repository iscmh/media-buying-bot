/**
 * Phase 3f: HeyGen Avatar Mode client tests.
 *
 * Coverage: listHeyGenAvatars (success + 401 propagates httpStatus),
 * listHeyGenVoices (success path), submitHeyGenVideo (body shape +
 * propagates 402 credits error), checkHeyGenVideoStatus (status
 * normalization), classifyHeyGenError (auth/credits/avatar/server),
 * HeyGenAvatarNotConfiguredError (thrown with helpful message).
 *
 * Mocks: global fetch + @mbb/db audit log helper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  HeyGenAvatarNotConfiguredError,
  checkHeyGenVideoStatus,
  classifyHeyGenError,
  detectHeyGenTier,
  filterAvatarsByTier,
  listHeyGenAvatars,
  listHeyGenVoices,
  normalizeHeyGenAvatar,
  // pickHeYGenAvatar deleted in Polish-24 Commit 1 — replaced by
  // selectHeygenAvatarForPersona with hard-filter gender + no
  // silent random fallback (see the Polish-24 describe blocks below).
  submitHeyGenVideo,
  type HeyGenAvatar,
  type HeyGenVoice,
} from '../src/heygen-client';

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

function captureFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { video_id: 'vid_xyz' } }),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('listHeyGenAvatars', () => {
  it('returns avatars on 200', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        data: {
          avatars: [
            { avatar_id: 'a1', avatar_name: 'Daisy', gender: 'female' },
            { avatar_id: 'a2', avatar_name: 'Tom', gender: 'male' },
          ],
        },
      },
    });
    const r = await listHeyGenAvatars({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.avatars).toHaveLength(2);
    expect(r.avatars[0]!.avatar_id).toBe('a1');
    expect(r.httpStatus).toBe(200);
  });

  it('propagates httpStatus on 401', async () => {
    mockFetchOnce({ status: 401, body: { message: 'invalid api key' } });
    const r = await listHeyGenAvatars({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(401);
    expect(r.errorMessage).toMatch(/invalid api key/i);
  });
});

describe('listHeyGenVoices', () => {
  it('returns voices on 200', async () => {
    mockFetchOnce({
      status: 200,
      body: { data: { voices: [{ voice_id: 'v1', name: 'Friendly Female', gender: 'female' }] } },
    });
    const r = await listHeyGenVoices({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.voices).toHaveLength(1);
    expect(r.voices[0]!.voice_id).toBe('v1');
  });
});

describe('submitHeyGenVideo', () => {
  it('posts the avatar+text body and returns video_id', async () => {
    const calls = captureFetch();
    const r = await submitHeyGenVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'Daisy-inskirt-20220818',
      script: 'Hey, I tried this for 30 days...',
      voiceId: 'voice_1',
    });
    expect(r.ok).toBe(true);
    expect(r.videoId).toBe('vid_xyz');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v2\/video\/generate$/);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.video_inputs[0].character.avatar_id).toBe('Daisy-inskirt-20220818');
    expect(body.video_inputs[0].voice.input_text).toBe('Hey, I tried this for 30 days...');
    expect(body.video_inputs[0].voice.voice_id).toBe('voice_1');
    expect(body.dimension).toEqual({ width: 720, height: 1280 });
  });

  it('propagates 402 credits error with httpStatus', async () => {
    mockFetchOnce({ status: 402, body: { message: 'insufficient credits' } });
    const r = await submitHeyGenVideo({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a1',
      script: 'hi',
    });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(402);
    expect(classifyHeyGenError(r.httpStatus, r.errorMessage)).toBe('credits');
  });
});

describe('checkHeyGenVideoStatus', () => {
  it('normalizes completed status + computes cost', async () => {
    mockFetchOnce({
      status: 200,
      body: { data: { status: 'completed', video_url: 'https://cdn.heygen.com/v.mp4' } },
    });
    const r = await checkHeyGenVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://cdn.heygen.com/v.mp4');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('treats unknown status strings as processing (safer)', async () => {
    mockFetchOnce({ status: 200, body: { data: { status: 'waiting_in_queue' } } });
    const r = await checkHeyGenVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('processing');
  });

  it('maps failed status + surfaces error message', async () => {
    mockFetchOnce({
      status: 200,
      body: { data: { status: 'failed', error: { message: 'avatar broken' } } },
    });
    const r = await checkHeyGenVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toBe('avatar broken');
    expect(r.costUsd).toBe(0);
  });
});

describe('classifyHeyGenError', () => {
  it('maps the six-plus buckets (Commit 1: 429 split → rate_limit, avatar_not_found → avatar_churned)', () => {
    expect(classifyHeyGenError(401, 'unauth')).toBe('auth');
    expect(classifyHeyGenError(403, 'forbidden')).toBe('auth');
    expect(classifyHeyGenError(402, 'no credits')).toBe('credits');
    // Polish-24 Commit 1: 429 is now 'rate_limit' (was folded into
    // 'credits'). Auto-retry via isHeygenTransientError, don't
    // surface as "out of credits".
    expect(classifyHeyGenError(429, 'rate limited')).toBe('rate_limit');
    // Polish-24 Commit 1: 404 + avatar_not_found (or photar_not_found)
    // maps to 'avatar_churned' — HeyGen retires public avatars
    // silently; caller invalidates cache + retries with second-best.
    // The bare 'avatar not found' (with space) matches the churn
    // regex too — this is intentional: our worker treats both as
    // churn-class since the recovery path (fresh fetch + retry) is
    // identical.
    expect(classifyHeyGenError(404, 'avatar_not_found')).toBe('avatar_churned');
    expect(classifyHeyGenError(404, 'avatar not found')).toBe('avatar_churned');
    // Non-churn avatar 404 (older UGC path) still maps to avatar_missing.
    expect(classifyHeyGenError(404, 'avatar disabled')).toBe('avatar_missing');
    expect(classifyHeyGenError(500, 'oops')).toBe('server');
    expect(classifyHeyGenError(0, 'timeout exceeded')).toBe('timeout');
    expect(classifyHeyGenError(400, 'random validation')).toBe('unknown');
  });
});

describe('HeyGenAvatarNotConfiguredError', () => {
  it('carries a settings-pointer message by default', () => {
    const err = new HeyGenAvatarNotConfiguredError();
    expect(err.name).toBe('HeyGenAvatarNotConfiguredError');
    expect(err.message).toMatch(/\/settings/);
  });
});

describe('Polish-4: HeyGen tier detection', () => {
  it('normalizes premium=true into tier=premium', () => {
    const a = normalizeHeyGenAvatar({ avatar_id: 'p1', avatar_name: 'Lux', premium: true });
    expect(a.tier).toBe('premium');
  });

  it('normalizes is_premium=true as a fallback marker', () => {
    const a = normalizeHeyGenAvatar({ avatar_id: 'p2', avatar_name: 'X', is_premium: true });
    expect(a.tier).toBe('premium');
  });

  it("normalizes tier='premium' string fallback", () => {
    const a = normalizeHeyGenAvatar({ avatar_id: 'p3', avatar_name: 'Y', tier: 'premium' });
    expect(a.tier).toBe('premium');
  });

  it('defaults to free when no marker present', () => {
    const a = normalizeHeyGenAvatar({ avatar_id: 'p4', avatar_name: 'Z' });
    expect(a.tier).toBe('free');
  });

  it('detectHeyGenTier returns premium when any premium avatar visible', () => {
    expect(
      detectHeyGenTier([
        { avatar_id: 'a', avatar_name: 'A', tier: 'free' },
        { avatar_id: 'b', avatar_name: 'B', tier: 'premium' },
      ]),
    ).toBe('premium');
  });

  it('detectHeyGenTier returns free when no premium/pro avatars visible', () => {
    expect(
      detectHeyGenTier([
        { avatar_id: 'a', avatar_name: 'A', tier: 'free' },
        { avatar_id: 'b', avatar_name: 'B', tier: 'free' },
      ]),
    ).toBe('free');
  });

  it('detectHeyGenTier returns free when avatar list is empty', () => {
    expect(detectHeyGenTier([])).toBe('free');
  });

  it('filterAvatarsByTier drops premium avatars when user is free', () => {
    const out = filterAvatarsByTier(
      [
        { avatar_id: 'a', avatar_name: 'F', tier: 'free' },
        { avatar_id: 'b', avatar_name: 'P', tier: 'premium' },
      ],
      'free',
    );
    expect(out.map((a) => a.avatar_id)).toEqual(['a']);
  });

  it('filterAvatarsByTier returns everything when user is premium', () => {
    const out = filterAvatarsByTier(
      [
        { avatar_id: 'a', avatar_name: 'F', tier: 'free' },
        { avatar_id: 'b', avatar_name: 'P', tier: 'premium' },
      ],
      'premium',
    );
    expect(out).toHaveLength(2);
  });

  it('listHeyGenAvatars surfaces detected tier on the result', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        data: {
          avatars: [
            { avatar_id: 'p1', avatar_name: 'Free One', premium: false },
            { avatar_id: 'p2', avatar_name: 'Premium One', premium: true },
          ],
        },
      },
    });
    const r = await listHeyGenAvatars({ userId: 'u', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('premium');
    expect(r.avatars[1]!.tier).toBe('premium');
  });
});

// =========================================================================
// Polish-24 Commit 1 pins — HeyGen pivot client-only additions
// =========================================================================
describe('Polish-24 Commit 1: cost constants + estimator (verified 2026 pricing)', () => {
  it('cost constants match the operator-verified 2026 API pricing', async () => {
    const {
      HEYGEN_AVATAR_III_USD_PER_SEC,
      HEYGEN_AVATAR_IV_1080P_USD_PER_SEC,
      HEYGEN_AVATAR_IV_4K_USD_PER_SEC,
    } = await import('../src/heygen-client');
    expect(HEYGEN_AVATAR_III_USD_PER_SEC).toBeCloseTo(1 / 60, 4); // $1/min
    expect(HEYGEN_AVATAR_IV_1080P_USD_PER_SEC).toBeCloseTo(4 / 60, 4); // $4/min
    expect(HEYGEN_AVATAR_IV_4K_USD_PER_SEC).toBeCloseTo(5 / 60, 4); // $5/min
  });

  it('estimateHeygenClipCostUsd(60, avatar_iii) ≈ $1.00', async () => {
    const { estimateHeygenClipCostUsd } = await import('../src/heygen-client');
    expect(estimateHeygenClipCostUsd(60, 'avatar_iii')).toBeCloseTo(1.0, 2);
  });

  it('estimateHeygenClipCostUsd(60, avatar_iv_1080p) ≈ $4.00', async () => {
    const { estimateHeygenClipCostUsd } = await import('../src/heygen-client');
    expect(estimateHeygenClipCostUsd(60, 'avatar_iv_1080p')).toBeCloseTo(4.0, 2);
  });

  it('estimateHeygenClipCostUsd(60, avatar_iv_4k) ≈ $5.00', async () => {
    const { estimateHeygenClipCostUsd } = await import('../src/heygen-client');
    expect(estimateHeygenClipCostUsd(60, 'avatar_iv_4k')).toBeCloseTo(5.0, 2);
  });

  it('non-positive seconds returns 0', async () => {
    const { estimateHeygenClipCostUsd } = await import('../src/heygen-client');
    expect(estimateHeygenClipCostUsd(0, 'avatar_iii')).toBe(0);
    expect(estimateHeygenClipCostUsd(-5, 'avatar_iii')).toBe(0);
    expect(estimateHeygenClipCostUsd(NaN, 'avatar_iii')).toBe(0);
  });
});

describe('Polish-24 Commit 1: isHeygenTransientError + HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS', () => {
  it('matches all operator-specified patterns case-insensitively', async () => {
    const { isHeygenTransientError, HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS } =
      await import('../src/heygen-client');
    expect(isHeygenTransientError('Rate limit exceeded')).toBe(true);
    expect(isHeygenTransientError('Too Many Requests')).toBe(true);
    expect(isHeygenTransientError('request timeout')).toBe(true);
    expect(isHeygenTransientError('Service temporarily unavailable')).toBe(true);
    expect(isHeygenTransientError('Internal Server Error')).toBe(true);
    expect(isHeygenTransientError('Bad Gateway')).toBe(true);
    expect(isHeygenTransientError('Gateway Timeout')).toBe(true);
    expect(isHeygenTransientError('please try again later')).toBe(true);
    expect(isHeygenTransientError('HTTP 502 Bad Gateway')).toBe(true);
    expect(isHeygenTransientError('HTTP 503')).toBe(true);
    expect(isHeygenTransientError('HTTP 504')).toBe(true);
    expect(isHeygenTransientError('40119 voice service temporarily unavailable')).toBe(true);
    expect(isHeygenTransientError('pending in queue')).toBe(true);
    // Ensure the exact list is exported (regression tripwire on the
    // operator-spec pattern count).
    expect(HEYGEN_TRANSIENT_ERROR_MESSAGE_PATTERNS.length).toBeGreaterThanOrEqual(13);
  });

  it('does NOT match terminal auth / validation / not-found errors', async () => {
    const { isHeygenTransientError } = await import('../src/heygen-client');
    expect(isHeygenTransientError('HeyGen rejected this key. Check it was copied.')).toBe(false);
    expect(isHeygenTransientError('avatar_not_found')).toBe(false);
    expect(isHeygenTransientError('voice_not_found')).toBe(false);
    expect(isHeygenTransientError('input_text too long')).toBe(false);
    expect(isHeygenTransientError('validation failed')).toBe(false);
  });

  it('rejects non-string / empty / null / undefined', async () => {
    const { isHeygenTransientError } = await import('../src/heygen-client');
    expect(isHeygenTransientError('')).toBe(false);
    expect(isHeygenTransientError(null)).toBe(false);
    expect(isHeygenTransientError(undefined)).toBe(false);
    expect(isHeygenTransientError(42)).toBe(false);
    expect(isHeygenTransientError({ msg: 'rate limit' })).toBe(false);
  });
});

describe('Polish-24 Commit 1: containsAvatarAppearanceWords — THE fix for the wrong-avatar bug', () => {
  it("rejects the operator's exact BAD example 'male, 60s, white, gray hair'", async () => {
    // Root cause per HeyGen's own skill guidance: when avatar_id is
    // set AND input_text describes appearance, HeyGen SUBSTITUTES a
    // different avatar. Polish-23 fed persona verbatim into per-clip
    // prompts → wrong-avatar bug. This pin ensures the fix stays.
    const { containsAvatarAppearanceWords } = await import('../src/heygen-client');
    expect(containsAvatarAppearanceWords('male, 60s, white, gray hair')).toBe(true);
  });

  it('matches individual appearance dimensions', async () => {
    const { containsAvatarAppearanceWords } = await import('../src/heygen-client');
    // Gender
    expect(containsAvatarAppearanceWords('a male presenter speaks')).toBe(true);
    expect(containsAvatarAppearanceWords('a female voice')).toBe(true);
    expect(containsAvatarAppearanceWords('the man says')).toBe(true);
    // Age
    expect(containsAvatarAppearanceWords('a 60-year-old')).toBe(true);
    expect(containsAvatarAppearanceWords('60s vibes')).toBe(true);
    expect(containsAvatarAppearanceWords('aged 45')).toBe(true);
    // Ethnicity
    expect(containsAvatarAppearanceWords('a white person')).toBe(true);
    expect(containsAvatarAppearanceWords('caucasian speaker')).toBe(true);
    expect(containsAvatarAppearanceWords('east-asian actor')).toBe(true);
    // Hair
    expect(containsAvatarAppearanceWords('salt-and-pepper hair')).toBe(true);
    expect(containsAvatarAppearanceWords('bald head')).toBe(true);
    expect(containsAvatarAppearanceWords('blonde character')).toBe(true);
    // Wardrobe
    expect(containsAvatarAppearanceWords('wearing a suit')).toBe(true);
    expect(containsAvatarAppearanceWords('a red shirt')).toBe(true);
  });

  it('does NOT reject action-only scripts (the GOOD shape)', async () => {
    const { containsAvatarAppearanceWords } = await import('../src/heygen-client');
    expect(
      containsAvatarAppearanceWords(
        'Okay so listen, I tried this app for two weeks and honestly the surprising part was how much I saved.',
      ),
    ).toBe(false);
    expect(
      containsAvatarAppearanceWords(
        'The selected presenter walks through the product, then holds up their phone.',
      ),
    ).toBe(false);
    expect(
      containsAvatarAppearanceWords(
        'Speaks calmly to camera, gestures with left hand, then smiles.',
      ),
    ).toBe(false);
  });

  it('assertNoAvatarAppearanceWordsInInputText throws on bad, no-op on good', async () => {
    const { assertNoAvatarAppearanceWordsInInputText } = await import('../src/heygen-client');
    expect(() => assertNoAvatarAppearanceWordsInInputText('male, 60s, white, gray hair')).toThrow(
      /appearance words/,
    );
    expect(() => assertNoAvatarAppearanceWordsInInputText('Speaks calmly to camera')).not.toThrow();
  });

  it('HeygenInputTextSchema Zod refine rejects appearance-word text', async () => {
    const { HeygenInputTextSchema } = await import('../src/heygen-client');
    expect(HeygenInputTextSchema.safeParse('male, 60s, white, gray hair').success).toBe(false);
    expect(HeygenInputTextSchema.safeParse('Speaks calmly to camera').success).toBe(true);
  });
});

describe('Polish-24 Commit 1: selectHeygenAvatarForPersona — hard-filter gender, NO silent fallback', () => {
  const mkAvatar = (id: string, gender: string, name = id, extra: Partial<HeyGenAvatar> = {}) =>
    ({
      avatar_id: id,
      avatar_name: name,
      gender,
      preview_image_url: `https://cdn/${id}.jpg`,
      ...extra,
    }) as HeyGenAvatar;

  const mkVoice = (voice_id: string, gender: string, language = 'en-US') =>
    ({ voice_id, name: voice_id, gender, language }) as HeyGenVoice;

  it('returns valid match when gender candidate exists', async () => {
    const { selectHeygenAvatarForPersona } = await import('../src/heygen-client');
    const persona = {
      gender: 'male' as const,
      age_range: '60s',
      ethnicity: 'white',
      look: 'gray hair',
    };
    const avatars = [mkAvatar('m1', 'male', 'David gray hair'), mkAvatar('f1', 'female', 'Linda')];
    const voices = [mkVoice('v_male', 'male'), mkVoice('v_female', 'female')];
    const match = selectHeygenAvatarForPersona(persona, avatars, voices);
    expect(match.avatar.avatar_id).toBe('m1');
    expect(match.voiceId).toBe('v_male');
    expect(match.matchLog.hardFilters).toContain('gender=male');
  });

  it('THROWS HeygenNoMatchingAvatarError when NO gender candidate — no silent fallback', async () => {
    const { selectHeygenAvatarForPersona, HeygenNoMatchingAvatarError } =
      await import('../src/heygen-client');
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('f1', 'female', 'Linda'), mkAvatar('f2', 'female', 'Sarah')];
    const voices = [mkVoice('v_female', 'female')];
    expect(() => selectHeygenAvatarForPersona(persona, avatars, voices)).toThrow(
      HeygenNoMatchingAvatarError,
    );
  });

  it('THROWS when no gender-matching voice exists (voice hard filter)', async () => {
    const { selectHeygenAvatarForPersona, HeygenNoMatchingAvatarError } =
      await import('../src/heygen-client');
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [mkAvatar('m1', 'male', 'David')];
    const voices = [mkVoice('v_female', 'female')]; // no male voice
    expect(() => selectHeygenAvatarForPersona(persona, avatars, voices)).toThrow(
      HeygenNoMatchingAvatarError,
    );
  });

  it('filters out candidates without preview_image_url (readiness gate)', async () => {
    const { selectHeygenAvatarForPersona, HeygenNoMatchingAvatarError } =
      await import('../src/heygen-client');
    const persona = { gender: 'male' as const, age_range: '60s' };
    // Only male avatar has no preview → should reject via readiness filter
    const avatars = [{ ...mkAvatar('m1', 'male'), preview_image_url: undefined } as HeyGenAvatar];
    const voices = [mkVoice('v_male', 'male')];
    expect(() => selectHeygenAvatarForPersona(persona, avatars, voices)).toThrow(
      HeygenNoMatchingAvatarError,
    );
  });

  it('excludes churned avatarId from second-best selection', async () => {
    const { selectHeygenAvatarForPersona } = await import('../src/heygen-client');
    const persona = { gender: 'male' as const, age_range: '60s' };
    const avatars = [
      mkAvatar('m1', 'male', 'First choice'),
      mkAvatar('m2', 'male', 'Second choice'),
    ];
    const voices = [mkVoice('v_male', 'male')];
    const match = selectHeygenAvatarForPersona(persona, avatars, voices, { exclude: ['m1'] });
    expect(match.avatar.avatar_id).toBe('m2');
  });

  it('matchLog captures candidatesConsidered + hardFilters + top scores', async () => {
    const { selectHeygenAvatarForPersona } = await import('../src/heygen-client');
    const persona = { gender: 'male' as const, age_range: '60s', look: 'gray' };
    const avatars = [
      mkAvatar('m1', 'male', 'Gray-hair David'),
      mkAvatar('m2', 'male', 'Bald Bob'),
      mkAvatar('f1', 'female', 'Linda'),
    ];
    const voices = [mkVoice('v_male', 'male'), mkVoice('v_female', 'female')];
    const match = selectHeygenAvatarForPersona(persona, avatars, voices);
    expect(match.matchLog.candidatesConsidered).toBe(3);
    expect(match.matchLog.hardFilters).toContain('gender=male');
    expect(match.matchLog.hardFilters).toContain('preview_image_url_present');
    expect(match.matchLog.scoredCandidates.length).toBeGreaterThan(0);
    expect(match.matchLog.winnerAvatarId).toBe(match.avatar.avatar_id);
  });
});

describe('Polish-24 Commit 1: classifyHeyGenError — extended for 429 / avatar_churned / 40119', () => {
  it('429 → rate_limit (transient, not folded into credits)', async () => {
    const { classifyHeyGenError } = await import('../src/heygen-client');
    expect(classifyHeyGenError(429, 'rate limit exceeded')).toBe('rate_limit');
  });

  it('402 → credits (still terminal)', async () => {
    const { classifyHeyGenError } = await import('../src/heygen-client');
    expect(classifyHeyGenError(402, 'out of credits')).toBe('credits');
  });

  it('404 + avatar_not_found → avatar_churned', async () => {
    const { classifyHeyGenError } = await import('../src/heygen-client');
    expect(classifyHeyGenError(404, 'avatar_not_found')).toBe('avatar_churned');
    expect(classifyHeyGenError(404, 'photar_not_found')).toBe('avatar_churned');
  });

  it('40119 in message → server (transient via server bucket)', async () => {
    const { classifyHeyGenError } = await import('../src/heygen-client');
    expect(classifyHeyGenError(200, 'error 40119: voice service temporarily unavailable')).toBe(
      'server',
    );
  });
});

describe('Polish-24 Commit 1: checkHeyGenVideoStatus — pending/waiting explicit + loud-log', () => {
  it("normalizes 'pending' → 'processing'", async () => {
    mockFetchOnce({ status: 200, body: { data: { status: 'pending', video_url: null } } });
    const r = await checkHeyGenVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v1' });
    expect(r.status).toBe('processing');
  });

  it("normalizes 'waiting' → 'processing'", async () => {
    mockFetchOnce({ status: 200, body: { data: { status: 'waiting', video_url: null } } });
    const r = await checkHeyGenVideoStatus({ userId: 'u', apiKey: 'k', videoId: 'v2' });
    expect(r.status).toBe('processing');
  });
});

describe('Polish-24 Commit 1: listHeygen*Cached — TTL cache + invalidate', () => {
  it('avatar cache TTL constant = 6h', async () => {
    const { HEYGEN_AVATAR_CACHE_TTL_MS } = await import('../src/heygen-client');
    expect(HEYGEN_AVATAR_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('voice cache TTL constant = 24h', async () => {
    const { HEYGEN_VOICE_CACHE_TTL_MS } = await import('../src/heygen-client');
    expect(HEYGEN_VOICE_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('second call within TTL returns cached avatars (single HTTP call)', async () => {
    const { listHeygenAvatarsCached, __resetHeygenCachesForTests } =
      await import('../src/heygen-client');
    __resetHeygenCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ data: { avatars: [{ avatar_id: 'a1', avatar_name: 'A' }] } }),
      } as Response;
    }) as typeof globalThis.fetch;

    const r1 = await listHeygenAvatarsCached({ userId: 'u1', apiKey: 'k' });
    const r2 = await listHeygenAvatarsCached({ userId: 'u1', apiKey: 'k' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchCount).toBe(1); // second call hit cache
  });

  it('invalidateHeygenAvatarCache forces refetch on next call', async () => {
    const { listHeygenAvatarsCached, invalidateHeygenAvatarCache, __resetHeygenCachesForTests } =
      await import('../src/heygen-client');
    __resetHeygenCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ data: { avatars: [{ avatar_id: 'a1', avatar_name: 'A' }] } }),
      } as Response;
    }) as typeof globalThis.fetch;

    await listHeygenAvatarsCached({ userId: 'u2', apiKey: 'k' });
    invalidateHeygenAvatarCache('u2');
    await listHeygenAvatarsCached({ userId: 'u2', apiKey: 'k' });
    expect(fetchCount).toBe(2);
  });

  it('forceRefresh:true bypasses cache', async () => {
    const { listHeygenAvatarsCached, __resetHeygenCachesForTests } =
      await import('../src/heygen-client');
    __resetHeygenCachesForTests();
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ data: { avatars: [{ avatar_id: 'a1', avatar_name: 'A' }] } }),
      } as Response;
    }) as typeof globalThis.fetch;

    await listHeygenAvatarsCached({ userId: 'u3', apiKey: 'k' });
    await listHeygenAvatarsCached({ userId: 'u3', apiKey: 'k', forceRefresh: true });
    expect(fetchCount).toBe(2);
  });
});

describe('Polish-24 Commit 1: submitHeygenPolish24Video — sanitizer + required voiceId + tuple log', () => {
  it('THROWS when input_text contains appearance words (BEFORE any HTTP call)', async () => {
    const { submitHeygenPolish24Video } = await import('../src/heygen-client');
    let fetchCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCalled = true;
      return { status: 200, text: async () => '{}' } as Response;
    }) as typeof globalThis.fetch;
    await expect(
      submitHeygenPolish24Video({
        userId: 'u',
        apiKey: 'k',
        avatarId: 'a',
        voiceId: 'v',
        script: 'male, 60s, white, gray hair speaks calmly',
      }),
    ).rejects.toThrow(/appearance words/);
    expect(fetchCalled).toBe(false);
  });

  it('happy path: submits with tuple log + returns videoId', async () => {
    const { submitHeygenPolish24Video } = await import('../src/heygen-client');
    mockFetchOnce({ status: 200, body: { data: { video_id: 'vid-happy' } } });
    const r = await submitHeygenPolish24Video({
      userId: 'u',
      apiKey: 'k',
      avatarId: 'a-david',
      voiceId: 'v-male-us',
      script: 'Speaks calmly to camera about the product.',
    });
    expect(r.ok).toBe(true);
    expect(r.videoId).toBe('vid-happy');
    expect(r.loggedTuple).toEqual({ avatarId: 'a-david', voiceId: 'v-male-us' });
  });
});

describe('Polish-24 Commit 1: Polish24AvatarMatchMetadataSchema — Zod round-trip', () => {
  it('accepts a valid match metadata object', async () => {
    const { Polish24AvatarMatchMetadataSchema } = await import('../src/heygen-client');
    const parsed = Polish24AvatarMatchMetadataSchema.safeParse({
      candidatesConsidered: 100,
      hardFilters: ['gender=male', 'preview_image_url_present'],
      scoredCandidates: [
        { avatarId: 'a1', score: 2 },
        { avatarId: 'a2', score: 1 },
      ],
      winnerAvatarId: 'a1',
      winnerVoiceId: 'v1',
      winnerScore: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing required fields', async () => {
    const { Polish24AvatarMatchMetadataSchema } = await import('../src/heygen-client');
    expect(
      Polish24AvatarMatchMetadataSchema.safeParse({
        candidatesConsidered: 100,
        // missing everything else
      }).success,
    ).toBe(false);
  });
});
