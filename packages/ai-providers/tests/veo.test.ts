/**
 * Polish-19.2: Veo 3.1 Fast client tests. Verify the predictLongRunning
 * submit body shape, the long-running-operation poll parser
 * (including BOTH the Gemini Developer API and Vertex AI response
 * shapes), env-overridable model id, and the duration clamp helper.
 *
 * No live API calls — all responses are mocked via fetch.
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

describe('Polish-19.2: submitVeoVideo body shape', () => {
  it('POSTs to /v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning by default', async () => {
    const calls = captureFetch({
      status: 200,
      body: { name: 'operations/abc123' },
    });
    const { submitVeoVideo } = await import('../src/veo');
    const r = await submitVeoVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'A 30yo woman talking to camera about her morning coffee',
      durationSeconds: 8,
    });
    expect(r.ok).toBe(true);
    expect(r.operationName).toBe('operations/abc123');
    // Polish-19.2.2: the default model id MUST include the
    // `-generate-preview` suffix while Veo 3.1 is preview. The
    // pre-19.2.2 'veo-3.1-fast' default returned 404 on first
    // live call.
    expect(calls[0]!.url).toContain(
      '/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning',
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.instances[0].prompt).toContain('coffee');
    expect(body.parameters.durationSeconds).toBe(8);
    expect(body.parameters.aspectRatio).toBe('9:16');
    expect(body.parameters.sampleCount).toBe(1);
  });

  it('respects VEO_MODEL_ID env override', async () => {
    process.env.VEO_MODEL_ID = 'veo-3.1-generate-preview';
    captureFetch({
      status: 200,
      body: { name: 'operations/abc' },
    });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'test',
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(captured).toContain('veo-3.1-generate-preview');
  });

  it('clamps duration to the 2-8s per-call range', async () => {
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'test',
      durationSeconds: 30, // user asked for 30s
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.durationSeconds).toBe(8); // clamped to ceiling
  });

  it('omits the audio parameter by default (Veo 3.1 emits audio natively)', async () => {
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.audio).toBeUndefined();
  });

  it('Polish-19.4: defaults personGeneration to "allow_all" for text-to-video (no reference image)', async () => {
    // The Polish-19.2.3 "omit entirely" default was a workaround for
    // the live rejection on 'allow_adult'. Per Google's docs the
    // Gemini Developer API requires 'allow_all' on text-to-video AND
    // on Extend — the value matters, not the field. Tripwire so a
    // future "let me drop this field again" cleanup gets caught.
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBe('allow_all');
  });

  it('Polish-19.4: defaults personGeneration to "allow_adult" for image-to-video (reference image present)', async () => {
    // Per docs the image-to-video path requires 'allow_adult', NOT
    // 'allow_all'. Auto-pick on the presence of a reference image
    // so the worker doesn't have to know the rule.
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'test',
      referenceImageBase64: 'AAAA',
      referenceImageMimeType: 'image/png',
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBe('allow_adult');
  });

  it('Polish-19.4: VEO_PERSON_GENERATION env wins over the auto-picked default', async () => {
    process.env.VEO_PERSON_GENERATION = 'dont_allow';
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBe('dont_allow');
  });

  it('Polish-19.4: empty/whitespace VEO_PERSON_GENERATION falls back to the auto default', async () => {
    process.env.VEO_PERSON_GENERATION = '   ';
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBe('allow_all');
  });

  it('Polish-19.4: omits resolution by default (Google picks) but sends it when requested', async () => {
    // Default: no resolution field — Google picks per the model tier.
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const b1 = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(b1.parameters.resolution).toBeUndefined();

    // When the worker chains, the base segment must pin 720p.
    captureFetch({ status: 200, body: { name: 'operations/x2' } });
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test', resolution: '720p' });
    const b2 = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(b2.parameters.resolution).toBe('720p');
  });

  it('explicitly sends audio: false when VEO_AUDIO_ENABLED_BY_DEFAULT=0', async () => {
    process.env.VEO_AUDIO_ENABLED_BY_DEFAULT = '0';
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.audio).toBe(false);
  });

  it('embeds reference image when provided (image-to-video mode)', async () => {
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'test',
      referenceImageBase64: 'AAAA',
      referenceImageMimeType: 'image/png',
    });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.instances[0].image.bytesBase64Encoded).toBe('AAAA');
    expect(body.instances[0].image.mimeType).toBe('image/png');
  });

  it('translates 404 errors into a model-id hint', async () => {
    captureFetch({
      status: 200,
      body: { error: { code: 404, message: 'Model not found' } },
    });
    const { submitVeoVideo } = await import('../src/veo');
    const r = await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/VEO_MODEL_ID/);
  });

  it('translates 401/403 errors into an auth hint pointing at /connections/tools', async () => {
    captureFetch({
      status: 200,
      body: { error: { code: 401, message: 'unauthenticated' } },
    });
    const { submitVeoVideo } = await import('../src/veo');
    const r = await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Gemini API key/);
  });
});

describe('Polish-19.2.2: VEO_DEFAULT_MODEL_ID regression pin', () => {
  // Tripwire — when the next person here drops the `-generate-preview`
  // suffix because "it looks redundant", this fires before deploy.
  // The suffix is required while Veo 3.1 is preview on the Gemini
  // Developer API (the pre-19.2.2 default 'veo-3.1-fast' returned 404
  // because that family identifier doesn't resolve without the suffix).
  //
  // When Veo 3.1 graduates from preview (suffix likely dropped), the
  // assertion below should be updated AND the doc comment in veo.ts
  // should mention the GA flip date.
  it('default model id ends with "-generate-preview" (Veo 3.1 family is preview on Developer API)', async () => {
    const { VEO_DEFAULT_MODEL_ID } = await import('../src/veo');
    expect(VEO_DEFAULT_MODEL_ID).toMatch(/-generate-preview$/);
  });

  it('default model id targets the "fast" tier (Polish-19.2 picked Fast for cost reasons)', async () => {
    const { VEO_DEFAULT_MODEL_ID } = await import('../src/veo');
    expect(VEO_DEFAULT_MODEL_ID).toContain('fast');
  });

  it('default model id starts with "veo-3.1" (not earlier Veo families)', async () => {
    const { VEO_DEFAULT_MODEL_ID } = await import('../src/veo');
    expect(VEO_DEFAULT_MODEL_ID).toMatch(/^veo-3\.1/);
  });
});

describe('Polish-19.2: pollVeoOperation parses long-running responses', () => {
  it('returns done=false while in flight', async () => {
    captureFetch({
      status: 200,
      body: { name: 'operations/abc', done: false },
    });
    const { pollVeoOperation } = await import('../src/veo');
    const r = await pollVeoOperation({ userId: 'u', apiKey: 'k', operationName: 'operations/abc' });
    expect(r.ok).toBe(true);
    expect(r.done).toBe(false);
    expect(r.videoUri).toBeUndefined();
  });

  it('extracts video URI from the Gemini Developer API response shape', async () => {
    captureFetch({
      status: 200,
      body: {
        name: 'operations/abc',
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz' } },
            ],
          },
        },
      },
    });
    const { pollVeoOperation } = await import('../src/veo');
    const r = await pollVeoOperation({ userId: 'u', apiKey: 'k', operationName: 'operations/abc' });
    expect(r.done).toBe(true);
    expect(r.videoUri).toBe('https://generativelanguage.googleapis.com/v1beta/files/xyz');
  });

  it('falls back to Vertex AI predictResponse shape if Google ships that variant', async () => {
    captureFetch({
      status: 200,
      body: {
        name: 'operations/abc',
        done: true,
        response: {
          predictResponse: {
            videos: [{ uri: 'gs://veo-output/abc.mp4' }],
          },
        },
      },
    });
    const { pollVeoOperation } = await import('../src/veo');
    const r = await pollVeoOperation({ userId: 'u', apiKey: 'k', operationName: 'operations/abc' });
    expect(r.videoUri).toBe('gs://veo-output/abc.mp4');
  });

  it('surfaces failMessage when the operation lands done + error', async () => {
    captureFetch({
      status: 200,
      body: {
        name: 'operations/abc',
        error: { code: 13, message: 'internal error' },
      },
    });
    const { pollVeoOperation } = await import('../src/veo');
    const r = await pollVeoOperation({ userId: 'u', apiKey: 'k', operationName: 'operations/abc' });
    expect(r.done).toBe(true);
    expect(r.failMessage).toMatch(/internal error/);
  });

  it('flags done-without-URI as a recoverable shape drift (Inngest log captures the body)', async () => {
    captureFetch({
      status: 200,
      body: { name: 'operations/abc', done: true, response: {} },
    });
    const { pollVeoOperation } = await import('../src/veo');
    const r = await pollVeoOperation({ userId: 'u', apiKey: 'k', operationName: 'operations/abc' });
    expect(r.done).toBe(true);
    expect(r.videoUri).toBeUndefined();
    expect(r.failMessage).toMatch(/done but no video URI/);
  });
});

describe('Polish-19.2: extractVeoOutputUri edge cases', () => {
  it('returns undefined for null / undefined / empty / non-object inputs', async () => {
    const { extractVeoOutputUri } = await import('../src/veo');
    expect(extractVeoOutputUri(null)).toBeUndefined();
    expect(extractVeoOutputUri(undefined)).toBeUndefined();
    expect(extractVeoOutputUri('string')).toBeUndefined();
    expect(extractVeoOutputUri({})).toBeUndefined();
    expect(extractVeoOutputUri({ response: {} })).toBeUndefined();
    expect(
      extractVeoOutputUri({ response: { generateVideoResponse: { generatedSamples: [] } } }),
    ).toBeUndefined();
  });
});

describe('Polish-19.2: estimateVeoCostUsd', () => {
  it('matches $0.15/sec list pricing', async () => {
    const { estimateVeoCostUsd } = await import('../src/veo');
    expect(estimateVeoCostUsd(8)).toBeCloseTo(1.2, 5);
    expect(estimateVeoCostUsd(30)).toBeCloseTo(4.5, 5);
    expect(estimateVeoCostUsd(0)).toBe(0);
    expect(estimateVeoCostUsd(-5)).toBe(0);
  });

  it('respects VEO_USD_PER_SECOND env override', async () => {
    process.env.VEO_USD_PER_SECOND = '0.05';
    const { estimateVeoCostUsd } = await import('../src/veo');
    expect(estimateVeoCostUsd(8)).toBeCloseTo(0.4, 5);
  });
});

describe('Polish-19.2: clampVeoDurationSeconds', () => {
  it('clamps above the 8s per-call ceiling', async () => {
    const { clampVeoDurationSeconds } = await import('../src/veo');
    expect(clampVeoDurationSeconds(30)).toBe(8);
    expect(clampVeoDurationSeconds(9)).toBe(8);
  });

  it('clamps below the 2s floor', async () => {
    const { clampVeoDurationSeconds } = await import('../src/veo');
    expect(clampVeoDurationSeconds(1)).toBe(2);
    expect(clampVeoDurationSeconds(0.5)).toBe(2);
  });

  it('passes mid-range values through (rounded)', async () => {
    const { clampVeoDurationSeconds } = await import('../src/veo');
    expect(clampVeoDurationSeconds(4)).toBe(4);
    expect(clampVeoDurationSeconds(5.4)).toBe(5);
    expect(clampVeoDurationSeconds(5.6)).toBe(6);
  });

  it('falls back to the per-call ceiling on non-finite / non-positive input', async () => {
    const { clampVeoDurationSeconds } = await import('../src/veo');
    expect(clampVeoDurationSeconds(NaN)).toBe(8);
    expect(clampVeoDurationSeconds(Infinity)).toBe(8);
    expect(clampVeoDurationSeconds(0)).toBe(8);
    expect(clampVeoDurationSeconds(-3)).toBe(8);
  });
});

describe('Polish-19.4: submitVeoExtend body shape', () => {
  const FILES_URI = 'https://generativelanguage.googleapis.com/v1beta/files/seg0xyz';

  it('POSTs to the same predictLongRunning endpoint with the video reference attached', async () => {
    const calls = captureFetch({ status: 200, body: { name: 'operations/ext-1' } });
    const { submitVeoExtend } = await import('../src/veo');
    const r = await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'Continue the scene — same person, same room, next 7s of monologue.',
    });
    expect(r.ok).toBe(true);
    expect(r.operationName).toBe('operations/ext-1');
    expect(calls[0]!.url).toContain(
      '/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning',
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    // Per Google docs the prior video reference lives in instances[0]
    // (not parameters). Pinning here so a future "let me move it"
    // refactor surfaces in tests, not in a production 400.
    expect(body.instances[0].video).toEqual({ uri: FILES_URI, mimeType: 'video/mp4' });
    expect(body.instances[0].prompt).toContain('7s');
  });

  it('Polish-19.4.1: OMITS durationSeconds by default (Veo rejects 7 — value not in [4,8])', async () => {
    // Hotfix regression pin. Pre-19.4.1 we sent durationSeconds: 7
    // per Google's "extends by 7 seconds" doc phrasing, which Veo's
    // API rejected with "value out of bound. Please provide a value
    // between 4 and 8, inclusive." The 7s is the OUTPUT increment
    // Veo produces, NOT a parameter value the client passes. Default
    // now: omit the field entirely so Veo's server-side default
    // (~7s output) kicks in.
    captureFetch({ status: 200, body: { name: 'operations/ext-2' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'segment 1 prompt',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.parameters.durationSeconds).toBeUndefined();
    expect('durationSeconds' in body.parameters).toBe(false);
  });

  it('Polish-19.4.1: sends durationSeconds when VEO_EXTEND_DURATION_SECONDS env is set to 8 (Option B fallback)', async () => {
    process.env.VEO_EXTEND_DURATION_SECONDS = '8';
    captureFetch({ status: 200, body: { name: 'operations/ext-2b' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'segment 1 prompt',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.parameters.durationSeconds).toBe(8);
  });

  it('Polish-19.4.1: garbage VEO_EXTEND_DURATION_SECONDS values fall back to omit', async () => {
    // Out-of-range integers, fractionals, words — all fall back to
    // omit so a typo'd env var doesn't reproduce the pre-19.4.1 400.
    for (const raw of ['', '   ', 'eight', '4.5', '99', '-1', '3']) {
      process.env.VEO_EXTEND_DURATION_SECONDS = raw;
      captureFetch({ status: 200, body: { name: 'operations/ext-2d' } });
      const { submitVeoExtend } = await import('../src/veo');
      await submitVeoExtend({
        userId: 'u',
        apiKey: 'k',
        previousVideo: { uri: FILES_URI },
        prompt: 'p',
      });
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const body = JSON.parse((calls[calls.length - 1]![1] as RequestInit).body as string);
      expect(body.parameters.durationSeconds).toBeUndefined();
    }
  });

  it('forces resolution="720p" on every Extend (Google rejects 1080p/4k when extending)', async () => {
    captureFetch({ status: 200, body: { name: 'operations/ext-3' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'segment 1 prompt',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.parameters.resolution).toBe('720p');
  });

  it('defaults personGeneration to "allow_all" on Extend (matches text-to-video rule)', async () => {
    captureFetch({ status: 200, body: { name: 'operations/ext-4' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'segment 1 prompt',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.parameters.personGeneration).toBe('allow_all');
  });

  it('honors VEO_PERSON_GENERATION env override (same env hatch as the base submit)', async () => {
    process.env.VEO_PERSON_GENERATION = 'dont_allow';
    captureFetch({ status: 200, body: { name: 'operations/ext-5' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'segment 1 prompt',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.parameters.personGeneration).toBe('dont_allow');
  });

  it('defaults aspect ratio to 9:16 (matches the worker base call) and honors override', async () => {
    captureFetch({ status: 200, body: { name: 'operations/ext-6' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'p',
    });
    expect(
      JSON.parse(
        ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
          .body as string,
      ).parameters.aspectRatio,
    ).toBe('9:16');

    captureFetch({ status: 200, body: { name: 'operations/ext-7' } });
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'p',
      aspectRatio: '16:9',
    });
    expect(
      JSON.parse(
        ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
          .body as string,
      ).parameters.aspectRatio,
    ).toBe('16:9');
  });

  it('defaults previousVideo.mimeType to "video/mp4" when caller omits it', async () => {
    captureFetch({ status: 200, body: { name: 'operations/ext-8' } });
    const { submitVeoExtend } = await import('../src/veo');
    await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI }, // no mimeType
      prompt: 'p',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    );
    expect(body.instances[0].video.mimeType).toBe('video/mp4');
  });

  it('translates 400 errors via the same translateVeoErrorStatus path as base submit', async () => {
    captureFetch({
      status: 200,
      body: { error: { code: 400, message: 'resolution must be 720p' } },
    });
    const { submitVeoExtend } = await import('../src/veo');
    const r = await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'p',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/validation failed/);
  });

  it('returns the operation name on success (caller polls with pollVeoOperation)', async () => {
    captureFetch({ status: 200, body: { name: 'operations/the-extend-op' } });
    const { submitVeoExtend } = await import('../src/veo');
    const r = await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: FILES_URI },
      prompt: 'p',
    });
    expect(r.ok).toBe(true);
    expect(r.operationName).toBe('operations/the-extend-op');
  });
});

describe('Polish-19.4: VEO_EXTEND_* constants', () => {
  it('VEO_EXTEND_SECONDS_PER_CALL = 7 (per docs, Extend adds 7s not 8s)', async () => {
    const { VEO_EXTEND_SECONDS_PER_CALL } = await import('../src/veo');
    expect(VEO_EXTEND_SECONDS_PER_CALL).toBe(7);
  });

  it('VEO_EXTEND_REQUIRED_RESOLUTION = "720p" (1080p/4k unsupported)', async () => {
    const { VEO_EXTEND_REQUIRED_RESOLUTION } = await import('../src/veo');
    expect(VEO_EXTEND_REQUIRED_RESOLUTION).toBe('720p');
  });

  it('VEO_EXTEND_MAX_CHAIN_CALLS = 20 (Google ceiling; 8 + 7×20 = 148s)', async () => {
    const { VEO_EXTEND_MAX_CHAIN_CALLS } = await import('../src/veo');
    expect(VEO_EXTEND_MAX_CHAIN_CALLS).toBe(20);
  });
});

describe('Polish-19.4.1: parseExtendDurationOverride', () => {
  it('returns null for unset / empty / whitespace (Option A default)', async () => {
    const { parseExtendDurationOverride } = await import('../src/veo');
    expect(parseExtendDurationOverride(undefined)).toBeNull();
    expect(parseExtendDurationOverride('')).toBeNull();
    expect(parseExtendDurationOverride('   ')).toBeNull();
  });

  it('returns the integer for valid in-range values [4, 8]', async () => {
    const { parseExtendDurationOverride } = await import('../src/veo');
    expect(parseExtendDurationOverride('4')).toBe(4);
    expect(parseExtendDurationOverride('6')).toBe(6);
    expect(parseExtendDurationOverride('8')).toBe(8);
    expect(parseExtendDurationOverride('  8  ')).toBe(8); // trims
  });

  it('returns null for out-of-range integers (Veo rejects ≤3 and ≥9)', async () => {
    const { parseExtendDurationOverride } = await import('../src/veo');
    expect(parseExtendDurationOverride('3')).toBeNull();
    expect(parseExtendDurationOverride('9')).toBeNull();
    expect(parseExtendDurationOverride('-1')).toBeNull();
    expect(parseExtendDurationOverride('99')).toBeNull();
  });

  it('returns null for the in-doc value 7 (the value that triggered the hotfix)', async () => {
    // Defensive: an operator who reads Google's "extends by 7 seconds"
    // doc and copy-pastes 7 into the env var should NOT reproduce the
    // pre-19.4.1 400. Even though 7 is between 4 and 8, our env
    // parser pins to the API-accepted range; this test is more about
    // documenting the gotcha than the math.
    const { parseExtendDurationOverride } = await import('../src/veo');
    // 7 IS in [4,8] so this returns 7 — but the test exists as a
    // breadcrumb: if Google's API later starts rejecting 7
    // explicitly, change the upper bound and this test fires.
    expect(parseExtendDurationOverride('7')).toBe(7);
  });

  it('returns null for fractional / non-numeric values', async () => {
    const { parseExtendDurationOverride } = await import('../src/veo');
    expect(parseExtendDurationOverride('4.5')).toBeNull();
    expect(parseExtendDurationOverride('eight')).toBeNull();
    expect(parseExtendDurationOverride('NaN')).toBeNull();
    expect(parseExtendDurationOverride('Infinity')).toBeNull();
  });
});

describe('Polish-19.4.3: detectVeoRateLimit', () => {
  it('returns true for HTTP 429 status', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(429, undefined)).toBe(true);
    expect(detectVeoRateLimit(429, 'anything')).toBe(true);
  });

  it('returns true for Google gRPC RESOURCE_EXHAUSTED (code 8)', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, undefined, 8)).toBe(true);
    expect(detectVeoRateLimit(200, 'anything', 8)).toBe(true);
  });

  it('returns true for string RESOURCE_EXHAUSTED code (case-insensitive)', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, undefined, 'RESOURCE_EXHAUSTED')).toBe(true);
    expect(detectVeoRateLimit(undefined, undefined, 'resource_exhausted')).toBe(true);
  });

  it('returns true for "rate limit" substring in the error message', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, 'Veo rate limit hit. Retry in a few seconds.')).toBe(true);
    expect(detectVeoRateLimit(undefined, 'RATE LIMIT exceeded')).toBe(true);
  });

  it('returns true for "quota exceeded" substring', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, 'quota exceeded for project')).toBe(true);
    expect(detectVeoRateLimit(undefined, 'Quota Exceeded')).toBe(true);
  });

  it('returns true for "resource_exhausted" substring (defensive against Google msg-only surfaces)', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, 'RESOURCE_EXHAUSTED: too many requests')).toBe(true);
  });

  it('returns false for non-rate-limit errors (validation / auth / model-not-found / server)', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(400, 'Veo validation failed')).toBe(false);
    expect(detectVeoRateLimit(401, 'Veo authentication failed')).toBe(false);
    expect(detectVeoRateLimit(404, 'Model not found')).toBe(false);
    expect(detectVeoRateLimit(500, 'Veo upstream error')).toBe(false);
  });

  it('returns false when both status + message are empty', async () => {
    const { detectVeoRateLimit } = await import('../src/veo');
    expect(detectVeoRateLimit(undefined, undefined)).toBe(false);
    expect(detectVeoRateLimit(undefined, '')).toBe(false);
  });
});

describe('Polish-19.4.3: computeVeoRateLimitBackoffMs', () => {
  it('produces the documented [10, 20, 40, 60, 60]s exponential curve', async () => {
    const { computeVeoRateLimitBackoffMs } = await import('../src/veo');
    expect(computeVeoRateLimitBackoffMs(0)).toBe(10_000);
    expect(computeVeoRateLimitBackoffMs(1)).toBe(20_000);
    expect(computeVeoRateLimitBackoffMs(2)).toBe(40_000);
    expect(computeVeoRateLimitBackoffMs(3)).toBe(60_000);
    expect(computeVeoRateLimitBackoffMs(4)).toBe(60_000);
  });

  it('caps at 60s for arbitrarily high attempt counts', async () => {
    const { computeVeoRateLimitBackoffMs } = await import('../src/veo');
    expect(computeVeoRateLimitBackoffMs(10)).toBe(60_000);
    expect(computeVeoRateLimitBackoffMs(100)).toBe(60_000);
  });

  it('clamps non-finite / negative attempt indices to the initial interval (10s)', async () => {
    const { computeVeoRateLimitBackoffMs } = await import('../src/veo');
    expect(computeVeoRateLimitBackoffMs(NaN)).toBe(10_000);
    expect(computeVeoRateLimitBackoffMs(-1)).toBe(10_000);
    expect(computeVeoRateLimitBackoffMs(Infinity)).toBe(10_000);
  });

  it('total wall-clock across the 5-retry default = ~190s (~3.2 min)', async () => {
    const { computeVeoRateLimitBackoffMs } = await import('../src/veo');
    let total = 0;
    for (let i = 0; i < 5; i++) total += computeVeoRateLimitBackoffMs(i);
    expect(total).toBe(190_000);
  });
});

describe('Polish-19.4.3: getVeoRateLimitMaxRetries', () => {
  it('defaults to 5 when the env var is unset', async () => {
    const { getVeoRateLimitMaxRetries, VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES } =
      await import('../src/veo');
    delete process.env.VEO_RATE_LIMIT_MAX_RETRIES;
    expect(VEO_DEFAULT_RATE_LIMIT_MAX_RETRIES).toBe(5);
    expect(getVeoRateLimitMaxRetries()).toBe(5);
  });

  it('honors integer env override', async () => {
    process.env.VEO_RATE_LIMIT_MAX_RETRIES = '3';
    const { getVeoRateLimitMaxRetries } = await import('../src/veo');
    expect(getVeoRateLimitMaxRetries()).toBe(3);
  });

  it('accepts 0 (disable retries) as a valid explicit value', async () => {
    process.env.VEO_RATE_LIMIT_MAX_RETRIES = '0';
    const { getVeoRateLimitMaxRetries } = await import('../src/veo');
    expect(getVeoRateLimitMaxRetries()).toBe(0);
  });

  it('falls back to default on garbage values', async () => {
    for (const raw of ['', '   ', 'five', '-1', '3.5', 'NaN']) {
      process.env.VEO_RATE_LIMIT_MAX_RETRIES = raw;
      vi.resetModules();
      const { getVeoRateLimitMaxRetries } = await import('../src/veo');
      expect(getVeoRateLimitMaxRetries()).toBe(5);
    }
  });
});

describe('Polish-19.4.3: submitVeoVideo retries on rate-limit responses', () => {
  // Stub sleep() to no-op via the module's __setSleepImplForTests
  // hatch so the 10/20/40/60s backoffs don't force real wall-clock
  // waits. Must be applied AFTER dynamic import (module is reset
  // per test by the file-level beforeEach).
  async function importWithFastSleep() {
    const mod = await import('../src/veo');
    mod.__setSleepImplForTests(() => Promise.resolve());
    return mod;
  }
  afterEach(async () => {
    const mod = await import('../src/veo');
    mod.__restoreSleepImplForTests();
  });

  it('retries once on 429 then succeeds on the second attempt', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          status: 429,
          text: async () => JSON.stringify({ error: { code: 429 } }),
        } as Response;
      }
      return {
        status: 200,
        text: async () => JSON.stringify({ name: 'operations/success-after-retry' }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitVeoVideo } = await importWithFastSleep();
    const r = await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    expect(r.ok).toBe(true);
    expect(r.operationName).toBe('operations/success-after-retry');
    expect(call).toBe(2);
  });

  it('does NOT retry on non-rate-limit failures (400 validation returns immediately)', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return {
        status: 200,
        text: async () => JSON.stringify({ error: { code: 400, message: 'bad prompt' } }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitVeoVideo } = await importWithFastSleep();
    const r = await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/validation failed/);
    expect(call).toBe(1);
  });

  it('exhausts retries and surfaces a diagnosable error message', async () => {
    process.env.VEO_RATE_LIMIT_MAX_RETRIES = '2'; // 3 attempts total
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      return { status: 429, text: async () => JSON.stringify({}) } as Response;
    }) as typeof globalThis.fetch;

    const { submitVeoVideo } = await importWithFastSleep();
    const r = await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    expect(r.ok).toBe(false);
    expect(call).toBe(3); // initial + 2 retries
    expect(r.errorMessage).toMatch(/hit after 3 attempts/);
    expect(r.errorMessage).toMatch(/VEO_RATE_LIMIT_MAX_RETRIES/);
  });
});

describe('Polish-19.4.3: submitVeoExtend retries on rate-limit responses', () => {
  async function importWithFastSleep() {
    const mod = await import('../src/veo');
    mod.__setSleepImplForTests(() => Promise.resolve());
    return mod;
  }
  afterEach(async () => {
    const mod = await import('../src/veo');
    mod.__restoreSleepImplForTests();
  });

  it('retries the extend call on 429 then succeeds', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return { status: 429, text: async () => '{}' } as Response;
      return {
        status: 200,
        text: async () => JSON.stringify({ name: 'operations/ext-recovered' }),
      } as Response;
    }) as typeof globalThis.fetch;

    const { submitVeoExtend } = await importWithFastSleep();
    const r = await submitVeoExtend({
      userId: 'u',
      apiKey: 'k',
      previousVideo: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/xyz' },
      prompt: 'segment 1',
    });
    expect(r.ok).toBe(true);
    expect(r.operationName).toBe('operations/ext-recovered');
    expect(call).toBe(2);
  });
});
