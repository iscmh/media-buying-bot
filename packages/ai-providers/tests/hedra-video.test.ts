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

// =====================================================================
// Polish-21.0.2 hotfix regression pins (job 1db50a7c diagnostic):
//   - submit body byte-exact against hedra-labs/hedra-api-starter
//   - lowercase `x-api-key` auth header on every Hedra call
//   - URL construction pinned against starter's session base + path
//   - normalizeHedraStatus handles `finalizing` (new status per docs)
//   - poll 404 surfaces as `notFound: true` for worker to retry
// =====================================================================

describe('Polish-21.0.2: submit body byte-exact match against hedra-labs/hedra-api-starter', () => {
  /**
   * Reference: hedra-labs/hedra-api-starter/main.py, line ~176-196.
   * The Python starter builds this exact request shape:
   *
   *   {
   *     "type": "video",
   *     "ai_model_id": model_id,
   *     "start_keyframe_id": image_id,
   *     "generated_video_inputs": {
   *       "text_prompt": args.text_prompt,
   *       "resolution": args.resolution,
   *       "aspect_ratio": args.aspect_ratio,
   *     },
   *   }
   *   generation_request_data["audio_generation"] = {
   *     "type": "text_to_speech",
   *     "voice_id": args.voice_id,
   *     "text": args.voice_text,
   *   }
   *
   * Job 1db50a7c returned 404 from POST /generations. This describe
   * block pins every field at the correct nesting level so a future
   * refactor that flattens / re-nests keys can't silently drift
   * from the starter.
   */
  it('type=video, ai_model_id, start_keyframe_id at TOP LEVEL (not nested in generated_video_inputs)', async () => {
    captureFetch({ status: 200, body: { id: 'gen-1' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'd1dd37a3-e39a-4854-a298-6510289f9cf2',
      startKeyframeId: 'img-uuid',
      tts: { voiceId: 'voice-uuid', text: 'hello' },
      textPrompt: 'A scene description.',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    expect(body.type).toBe('video');
    expect(body.ai_model_id).toBe('d1dd37a3-e39a-4854-a298-6510289f9cf2');
    expect(body.start_keyframe_id).toBe('img-uuid');
    // Pin: NOT nested under generated_video_inputs.
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.type).toBeUndefined();
    expect(gvi.ai_model_id).toBeUndefined();
    expect(gvi.start_keyframe_id).toBeUndefined();
  });

  it('text_prompt, resolution, aspect_ratio NESTED inside generated_video_inputs (not top-level)', async () => {
    captureFetch({ status: 200, body: { id: 'gen-2' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      tts: { voiceId: 'v', text: 't' },
      textPrompt: 'Kitchen selfie, morning light.',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.text_prompt).toBe('Kitchen selfie, morning light.');
    expect(gvi.resolution).toBe('720p');
    expect(gvi.aspect_ratio).toBe('9:16');
    // Pin: text_prompt / resolution / aspect_ratio NOT at top level.
    expect(body.text_prompt).toBeUndefined();
    expect(body.resolution).toBeUndefined();
    expect(body.aspect_ratio).toBeUndefined();
  });

  it('audio_generation TOP LEVEL with {type: "text_to_speech", voice_id, text} (not nested in generated_video_inputs)', async () => {
    captureFetch({ status: 200, body: { id: 'gen-3' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      tts: { voiceId: 'voice-uuid-xyz', text: 'I swear to god' },
      textPrompt: 'Scene.',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    // Pin: audio_generation at TOP level, not nested.
    expect(body.audio_generation).toEqual({
      type: 'text_to_speech',
      voice_id: 'voice-uuid-xyz',
      text: 'I swear to god',
    });
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.audio_generation).toBeUndefined();
    expect(gvi.voice_id).toBeUndefined();
  });

  it('duration_ms + seed NESTED inside generated_video_inputs (starter puts them there)', async () => {
    captureFetch({ status: 200, body: { id: 'gen-4' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      tts: { voiceId: 'v', text: 't' },
      textPrompt: 'Scene.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 30,
      seed: 42,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.duration_ms).toBe(30_000);
    expect(gvi.seed).toBe(42);
    // Pin: NOT at top level.
    expect(body.duration_ms).toBeUndefined();
    expect(body.seed).toBeUndefined();
  });
});

describe('Polish-21.0.2: URL + header regression pins', () => {
  it('POST /generations submit URL is exactly the starter path (base + "/generations")', async () => {
    const calls = captureFetch({ status: 200, body: { id: 'gen' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      tts: { voiceId: 'v', text: 't' },
      textPrompt: 'Scene.',
      resolution: '720p',
      aspectRatio: '9:16',
    });
    // Starter uses `session.post("/generations", ...)` where the
    // session base_url is "https://api.hedra.com/web-app/public".
    // Regression pin: NO extra segment (e.g. /v1/generations), NO
    // trailing slash, NO query params.
    expect(calls[0]!.url).toBe('https://api.hedra.com/web-app/public/generations');
  });

  it('every Hedra call sends the auth header as lowercase "x-api-key" (starter line 20)', async () => {
    captureFetch({ status: 200, body: { id: 'a' } });
    const { createHedraAsset } = await import('../src/hedra-video');
    await createHedraAsset({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      name: 'x.png',
      type: 'image',
    });
    const headers = (
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit
    ).headers as Record<string, string>;
    // Regression pin: lowercase key. The starter's requests.Session
    // uses `self.headers["x-api-key"] = api_key` — lowercase. Some
    // routing layers on Hedra's side may key on case even though
    // HTTP/1.1 spec is case-insensitive.
    expect(headers['x-api-key']).toBe('k1234567890abcd');
    // Pin the negative: NO capitalized variant leaking in.
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('buildHedraStatusUrl produces the exact starter path (base + /generations/{id}/status)', async () => {
    const { buildHedraStatusUrl } = await import('../src/hedra-video');
    // Starter line 204: `session.get(f"/generations/{generation_id}/status")`.
    // Also verified against hedra-labs/hedra-node Client.ts::getStatus
    // (Polish-21.0.2 investigation).
    expect(buildHedraStatusUrl('e8d574f0-1ee5-42c3-b3ff-7dd12d5cdd66')).toBe(
      'https://api.hedra.com/web-app/public/generations/e8d574f0-1ee5-42c3-b3ff-7dd12d5cdd66/status',
    );
  });
});

describe('Polish-21.0.2: normalizeHedraStatus handles finalizing (new docs status)', () => {
  it('finalizing normalizes to "finalizing" (was undefined pre-hotfix)', async () => {
    const { normalizeHedraStatus } = await import('../src/hedra-video');
    expect(normalizeHedraStatus('finalizing')).toBe('finalizing');
    expect(normalizeHedraStatus('FINALIZING')).toBe('finalizing');
  });
});

describe('Polish-21.0.2: pollHedraGeneration 404 handling', () => {
  it('surfaces 404 as { ok: false, notFound: true } (worker retries during initial window)', async () => {
    captureFetch({ status: 404, body: { detail: 'generation not found' } });
    const { pollHedraGeneration, __resetHedra404LogForTests } = await import('../src/hedra-video');
    __resetHedra404LogForTests();
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBe(true);
    // Non-404 errors keep the errorMessage translated path.
    expect(r.errorMessage).toBeUndefined();
  });

  it('non-404 errors still return { ok: false, errorMessage } (no notFound flag)', async () => {
    captureFetch({ status: 500, body: { detail: 'internal' } });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBeUndefined();
    expect(r.errorMessage).toMatch(/Hedra upstream error/);
  });

  it('surfaces progress on non-terminal responses when Hedra returns it', async () => {
    captureFetch({ status: 200, body: { status: 'processing', progress: 0.42 } });
    const { pollHedraGeneration } = await import('../src/hedra-video');
    const r = await pollHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      generationId: 'g',
    });
    expect(r.status).toBe('processing');
    expect(r.progress).toBe(0.42);
  });
});

describe('Polish-21.0.2: redactHedraApiKey', () => {
  it('redacts the middle of a normal API key, keeps prefix + suffix', async () => {
    const { redactHedraApiKey } = await import('../src/hedra-video');
    const r = redactHedraApiKey('hedra_1234567890abcdefghij');
    expect(r).toMatch(/^x-api-key:/);
    expect(r).toContain('hedr');
    expect(r).toContain('ghij');
    expect(r).not.toContain('1234567890abcdef');
  });

  it('handles short keys defensively', async () => {
    const { redactHedraApiKey } = await import('../src/hedra-video');
    expect(redactHedraApiKey('')).toBe('x-api-key:(short-key)');
    expect(redactHedraApiKey('short')).toBe('x-api-key:(short-key)');
  });
});
