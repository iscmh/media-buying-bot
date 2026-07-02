/**
 * Polish-21 Commit 1: hedra-video client tests. Pins:
 *  - request-body shape for POST /generations (both TTS and uploaded-audio modes)
 *  - asset create + upload flow (multipart-safe fetch call, no
 *    Content-Type override — Hedra's parser rejects a custom
 *    boundary)
 *  - status normalization (complete/error/processing/pending/queued)
 *  - error translation (401 / 402 / 403 / 422 / 429 / 5xx)
 *  - verifyHedraKey happy-path + reject shape
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;

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
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('Polish-21: createHedraAsset', () => {
  it('POSTs /assets with the correct body + x-api-key header, returns asset id', async () => {
    const calls = captureFetch({ status: 200, body: { id: 'asset-42' } });
    const { createHedraAsset } = await import('../src/hedra-video');
    const r = await createHedraAsset({
      userId: 'u',
      apiKey: 'k',
      name: 'image.png',
      type: 'image',
    });
    expect(r.ok).toBe(true);
    expect(r.assetId).toBe('asset-42');
    expect(calls[0]!.url).toBe('https://api.hedra.com/web-app/public/assets');
    expect((calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('k');
    const body = JSON.parse(calls[0]!.init!.body as string) as { name: string; type: string };
    expect(body).toEqual({ name: 'image.png', type: 'image' });
  });

  it('translates 401 into a re-paste-key message', async () => {
    captureFetch({ status: 401, body: { message: 'invalid api key' } });
    const { createHedraAsset } = await import('../src/hedra-video');
    const r = await createHedraAsset({ userId: 'u', apiKey: 'k', name: 'x.png', type: 'image' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Hedra authentication failed/);
    expect(r.errorMessage).toMatch(/\/connections\/ai-provider/);
  });

  it('surfaces the id-missing failure when response is 200 but body has no id', async () => {
    captureFetch({ status: 200, body: {} });
    const { createHedraAsset } = await import('../src/hedra-video');
    const r = await createHedraAsset({ userId: 'u', apiKey: 'k', name: 'x.png', type: 'image' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/missing id/);
  });
});

describe('Polish-21: uploadHedraAsset', () => {
  it('POSTs multipart body to /assets/{id}/upload WITHOUT a Content-Type override', async () => {
    const calls = captureFetch({ status: 200, body: {} });
    const { uploadHedraAsset } = await import('../src/hedra-video');
    const r = await uploadHedraAsset({
      userId: 'u',
      apiKey: 'k',
      assetId: 'asset-42',
      filename: 'ref.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://api.hedra.com/web-app/public/assets/asset-42/upload');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    // CRITICAL: setting a manual content-type breaks Hedra's
    // multipart parser (verified against ComfyUI Hedra + official
    // hedra-api-starter). The Blob's Content-Type flows via the
    // FormData boundary, not this header dict.
    expect(headers['content-type']).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
    // Body must be a FormData (multipart), not a JSON string.
    expect(calls[0]!.init!.body).toBeInstanceOf(FormData);
  });

  it('4xx from Hedra surfaces as translated error message', async () => {
    captureFetch({ status: 422, body: { detail: 'asset already uploaded' } });
    const { uploadHedraAsset } = await import('../src/hedra-video');
    const r = await uploadHedraAsset({
      userId: 'u',
      apiKey: 'k',
      assetId: 'asset-42',
      filename: 'ref.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1]),
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/parameter validation/);
    expect(r.errorMessage).toMatch(/asset already uploaded/);
  });
});

describe('Polish-21: submitHedraGeneration', () => {
  it('TTS mode: audio_generation block with voice_id + text; NO audio_id', async () => {
    const calls = captureFetch({ status: 200, body: { id: 'gen-99' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'd1dd37a3-e39a-4854-a298-6510289f9cf2',
      startKeyframeId: 'img-1',
      tts: { voiceId: 'v-1', text: 'I swear to god...' },
      textPrompt: 'A 42-year-old woman in a parked SUV, tripod-style selfie framing.',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    expect(r.ok).toBe(true);
    expect(r.generationId).toBe('gen-99');
    expect(calls[0]!.url).toBe('https://api.hedra.com/web-app/public/generations');
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body.type).toBe('video');
    expect(body.ai_model_id).toBe('d1dd37a3-e39a-4854-a298-6510289f9cf2');
    expect(body.start_keyframe_id).toBe('img-1');
    expect(body.audio_generation).toEqual({
      type: 'text_to_speech',
      voice_id: 'v-1',
      text: 'I swear to god...',
    });
    expect(body.audio_id).toBeUndefined();
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.text_prompt).toBe(
      'A 42-year-old woman in a parked SUV, tripod-style selfie framing.',
    );
    expect(gvi.resolution).toBe('720p');
    expect(gvi.aspect_ratio).toBe('9:16');
    // No duration_ms unless explicitly passed (Hedra derives from audio).
    expect(gvi.duration_ms).toBeUndefined();
  });

  it('uploaded-audio mode: audio_id set; NO audio_generation', async () => {
    captureFetch({ status: 200, body: { id: 'gen-100' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'model-uuid',
      startKeyframeId: 'img-1',
      audioAssetId: 'audio-2',
      textPrompt: 'scene',
      resolution: '540p',
      aspectRatio: '9:16',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    expect(body.audio_id).toBe('audio-2');
    expect(body.audio_generation).toBeUndefined();
  });

  it('duration_ms is set only when durationSeconds passed; rounded to milliseconds', async () => {
    captureFetch({ status: 200, body: { id: 'gen-101' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'm',
      startKeyframeId: 'i',
      tts: { voiceId: 'v', text: 't' },
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 30,
      seed: 42,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as { generated_video_inputs: Record<string, unknown> };
    expect(body.generated_video_inputs.duration_ms).toBe(30_000);
    expect(body.generated_video_inputs.seed).toBe(42);
  });

  it('rejects when neither audioAssetId nor tts is provided', async () => {
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'm',
      startKeyframeId: 'i',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/audioAssetId or tts/);
  });

  it('rejects when BOTH audioAssetId AND tts are provided (ambiguous)', async () => {
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'm',
      startKeyframeId: 'i',
      audioAssetId: 'a',
      tts: { voiceId: 'v', text: 't' },
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/audioAssetId OR tts/);
  });
});

describe('Polish-21: pollHedraGeneration + normalizeHedraStatus', () => {
  it('processing status keeps ok=true with no downloadUrl', async () => {
    captureFetch({ status: 200, body: { status: 'processing' } });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('processing');
    expect(r.downloadUrl).toBeUndefined();
  });

  it('complete status returns downloadUrl + assetId', async () => {
    captureFetch({
      status: 200,
      body: {
        status: 'complete',
        download_url: 'https://cdn.hedra.com/output.mp4',
        asset_id: 'out-1',
      },
    });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.status).toBe('complete');
    expect(r.downloadUrl).toBe('https://cdn.hedra.com/output.mp4');
    expect(r.assetId).toBe('out-1');
  });

  it('complete status falls back to `url` field when `download_url` is missing (ComfyUI-shape response)', async () => {
    captureFetch({
      status: 200,
      body: { status: 'complete', url: 'https://cdn.hedra.com/x.mp4' },
    });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.downloadUrl).toBe('https://cdn.hedra.com/x.mp4');
  });

  it('error status surfaces error_message', async () => {
    captureFetch({
      status: 200,
      body: { status: 'error', error_message: 'lipsync failed' },
    });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toMatch(/lipsync failed/);
  });

  it('normalizeHedraStatus handles case + synonyms', async () => {
    const { normalizeHedraStatus } = await import('../src/hedra-video');
    expect(normalizeHedraStatus('complete')).toBe('complete');
    expect(normalizeHedraStatus('COMPLETED')).toBe('complete');
    expect(normalizeHedraStatus('failed')).toBe('error');
    expect(normalizeHedraStatus('running')).toBe('processing');
    expect(normalizeHedraStatus('in_progress')).toBe('processing');
    expect(normalizeHedraStatus('queued')).toBe('queued');
    expect(normalizeHedraStatus('pending')).toBe('pending');
    expect(normalizeHedraStatus('mystery')).toBeUndefined();
    expect(normalizeHedraStatus(null)).toBeUndefined();
    expect(normalizeHedraStatus(42)).toBeUndefined();
  });
});

describe('Polish-21: verifyHedraKey', () => {
  it('200 from GET /voices → ok', async () => {
    captureFetch({ status: 200, body: [] });
    const { verifyHedraKey } = await import('../src/hedra-video');
    const r = await verifyHedraKey('k');
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ method: 'api', statusCode: 200 });
  });

  it('401 → not ok with a clean reason string', async () => {
    captureFetch({ status: 401, body: { message: 'invalid api key' } });
    const { verifyHedraKey } = await import('../src/hedra-video');
    const r = await verifyHedraKey('k');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.method).toBe('api');
      expect(r.statusCode).toBe(401);
      expect(r.reason).toMatch(/invalid api key/);
    }
  });
});

describe('Polish-21: translateHedraErrorStatus branches', () => {
  it('surfaces top-up guidance on 402', async () => {
    const { translateHedraErrorStatus } = await import('../src/hedra-video');
    expect(translateHedraErrorStatus(402, undefined)).toMatch(/hedra.com\/api-profile/);
  });

  it('surfaces plan-access guidance on 403', async () => {
    const { translateHedraErrorStatus } = await import('../src/hedra-video');
    expect(translateHedraErrorStatus(403, undefined)).toMatch(/plan/);
  });

  it('surfaces rate-limit guidance on 429', async () => {
    const { translateHedraErrorStatus } = await import('../src/hedra-video');
    expect(translateHedraErrorStatus(429, undefined)).toMatch(/rate limit/);
  });

  it('preserves upstream fallback text on 5xx', async () => {
    const { translateHedraErrorStatus } = await import('../src/hedra-video');
    expect(translateHedraErrorStatus(503, 'gateway down')).toMatch(/gateway down/);
  });
});
