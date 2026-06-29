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

  it('Polish-19.2.3: omits personGeneration by default (Developer API rejects "allow_adult")', async () => {
    // Tripwire — Polish-19.2 hardcoded personGeneration:'allow_adult'
    // which the Gemini Developer API rejects with "currently not
    // supported". A future "let me add a sensible default here"
    // cleanup must NOT reintroduce the field without going through
    // the VEO_PERSON_GENERATION env override path.
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBeUndefined();
    expect('personGeneration' in body.parameters).toBe(false);
  });

  it('Polish-19.2.3: includes personGeneration ONLY when VEO_PERSON_GENERATION env is set', async () => {
    process.env.VEO_PERSON_GENERATION = 'allow_all';
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBe('allow_all');
  });

  it('Polish-19.2.3: empty/whitespace VEO_PERSON_GENERATION still omits the field', async () => {
    process.env.VEO_PERSON_GENERATION = '   ';
    captureFetch({ status: 200, body: { name: 'operations/x' } });
    const { submitVeoVideo } = await import('../src/veo');
    await submitVeoVideo({ userId: 'u', apiKey: 'k', prompt: 'test' });
    const captured = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.parameters.personGeneration).toBeUndefined();
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
