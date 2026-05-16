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
  listHeyGenAvatars,
  listHeyGenVoices,
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
