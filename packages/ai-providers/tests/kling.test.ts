/**
 * Polish-4: Kling via Replicate — submit + poll + error classification.
 * Polish-9.17: defaults to kling-v2.6 with native-audio params in
 * the submit body.
 *
 * Mocks: global fetch + @mbb/db audit logger. Same pattern as
 * heygen-client.test.ts (fetch returns a Response-shaped object with a
 * text() method, since chokepoint reads text() then JSON.parses).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkKlingPrediction,
  classifyKlingError,
  estimateKlingClipCostUsd,
  getKlingModelId,
  submitKlingVideo,
} from '../src/kling';

const realFetch = globalThis.fetch;
const realEnv = process.env;
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = realEnv;
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

describe('Polish-4: submitKlingVideo', () => {
  it('POSTs to /v1/models/{model}/predictions with prompt + duration + aspect_ratio', async () => {
    const calls = captureFetch({ status: 201, body: { id: 'pred_abc', status: 'starting' } });
    const r = await submitKlingVideo({
      userId: 'u',
      apiKey: 'token_xyz',
      prompt: 'A cinematic 5-second clip of morning light through a kitchen window',
      durationSeconds: 5,
      aspectRatio: '9:16',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_abc');
    expect(r.modelId).toBe(getKlingModelId());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/models/');
    expect(calls[0]!.url).toContain('/predictions');
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Token token_xyz');
    const body = JSON.parse(init.body as string);
    expect(body.input.prompt).toMatch(/cinematic/);
    expect(body.input.duration).toBe(5);
    expect(body.input.aspect_ratio).toBe('9:16');
  });

  it('honors KLING_MODEL_ID env override', async () => {
    process.env = { ...realEnv, KLING_MODEL_ID: 'kwaivgi/kling-v3-experimental' };
    const calls = captureFetch({ status: 201, body: { id: 'pred_x' } });
    await submitKlingVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
    });
    expect(calls[0]!.url).toContain('kwaivgi/kling-v3-experimental');
  });

  it('returns ok=false on 401 with httpStatus', async () => {
    mockFetchOnce({ status: 401, body: { detail: 'invalid token' } });
    const r = await submitKlingVideo({ userId: 'u', apiKey: 'bad', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(401);
    expect(classifyKlingError(r.httpStatus, r.errorMessage)).toBe('auth');
  });

  it('returns ok=false when Replicate response lacks an id', async () => {
    mockFetchOnce({ status: 201, body: { status: 'starting' } });
    const r = await submitKlingVideo({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/prediction id/i);
  });
});

describe('Polish-4: checkKlingPrediction', () => {
  it('normalizes status=succeeded into completed + extracts first output URL', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        id: 'pred_a',
        status: 'succeeded',
        output: ['https://replicate.delivery/clip.mp4', 'https://replicate.delivery/extra.mp4'],
      },
    });
    const r = await checkKlingPrediction({ userId: 'u', apiKey: 'k', predictionId: 'pred_a' });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://replicate.delivery/clip.mp4');
    expect(r.costUsd).toBe(estimateKlingClipCostUsd());
  });

  it('handles output as a single string (some Replicate models)', async () => {
    mockFetchOnce({
      status: 200,
      body: { id: 'p', status: 'succeeded', output: 'https://r.delivery/v.mp4' },
    });
    const r = await checkKlingPrediction({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r.delivery/v.mp4');
  });

  it('treats starting + processing as processing', async () => {
    mockFetchOnce({ status: 200, body: { id: 'p', status: 'processing' } });
    const r = await checkKlingPrediction({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
  });

  it('maps failed + canceled to failed and surfaces error', async () => {
    mockFetchOnce({
      status: 200,
      body: { id: 'p', status: 'failed', error: 'model crashed' },
    });
    const r = await checkKlingPrediction({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toBe('model crashed');
  });
});

describe('Polish-9.17: defaults to kling-v2.6 + sends native-audio params', () => {
  it('default model id when KLING_MODEL_ID unset', () => {
    process.env = { ...realEnv };
    delete process.env.KLING_MODEL_ID;
    expect(getKlingModelId()).toBe('kwaivgi/kling-v2.6');
  });

  it('Polish-10.4: submit body OMITS audio shotgun (Kling 2.5 rejects them)', async () => {
    const calls = captureFetch({ status: 201, body: { id: 'pred_audio' } });
    const r = await submitKlingVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'A 30yo woman speaks to camera',
      durationSeconds: 5,
      aspectRatio: '9:16',
      startImageUrl: 'https://x/frame.png',
    });
    expect(r.ok).toBe(true);
    const init = calls[0]!.init!;
    const body = JSON.parse(init.body as string);
    // Audio shotgun (Polish-9.17) removed — Kling 2.5 turbo pro
    // rejects these with strict input validation. Path 1 handles
    // audio via ElevenLabs + lip-sync (Polish-11).
    expect(body.input).not.toHaveProperty('enable_audio');
    expect(body.input).not.toHaveProperty('with_audio');
    expect(body.input).not.toHaveProperty('generate_audio');
    expect(body.input).not.toHaveProperty('audio');
    // Other fields still set as before.
    expect(body.input.start_image).toBe('https://x/frame.png');
    expect(body.input.prompt).toMatch(/30yo woman/);
    expect(body.input.duration).toBe(5);
    expect(body.input.aspect_ratio).toBe('9:16');
    expect(body.input.negative_prompt).toMatch(/captions/i);
  });

  it('per-clip cost bumped from $0.30 → $0.35 on v2.6', () => {
    expect(estimateKlingClipCostUsd()).toBe(0.35);
  });
});

describe('Polish-4: classifyKlingError', () => {
  it('maps the buckets', () => {
    expect(classifyKlingError(401, 'x')).toBe('auth');
    expect(classifyKlingError(403, 'x')).toBe('auth');
    expect(classifyKlingError(402, 'x')).toBe('credits');
    expect(classifyKlingError(429, 'x')).toBe('credits');
    expect(classifyKlingError(404, 'no such model')).toBe('model_missing');
    expect(classifyKlingError(500, 'x')).toBe('server');
    expect(classifyKlingError(0, 'timeout exceeded')).toBe('timeout');
    expect(classifyKlingError(400, 'bad input')).toBe('unknown');
  });
});

describe('Polish-9.18: Kling submit carries negative_prompt to suppress captions + plastic skin', () => {
  it('default negative_prompt covers captions, plastic skin, studio lighting, AI symmetry', async () => {
    const calls = captureFetch({ status: 201, body: { id: 'pred_neg' } });
    const r = await submitKlingVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.negative_prompt).toMatch(/captions/i);
    expect(body.input.negative_prompt).toMatch(/subtitles/i);
    expect(body.input.negative_prompt).toMatch(/burned-in text/i);
    expect(body.input.negative_prompt).toMatch(/plastic skin/i);
    expect(body.input.negative_prompt).toMatch(/airbrushed/i);
    expect(body.input.negative_prompt).toMatch(/studio lighting/i);
    expect(body.input.negative_prompt).toMatch(/symmetric face/i);
  });

  it('honors per-call negativePrompt override', async () => {
    const calls = captureFetch({ status: 201, body: { id: 'pred_neg2' } });
    await submitKlingVideo({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      negativePrompt: 'lo-fi, blurry, distorted',
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.negative_prompt).toBe('lo-fi, blurry, distorted');
  });
});
