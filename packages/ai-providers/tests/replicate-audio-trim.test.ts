/**
 * Polish-9.18: Replicate audio-trim helpers — env-driven enable/
 * disable, versioned vs unversioned endpoint dispatch, shotgun input
 * field shape, status translation.
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

describe('Polish-9.18: isAudioTrimEnabled', () => {
  it('returns false when env var unset', async () => {
    delete process.env.REPLICATE_AUDIO_TRIM_MODEL_ID;
    const { isAudioTrimEnabled } = await import('../src/replicate-audio-trim');
    expect(isAudioTrimEnabled()).toBe(false);
  });

  it('returns false when env var blank', async () => {
    process.env.REPLICATE_AUDIO_TRIM_MODEL_ID = '   ';
    const { isAudioTrimEnabled } = await import('../src/replicate-audio-trim');
    expect(isAudioTrimEnabled()).toBe(false);
  });

  it('returns true when env var set', async () => {
    process.env.REPLICATE_AUDIO_TRIM_MODEL_ID = 'owner/trim';
    const { isAudioTrimEnabled } = await import('../src/replicate-audio-trim');
    expect(isAudioTrimEnabled()).toBe(true);
  });
});

describe('Polish-9.18: submitAudioTrim', () => {
  it('returns ok=false with clear error when env var unset', async () => {
    delete process.env.REPLICATE_AUDIO_TRIM_MODEL_ID;
    const { submitAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await submitAudioTrim({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/a.mp4',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/REPLICATE_AUDIO_TRIM_MODEL_ID/);
  });

  it('unversioned "owner/name" → POSTs to /v1/models/{owner}/{name}/predictions with input only', async () => {
    process.env.REPLICATE_AUDIO_TRIM_MODEL_ID = 'owner/trim';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_trim' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await submitAudioTrim({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/a.mp4',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_trim');
    expect(observedUrl).toContain('/v1/models/owner/trim/predictions');
    expect(observedBody).not.toHaveProperty('version');
  });

  it('versioned "owner/name:HASH" → POSTs to /v1/predictions with {version, input}', async () => {
    process.env.REPLICATE_AUDIO_TRIM_MODEL_ID = 'cuuupid/cog-ffmpeg:abc123def';
    let observedUrl = '';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred_trim2' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await submitAudioTrim({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/a.mp4',
    });
    expect(r.ok).toBe(true);
    expect(observedUrl).toMatch(/\/v1\/predictions$/);
    expect(observedBody).toMatchObject({ version: 'abc123def' });
  });

  it('input body carries shotgun of video field names + ffmpeg command aliases', async () => {
    process.env.REPLICATE_AUDIO_TRIM_MODEL_ID = 'owner/trim';
    let observedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      observedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return new Response(JSON.stringify({ id: 'pred' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const { submitAudioTrim } = await import('../src/replicate-audio-trim');
    await submitAudioTrim({
      userId: 'u',
      apiKey: 'k',
      videoUrl: 'https://x/a.mp4',
    });
    expect(observedBody).toMatchObject({
      input: {
        video: 'https://x/a.mp4',
        video_url: 'https://x/a.mp4',
        video_file: 'https://x/a.mp4',
        input: 'https://x/a.mp4',
        input_video: 'https://x/a.mp4',
      },
    });
    expect(observedBody).not.toBeNull();
    const body = observedBody as unknown as { input: Record<string, string> };
    expect(body.input.command).toMatch(/silenceremove/);
    expect(body.input.args).toMatch(/silenceremove/);
    expect(body.input.ffmpeg_args).toMatch(/silenceremove/);
    expect(body.input.filter).toMatch(/silenceremove/);
  });
});

describe('Polish-9.18: checkAudioTrim', () => {
  it('translates succeeded → completed with videoUrl + costUsd', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r/trimmed.mp4' }),
          { status: 200 },
        ),
      ) as typeof globalThis.fetch;
    const { checkAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await checkAudioTrim({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r/trimmed.mp4');
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('handles array-shaped output', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'p', status: 'succeeded', output: ['https://r/trimmed.mp4'] }),
          { status: 200 },
        ),
      ) as typeof globalThis.fetch;
    const { checkAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await checkAudioTrim({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.videoUrl).toBe('https://r/trimmed.mp4');
  });

  it('translates failed → failed with errorMessage', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'p', status: 'failed', error: 'invalid filter' }), {
          status: 200,
        }),
      ) as typeof globalThis.fetch;
    const { checkAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await checkAudioTrim({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/invalid filter/);
  });

  it('translates processing → processing with cost 0', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'p', status: 'processing' }), { status: 200 }),
      ) as typeof globalThis.fetch;
    const { checkAudioTrim } = await import('../src/replicate-audio-trim');
    const r = await checkAudioTrim({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
  });
});
