/**
 * Polish-23 Commit 1: WaveSpeedAI Higgsfield Soul client tests.
 * Pins:
 *   - endpoint URL + Bearer auth (not x-api-key)
 *   - request body shape (prompt + image + size + quality; optional
 *     strength / style / seed only when caller provides them)
 *   - default quality = high (Polish-23 spec anchor)
 *   - poll response parsing (queued / processing / completed / failed / cancelled)
 *   - completed response extracts data.outputs[0]
 *   - error translation for 401/402/422/429/5xx
 *   - cost constants match Polish-23 spec ($0.09 medium, $0.23 high)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

import {
  estimateWavespeedSoulCostUsd,
  normalizeWavespeedStatus,
  pollWavespeedSoul,
  submitWavespeedSoul,
  translateWavespeedErrorStatus,
  verifyWavespeedKey,
  WAVESPEED_SOUL_DEFAULT_QUALITY,
  WAVESPEED_SOUL_USD_PER_RUN,
} from '../src/wavespeed';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(response: { status: number; body: unknown }): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('Polish-23 Commit 1: submitWavespeedSoul — endpoint + auth + body shape', () => {
  it('POSTs the documented Higgsfield Soul URL with Bearer auth', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'pred-42', status: 'queued' } },
    });
    const r = await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'wsk_live_' + 'A'.repeat(24),
      prompt: 'iPhone selfie of Linda, hyper photoreal',
      image: 'https://cdn.example/seed.png',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred-42');
    expect(calls[0]!.url).toBe('https://api.wavespeed.ai/api/v3/higgsfield/soul/image-to-image');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer wsk_live_' + 'A'.repeat(24));
    expect(headers['content-type']).toBe('application/json');
  });

  it('body carries prompt + image + size + quality; Polish-23 default quality = high', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'pred-43', status: 'queued' } },
    });
    await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'k',
      prompt: 'a linda-pattern character',
      image: 'https://cdn.example/nano-banana-seed.png',
    });
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body['prompt']).toBe('a linda-pattern character');
    expect(body['image']).toBe('https://cdn.example/nano-banana-seed.png');
    // Regression pin: Polish-23 vertical UGC default.
    expect(body['size']).toBe('1152*2048');
    // Regression pin: high quality is the Polish-23 spec anchor.
    expect(body['quality']).toBe('high');
    expect(body['strength']).toBeUndefined();
    expect(body['style']).toBeUndefined();
    expect(body['seed']).toBeUndefined();
  });

  it('caller can override quality to medium (cost-conscious pipelines)', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'pred-44', status: 'queued' } },
    });
    await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      image: 'https://x/y.png',
      quality: 'medium',
    });
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body['quality']).toBe('medium');
  });

  it('optional strength / style / seed pass through when set', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'pred-45', status: 'queued' } },
    });
    await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      image: 'https://x/y.png',
      strength: 0.7,
      style: 'Cinematic',
      seed: 12345,
    });
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body['strength']).toBe(0.7);
    expect(body['style']).toBe('Cinematic');
    expect(body['seed']).toBe(12345);
  });

  it('accepts a top-level id on the submit response (some model endpoints return it unwrapped)', async () => {
    captureFetch({ status: 200, body: { id: 'pred-top-level' } });
    const r = await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      image: 'https://x/y.png',
    });
    expect(r.predictionId).toBe('pred-top-level');
  });

  it('missing id in the response surfaces as a clear error', async () => {
    captureFetch({ status: 200, body: { data: { status: 'queued' } } });
    const r = await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      image: 'https://x/y.png',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/prediction id/);
  });

  it('401 translates to re-paste-key guidance', async () => {
    captureFetch({ status: 401, body: { message: 'invalid key' } });
    const r = await submitWavespeedSoul({
      userId: 'u',
      apiKey: 'bad',
      prompt: 'p',
      image: 'https://x/y.png',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/authentication failed/i);
    expect(r.errorMessage).toMatch(/connections\/ai-provider/);
  });
});

describe('Polish-23 Commit 1: pollWavespeedSoul + normalizeWavespeedStatus', () => {
  it('GETs the documented result URL with Bearer auth', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'pred-1', status: 'processing' } },
    });
    const r = await pollWavespeedSoul({
      userId: 'u',
      apiKey: 'wsk_live_' + 'B'.repeat(24),
      predictionId: 'pred-1',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('processing');
    expect(r.outputUrl).toBeUndefined();
    expect(calls[0]!.url).toBe('https://api.wavespeed.ai/api/v3/predictions/pred-1/result');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer wsk_live_' + 'B'.repeat(24));
  });

  it('completed status extracts data.outputs[0] as the output URL', async () => {
    captureFetch({
      status: 200,
      body: {
        data: {
          id: 'pred-1',
          status: 'completed',
          outputs: ['https://cdn.wavespeed/output.png'],
        },
      },
    });
    const r = await pollWavespeedSoul({ userId: 'u', apiKey: 'k', predictionId: 'pred-1' });
    expect(r.status).toBe('completed');
    expect(r.outputUrl).toBe('https://cdn.wavespeed/output.png');
  });

  it('failed status surfaces error_message', async () => {
    captureFetch({
      status: 200,
      body: {
        data: { id: 'pred-1', status: 'failed', error_message: 'downstream model rejected input' },
      },
    });
    const r = await pollWavespeedSoul({ userId: 'u', apiKey: 'k', predictionId: 'pred-1' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/downstream model rejected input/);
    expect(r.outputUrl).toBeUndefined();
  });

  it('cancelled status is terminal too', async () => {
    captureFetch({
      status: 200,
      body: { data: { id: 'pred-1', status: 'cancelled' } },
    });
    const r = await pollWavespeedSoul({ userId: 'u', apiKey: 'k', predictionId: 'pred-1' });
    expect(r.status).toBe('cancelled');
    expect(r.errorMessage).toMatch(/cancelled/i);
  });

  it('URL-encodes the prediction id (defensive)', async () => {
    const calls = captureFetch({
      status: 200,
      body: { data: { id: 'p', status: 'queued' } },
    });
    await pollWavespeedSoul({ userId: 'u', apiKey: 'k', predictionId: 'p/with/slashes' });
    expect(calls[0]!.url).toBe(
      'https://api.wavespeed.ai/api/v3/predictions/p%2Fwith%2Fslashes/result',
    );
  });

  it('normalizeWavespeedStatus handles case + synonyms', () => {
    expect(normalizeWavespeedStatus('completed')).toBe('completed');
    expect(normalizeWavespeedStatus('COMPLETE')).toBe('completed');
    expect(normalizeWavespeedStatus('succeeded')).toBe('completed');
    expect(normalizeWavespeedStatus('failed')).toBe('failed');
    expect(normalizeWavespeedStatus('error')).toBe('failed');
    expect(normalizeWavespeedStatus('cancelled')).toBe('cancelled');
    expect(normalizeWavespeedStatus('canceled')).toBe('cancelled');
    expect(normalizeWavespeedStatus('running')).toBe('processing');
    expect(normalizeWavespeedStatus('in_progress')).toBe('processing');
    expect(normalizeWavespeedStatus('pending')).toBe('queued');
    expect(normalizeWavespeedStatus('mystery')).toBeUndefined();
    expect(normalizeWavespeedStatus(null)).toBeUndefined();
    expect(normalizeWavespeedStatus(42)).toBeUndefined();
  });
});

describe('Polish-23 Commit 1: translateWavespeedErrorStatus branches', () => {
  it('401/403 → re-paste-key guidance', () => {
    expect(translateWavespeedErrorStatus(401, 'x')).toMatch(/authentication failed/i);
    expect(translateWavespeedErrorStatus(403, 'x')).toMatch(/authentication failed/i);
  });
  it('402 → top-up guidance with the wavespeed dashboard URL', () => {
    expect(translateWavespeedErrorStatus(402, 'x')).toMatch(/Insufficient/i);
    expect(translateWavespeedErrorStatus(402, 'x')).toMatch(/wavespeed\.ai\/dashboard/);
  });
  it('404 / 422 / 429 / 5xx have distinct messages', () => {
    expect(translateWavespeedErrorStatus(404, undefined)).toMatch(/not found/i);
    expect(translateWavespeedErrorStatus(422, 'bad')).toMatch(/validation failed/i);
    expect(translateWavespeedErrorStatus(429, undefined)).toMatch(/rate limit/i);
    expect(translateWavespeedErrorStatus(503, undefined)).toMatch(/upstream error/i);
  });
});

describe('Polish-23 Commit 1: verifyWavespeedKey', () => {
  it('401 → ok:false with re-paste guidance', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 401,
      json: async () => ({}),
    } as Response) as typeof globalThis.fetch;
    const r = await verifyWavespeedKey('wsk_bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/re-?paste/i);
  });

  it('any 2xx / 4xx (except 401/403) → ok:true (key accepted; body-level rejection is not our problem)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 422,
      json: async () => ({ message: 'prompt required' }),
    } as Response) as typeof globalThis.fetch;
    const r = await verifyWavespeedKey('wsk_' + 'A'.repeat(24));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.statusCode).toBe(422);
  });

  it('5xx → ok:false with retry hint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 503,
      json: async () => ({}),
    } as Response) as typeof globalThis.fetch;
    const r = await verifyWavespeedKey('wsk_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/upstream/i);
  });
});

describe('Polish-23 Commit 1: cost constants', () => {
  it('WAVESPEED_SOUL_USD_PER_RUN pins medium = $0.09 and high = $0.23 (Polish-23 spec anchor)', () => {
    expect(WAVESPEED_SOUL_USD_PER_RUN.medium).toBe(0.09);
    expect(WAVESPEED_SOUL_USD_PER_RUN.high).toBe(0.23);
  });

  it('Polish-23 default quality is high (locked-character-detail advantage per BCH spec)', () => {
    expect(WAVESPEED_SOUL_DEFAULT_QUALITY).toBe('high');
  });

  it('estimateWavespeedSoulCostUsd returns the correct tier price', () => {
    expect(estimateWavespeedSoulCostUsd('medium')).toBe(0.09);
    expect(estimateWavespeedSoulCostUsd('high')).toBe(0.23);
  });
});
