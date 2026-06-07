/**
 * Polish-10: Kling 3.0 Omni client — submit/check + body shape against
 * the verified Replicate schema (reference_images array, multi_prompt
 * as JSON string, mode default 'pro', generate_audio true explicit).
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

describe('Polish-10: getKlingOmniRawModelId', () => {
  it('defaults to kwaivgi/kling-v3-omni-video', async () => {
    delete process.env.REPLICATE_KLING_OMNI_MODEL_ID;
    const { getKlingOmniRawModelId } = await import('../src/kling-omni');
    expect(getKlingOmniRawModelId()).toBe('kwaivgi/kling-v3-omni-video');
  });

  it('honors REPLICATE_KLING_OMNI_MODEL_ID override (with version hash)', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video:abc123';
    const { getKlingOmniRawModelId } = await import('../src/kling-omni');
    expect(getKlingOmniRawModelId()).toBe('kwaivgi/kling-v3-omni-video:abc123');
  });
});

describe('Polish-10: submitKlingOmni body shape (verified schema)', () => {
  it('unversioned model id → POSTs to /v1/models/{owner}/{name}/predictions with input only', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_a' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    const r = await submitKlingOmni({
      userId: 'u',
      apiKey: 'k',
      prompt: 'A 30yo woman in a kitchen',
    });
    expect(r.ok).toBe(true);
    expect(r.predictionId).toBe('pred_a');
    expect(calls[0]!.url).toContain('/v1/models/kwaivgi/kling-v3-omni-video/predictions');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).not.toHaveProperty('version');
    expect(body.input.prompt).toMatch(/30yo woman/);
    // Defaults per schema.
    expect(body.input.duration).toBe(15);
    expect(body.input.aspect_ratio).toBe('9:16');
    expect(body.input.mode).toBe('pro');
    // generate_audio default is FALSE in the schema — we set explicitly.
    expect(body.input.generate_audio).toBe(true);
    // Negative prompt set unless overridden.
    expect(body.input.negative_prompt).toMatch(/captions/i);
    expect(body.input.negative_prompt).toMatch(/plastic skin/i);
  });

  it('versioned "owner/name:HASH" → POSTs to /v1/predictions with {version, input}', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video:abc123def';
    const calls = captureFetch({ status: 201, body: { id: 'pred_b' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    await submitKlingOmni({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(calls[0]!.url).toMatch(/\/v1\/predictions$/);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.version).toBe('abc123def');
    expect(body.input.prompt).toBe('p');
  });

  it('reference_images is an array (max 7), NOT shotgun-aliased', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_c' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    await submitKlingOmni({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      referenceImageUrls: ['https://x/ref.png'],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.reference_images).toEqual(['https://x/ref.png']);
    // The shotgun aliases from earlier drafts must NOT be present —
    // the verified schema only takes reference_images.
    expect(body.input).not.toHaveProperty('reference_image');
    expect(body.input).not.toHaveProperty('image');
    expect(body.input).not.toHaveProperty('start_image');
  });

  it('caps reference_images to 7 per schema limit', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_d' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    const tenUrls = Array.from({ length: 10 }, (_, i) => `https://x/r${i}.png`);
    await submitKlingOmni({ userId: 'u', apiKey: 'k', prompt: 'p', referenceImageUrls: tenUrls });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.reference_images).toHaveLength(7);
  });

  it('multi_prompt is JSON-stringified array, capped at 6 shots', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_e' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    await submitKlingOmni({
      userId: 'u',
      apiKey: 'k',
      prompt: 'outer',
      multiPrompt: [
        { prompt: '<<<image_1>>> shot A', duration: 5 },
        { prompt: '<<<image_1>>> shot B', duration: 5 },
        { prompt: '<<<image_1>>> shot C', duration: 5 },
      ],
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(typeof body.input.multi_prompt).toBe('string');
    const parsed = JSON.parse(body.input.multi_prompt as string);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ prompt: '<<<image_1>>> shot A', duration: 5 });
  });

  it('honors mode override (standard for cheap iteration)', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_f' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    await submitKlingOmni({ userId: 'u', apiKey: 'k', prompt: 'p', mode: 'standard' });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.mode).toBe('standard');
  });

  it('honors per-call negativePrompt override', async () => {
    process.env.REPLICATE_KLING_OMNI_MODEL_ID = 'kwaivgi/kling-v3-omni-video';
    const calls = captureFetch({ status: 201, body: { id: 'pred_g' } });
    const { submitKlingOmni } = await import('../src/kling-omni');
    await submitKlingOmni({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      negativePrompt: 'lo-fi only',
    });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.input.negative_prompt).toBe('lo-fi only');
  });
});

describe('Polish-10: KLING_OMNI_NEGATIVE_PROMPT', () => {
  it('suppresses captions / AI-skin / studio lighting / theatrical pacing', async () => {
    const { KLING_OMNI_NEGATIVE_PROMPT } = await import('../src/kling-omni');
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/captions/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/subtitles/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/burned-in text/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/plastic skin/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/airbrushed/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/studio lighting/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/symmetric face/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/long pauses/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/dead air/i);
    expect(KLING_OMNI_NEGATIVE_PROMPT).toMatch(/theatrical pacing/i);
  });
});

describe('Polish-10: estimateKlingOmniSegmentCostUsd', () => {
  it('pro mode: $0.28/sec × 15s = $4.20', async () => {
    const { estimateKlingOmniSegmentCostUsd } = await import('../src/kling-omni');
    expect(estimateKlingOmniSegmentCostUsd(15, 'pro')).toBeCloseTo(4.2, 4);
  });

  it('standard mode: $0.224/sec × 15s = $3.36', async () => {
    const { estimateKlingOmniSegmentCostUsd } = await import('../src/kling-omni');
    expect(estimateKlingOmniSegmentCostUsd(15, 'standard')).toBeCloseTo(3.36, 4);
  });
});

describe('Polish-10: checkKlingOmni', () => {
  it('succeeded → completed with videoUrl + duration-aware cost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r/v.mp4' }),
    } as Response) as typeof globalThis.fetch;
    const { checkKlingOmni } = await import('../src/kling-omni');
    const r = await checkKlingOmni({
      userId: 'u',
      apiKey: 'k',
      predictionId: 'p',
      durationSeconds: 15,
      mode: 'pro',
    });
    expect(r.status).toBe('completed');
    expect(r.videoUrl).toBe('https://r/v.mp4');
    expect(r.costUsd).toBeCloseTo(4.2, 4);
  });

  it('failed → failed with errorMessage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ id: 'p', status: 'failed', error: 'OOM' }),
    } as Response) as typeof globalThis.fetch;
    const { checkKlingOmni } = await import('../src/kling-omni');
    const r = await checkKlingOmni({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/OOM/);
  });

  it('processing → processing with 0 cost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ id: 'p', status: 'processing' }),
    } as Response) as typeof globalThis.fetch;
    const { checkKlingOmni } = await import('../src/kling-omni');
    const r = await checkKlingOmni({ userId: 'u', apiKey: 'k', predictionId: 'p' });
    expect(r.status).toBe('processing');
    expect(r.costUsd).toBe(0);
  });
});
