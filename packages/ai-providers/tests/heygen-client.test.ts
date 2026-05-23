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
  pickHeyGenAvatar,
  submitHeyGenVideo,
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
  it('maps the four buckets', () => {
    expect(classifyHeyGenError(401, 'unauth')).toBe('auth');
    expect(classifyHeyGenError(403, 'forbidden')).toBe('auth');
    expect(classifyHeyGenError(402, 'no credits')).toBe('credits');
    expect(classifyHeyGenError(429, 'rate limited')).toBe('credits');
    expect(classifyHeyGenError(404, 'avatar not found')).toBe('avatar_missing');
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

  it('pickHeyGenAvatar refuses premium avatar when user tier is free', () => {
    const pool = [
      { avatar_id: 'a', avatar_name: 'female premium', gender: 'female', tier: 'premium' as const },
      { avatar_id: 'b', avatar_name: 'male free', gender: 'male', tier: 'free' as const },
    ];
    // persona is female — would normally pick 'a', but free tier blocks it.
    const picked = pickHeyGenAvatar(pool, { gender: 'female' }, 'free');
    expect(picked).toBeNull(); // no free female avatars in pool
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
