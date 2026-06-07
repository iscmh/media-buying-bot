/**
 * Polish-9.12: Replicate ffmpeg-concat helpers — submit + check +
 * env-driven enable/disable.
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

describe('Polish-9.12: isVideoConcatEnabled', () => {
  it('returns false when env var is unset', async () => {
    delete process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID;
    const { isVideoConcatEnabled } = await import('../src/replicate-concat');
    expect(isVideoConcatEnabled()).toBe(false);
  });

  it('returns false when env var is empty', async () => {
    process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID = '   ';
    const { isVideoConcatEnabled } = await import('../src/replicate-concat');
    expect(isVideoConcatEnabled()).toBe(false);
  });

  it('returns true when env var is set', async () => {
    process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID = 'owner/concat-model';
    const { isVideoConcatEnabled } = await import('../src/replicate-concat');
    expect(isVideoConcatEnabled()).toBe(true);
  });
});

describe('Polish-9.12: submitReplicateConcat', () => {
  it('returns ok=false with clear error when env var unset', async () => {
    delete process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID;
    const { submitReplicateConcat } = await import('../src/replicate-concat');
    const r = await submitReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      videoUrls: ['https://x/a.mp4', 'https://x/b.mp4'],
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/REPLICATE_VIDEO_CONCAT_MODEL_ID/);
  });

  it('POSTs to Replicate with videos + video_urls + clips fields', async () => {
    process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID = 'owner/concat';
    let observedBody: unknown;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/v1/models/owner/concat/predictions');
      observedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ id: 'pred_abc' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitReplicateConcat } = await import('../src/replicate-concat');
    const r = await submitReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      videoUrls: ['https://x/a.mp4', 'https://x/b.mp4', 'https://x/c.mp4'],
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_abc');
    expect(observedBody).toMatchObject({
      input: {
        videos: ['https://x/a.mp4', 'https://x/b.mp4', 'https://x/c.mp4'],
        video_urls: ['https://x/a.mp4', 'https://x/b.mp4', 'https://x/c.mp4'],
        clips: ['https://x/a.mp4', 'https://x/b.mp4', 'https://x/c.mp4'],
      },
    });
  });

  it('returns ok=false when Replicate response omits id', async () => {
    process.env.REPLICATE_VIDEO_CONCAT_MODEL_ID = 'owner/concat';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 201 })) as typeof globalThis.fetch;
    const { submitReplicateConcat } = await import('../src/replicate-concat');
    const r = await submitReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      videoUrls: ['https://x/a.mp4', 'https://x/b.mp4'],
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing prediction id/i);
  });
});

describe('Polish-9.12: checkReplicateConcat', () => {
  it('translates Replicate succeeded → completed with videoUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'pred',
          status: 'succeeded',
          output: 'https://r/final.mp4',
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;
    const { checkReplicateConcat } = await import('../src/replicate-concat');
    const r = await checkReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred',
    });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r/final.mp4');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('handles array-shaped output (Replicate convention)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'pred',
          status: 'succeeded',
          output: ['https://r/final.mp4'],
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;
    const { checkReplicateConcat } = await import('../src/replicate-concat');
    const r = await checkReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred',
    });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r/final.mp4');
  });

  it('translates Replicate failed → failed with errorMessage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'pred',
          status: 'failed',
          error: 'Bad input',
        }),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;
    const { checkReplicateConcat } = await import('../src/replicate-concat');
    const r = await checkReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred',
    });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/Bad input/);
  });

  it('translates Replicate processing → processing with costUsd=0', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'pred', status: 'processing' }), { status: 200 }),
      ) as typeof globalThis.fetch;
    const { checkReplicateConcat } = await import('../src/replicate-concat');
    const r = await checkReplicateConcat({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred',
    });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
  });
});
