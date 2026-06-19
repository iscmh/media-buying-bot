/**
 * Polish-12.5: Replicate frame-extract helpers — submit + check +
 * env-driven enable/disable. Mirrors the replicate-concat coverage
 * shape because the API surface is identical (Replicate predictions).
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

describe('Polish-12.5: isFrameExtractEnabled', () => {
  it('returns false when env var is unset', async () => {
    delete process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID;
    const { isFrameExtractEnabled } = await import('../src/replicate-frame-extract');
    expect(isFrameExtractEnabled()).toBe(false);
  });

  it('returns false when env var is whitespace-only', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = '   ';
    const { isFrameExtractEnabled } = await import('../src/replicate-frame-extract');
    expect(isFrameExtractEnabled()).toBe(false);
  });

  it('returns true when env var is set', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    const { isFrameExtractEnabled } = await import('../src/replicate-frame-extract');
    expect(isFrameExtractEnabled()).toBe(true);
  });
});

describe('Polish-12.5: submitReplicateFrameExtract', () => {
  it('returns ok=false with clear error when env var unset', async () => {
    delete process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID;
    const { submitReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await submitReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/seg.mp4',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/REPLICATE_FRAME_EXTRACT_MODEL_ID/);
  });

  it('unversioned "owner/name" → POSTs to /v1/models/{owner}/{name}/predictions with input only', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_extract_abc' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await submitReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/seg.mp4',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_extract_abc');
    expect(observedUrl).toContain('/v1/models/owner/ffmpeg-util/predictions');
    expect(observedBody).not.toHaveProperty('version');
    expect(observedBody).toMatchObject({
      input: {
        video: 'https://x/seg.mp4',
        video_url: 'https://x/seg.mp4',
        input_video: 'https://x/seg.mp4',
        file: 'https://x/seg.mp4',
      },
    });
  });

  it('versioned "owner/name:VERSION" → POSTs to /v1/predictions with {version, input}', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util:abc123';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_v_abc' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    await submitReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/seg.mp4',
    });
    expect(observedUrl).toContain('/v1/predictions');
    expect(observedUrl).not.toContain('/models/');
    expect(observedBody).toMatchObject({ version: 'abc123' });
  });

  it('returns ok=false when response omits prediction id', async () => {
    process.env.REPLICATE_FRAME_EXTRACT_MODEL_ID = 'owner/ffmpeg-util';
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({}), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await submitReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/seg.mp4',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing prediction id/i);
  });
});

describe('Polish-12.5: checkReplicateFrameExtract', () => {
  it('status=succeeded with string output → completed + frameUrl + costUsd', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({ status: 'succeeded', output: 'https://replicate/frame.jpg' }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const { checkReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await checkReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred_abc',
    });
    expect(r.status).toBe('completed');
    expect(r.frameUrl).toBe('https://replicate/frame.jpg');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('status=succeeded with array output → takes [0]', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: 'succeeded',
          output: ['https://replicate/frame-a.jpg', 'https://replicate/frame-b.jpg'],
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const { checkReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await checkReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred_abc',
    });
    expect(r.frameUrl).toBe('https://replicate/frame-a.jpg');
  });

  it('status=failed → failed with errorMessage', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ status: 'failed', error: 'codec unsupported' }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    const { checkReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await checkReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred_abc',
    });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/codec unsupported/);
    expect(r.costUsd).toBe(0);
  });

  it('status=starting / processing → processing, no cost', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ status: 'starting' }), { status: 200 });
    }) as typeof globalThis.fetch;
    const { checkReplicateFrameExtract } = await import('../src/replicate-frame-extract');
    const r = await checkReplicateFrameExtract({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'pred_abc',
    });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
    expect(r.frameUrl).toBeUndefined();
  });
});
