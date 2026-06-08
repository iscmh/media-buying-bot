/**
 * Polish-11: Replicate lipsync client — env enable/disable, versioned
 * vs unversioned endpoint dispatch, shotgun input field shape, status
 * translation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;
const realEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...realEnv };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = realEnv;
  vi.clearAllMocks();
});

describe('Polish-11: isLipsyncEnabled', () => {
  it('returns false when env var unset', async () => {
    delete process.env.REPLICATE_LIPSYNC_MODEL_ID;
    const { isLipsyncEnabled } = await import('../src/replicate-lipsync');
    expect(isLipsyncEnabled()).toBe(false);
  });

  it('returns true when env var set', async () => {
    process.env.REPLICATE_LIPSYNC_MODEL_ID = 'owner/lipsync';
    const { isLipsyncEnabled } = await import('../src/replicate-lipsync');
    expect(isLipsyncEnabled()).toBe(true);
  });
});

describe('Polish-11: submitLipsync', () => {
  it('returns ok=false with clear error when env var unset', async () => {
    delete process.env.REPLICATE_LIPSYNC_MODEL_ID;
    const { submitLipsync } = await import('../src/replicate-lipsync');
    const r = await submitLipsync({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/v.mp4',
      audioUrl: 'https://x/a.mp3',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/REPLICATE_LIPSYNC_MODEL_ID/);
  });

  it('unversioned "owner/name" → POSTs to /v1/models/{owner}/{name}/predictions', async () => {
    process.env.REPLICATE_LIPSYNC_MODEL_ID = 'owner/lipsync';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_lip' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitLipsync } = await import('../src/replicate-lipsync');
    const r = await submitLipsync({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/v.mp4',
      audioUrl: 'https://x/a.mp3',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_lip');
    expect(observedUrl).toContain('/v1/models/owner/lipsync/predictions');
    expect(observedBody).not.toHaveProperty('version');
  });

  it('versioned "owner/name:HASH" → POSTs to /v1/predictions with {version, input}', async () => {
    process.env.REPLICATE_LIPSYNC_MODEL_ID = 'sync/sync:abc123';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_lip2' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitLipsync } = await import('../src/replicate-lipsync');
    await submitLipsync({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/v.mp4',
      audioUrl: 'https://x/a.mp3',
    });
    expect(observedUrl).toMatch(/\/v1\/predictions$/);
    expect(observedBody).toMatchObject({ version: 'abc123' });
  });

  it('input body shotguns video + audio field aliases', async () => {
    process.env.REPLICATE_LIPSYNC_MODEL_ID = 'owner/lipsync';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitLipsync } = await import('../src/replicate-lipsync');
    await submitLipsync({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/v.mp4',
      audioUrl: 'https://x/a.mp3',
    });
    expect(observedBody).toMatchObject({
      input: {
        video: 'https://x/v.mp4',
        video_url: 'https://x/v.mp4',
        video_file: 'https://x/v.mp4',
        face: 'https://x/v.mp4',
        face_video: 'https://x/v.mp4',
        audio: 'https://x/a.mp3',
        audio_url: 'https://x/a.mp3',
        audio_file: 'https://x/a.mp3',
        speech: 'https://x/a.mp3',
      },
    });
  });
});

describe('Polish-11: checkLipsync', () => {
  it('succeeded → completed with videoUrl + costUsd > 0', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r/lipsynced.mp4' }),
          { status: 200 },
        ),
      ) as typeof globalThis.fetch;
    const { checkLipsync } = await import('../src/replicate-lipsync');
    const r = await checkLipsync({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r/lipsynced.mp4');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('array-shaped output is handled', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'p', status: 'succeeded', output: ['https://r/lipsynced.mp4'] }),
          { status: 200 },
        ),
      ) as typeof globalThis.fetch;
    const { checkLipsync } = await import('../src/replicate-lipsync');
    const r = await checkLipsync({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.videoUrl).toBe('https://r/lipsynced.mp4');
  });

  it('failed → failed with errorMessage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'p', status: 'failed', error: 'bad audio' }), {
        status: 200,
      }),
    ) as typeof globalThis.fetch;
    const { checkLipsync } = await import('../src/replicate-lipsync');
    const r = await checkLipsync({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/bad audio/);
  });

  it('processing → processing with 0 cost', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'p', status: 'processing' }), { status: 200 }),
      ) as typeof globalThis.fetch;
    const { checkLipsync } = await import('../src/replicate-lipsync');
    const r = await checkLipsync({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
  });
});
