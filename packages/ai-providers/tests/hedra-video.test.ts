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
  it('audio_id mode: audio_id at top level, NO audio_generation (Polish-21.0.4 sole path)', async () => {
    // Polish-21.0.4 hotfix rewrite: Hedra native TTS
    // (audio_generation) is blocked on voice-UUID availability on
    // Creator plans. The client's sole audio path is now audio_id
    // pointing at an ElevenLabs-generated + Hedra-uploaded mp3.
    const calls = captureFetch({ status: 200, body: { id: 'gen-99' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'd1dd37a3-e39a-4854-a298-6510289f9cf2',
      startKeyframeId: 'img-1',
      audioAssetId: 'audio-asset-uuid-42',
      textPrompt: 'A 42-year-old woman in a parked SUV, tripod-style selfie framing.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
    });
    expect(r.ok).toBe(true);
    expect(r.generationId).toBe('gen-99');
    expect(calls[0]!.url).toBe('https://api.hedra.com/web-app/public/generations');
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(body.type).toBe('video');
    expect(body.ai_model_id).toBe('d1dd37a3-e39a-4854-a298-6510289f9cf2');
    expect(body.start_keyframe_id).toBe('img-1');
    // Regression pin: audio_id at TOP level, no audio_generation field.
    expect(body.audio_id).toBe('audio-asset-uuid-42');
    expect(body.audio_generation).toBeUndefined();
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.text_prompt).toBe(
      'A 42-year-old woman in a parked SUV, tripod-style selfie framing.',
    );
    expect(gvi.resolution).toBe('720p');
    expect(gvi.aspect_ratio).toBe('9:16');
    // Polish-21.0.3 hotfix: duration_ms is REQUIRED on the wire.
    expect(gvi.duration_ms).toBe(15_000);
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
      durationSeconds: 15,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    expect(body.audio_id).toBe('audio-2');
    expect(body.audio_generation).toBeUndefined();
  });

  it('duration_ms carries the passed durationSeconds × 1000 (rounded), seed passes through', async () => {
    // Polish-21.0.3 hotfix: durationSeconds is now REQUIRED and
    // duration_ms is ALWAYS on the wire. See the dedicated
    // Polish-21.0.3 describe block below for full clamp coverage.
    captureFetch({ status: 200, body: { id: 'gen-101' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'm',
      startKeyframeId: 'i',
      audioAssetId: 'audio-asset-1',
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

  it('rejects when audioAssetId is empty (Polish-21.0.4 native-TTS path removed)', async () => {
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k',
      aiModelId: 'm',
      startKeyframeId: 'i',
      audioAssetId: '',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
    });
    expect(r.ok).toBe(false);
    // Regression pin: fail-fast error names both the missing field
    // and the pivot away from Hedra native TTS.
    expect(r.errorMessage).toMatch(/audioAssetId/);
    expect(r.errorMessage).toMatch(/ElevenLabs/);
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
      audioAssetId: 'audio-asset-1',
      textPrompt: 'A scene description.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
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
      audioAssetId: 'audio-asset-1',
      textPrompt: 'Kitchen selfie, morning light.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
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

  it('audio_id TOP LEVEL (not nested in generated_video_inputs); NO audio_generation field', async () => {
    // Polish-21.0.4 hotfix: rewritten from the audio_generation
    // shape pin. The Hedra-native-TTS audio_generation path is gone
    // — the sole audio route is audio_id pointing at an uploaded
    // asset (ElevenLabs mp3 mirrored to Hedra).
    captureFetch({ status: 200, body: { id: 'gen-3' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-uuid-xyz',
      textPrompt: 'Scene.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as Record<string, unknown>;
    // Pin: audio_id at TOP level, not nested.
    expect(body.audio_id).toBe('audio-asset-uuid-xyz');
    // Regression pin: audio_generation field REMOVED entirely.
    expect(body.audio_generation).toBeUndefined();
    const gvi = body.generated_video_inputs as Record<string, unknown>;
    expect(gvi.audio_id).toBeUndefined();
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
      audioAssetId: 'audio-asset-1',
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
      audioAssetId: 'audio-asset-1',
      textPrompt: 'Scene.',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
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

// =====================================================================
// Polish-21.0.3 hotfix regression pins:
//   - duration_ms is ALWAYS on the wire (Hedra returns 422 without it)
//   - duration_ms clamped to [1000, 90000] ms
//   - default 15000 ms when caller passes 0 / NaN / negative
//   - FastAPI-shaped 422 `detail: [{loc, msg}]` errors surface field
//     path + message verbatim (not swallowed into a generic 422)
// =====================================================================

describe('Polish-21.0.3: submit body ALWAYS carries duration_ms', () => {
  it('duration_ms is present at the same 30s call from Commit 1 (baseline check)', async () => {
    captureFetch({ status: 200, body: { id: 'g' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-1',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 30,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as { generated_video_inputs: Record<string, unknown> };
    expect(body.generated_video_inputs.duration_ms).toBe(30_000);
    expect(typeof body.generated_video_inputs.duration_ms).toBe('number');
    // Regression pin: integer, not float.
    expect(Number.isInteger(body.generated_video_inputs.duration_ms)).toBe(true);
  });

  it('durationSeconds=0 → duration_ms defaults to 15000 (Polish-21.0.3 safe default)', async () => {
    captureFetch({ status: 200, body: { id: 'g' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-1',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 0,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as { generated_video_inputs: Record<string, unknown> };
    expect(body.generated_video_inputs.duration_ms).toBe(15_000);
  });

  it('durationSeconds=NaN / negative / non-finite → 15000 default (Infinity is non-finite, not "very large")', async () => {
    const { clampHedraDurationMs } = await import('../src/hedra-video');
    expect(clampHedraDurationMs(NaN)).toBe(15_000);
    expect(clampHedraDurationMs(-3)).toBe(15_000);
    // Regression pin: Infinity is Number.isFinite === false so it
    // falls to the default, NOT clamped to max. Guards against a
    // future defensive check that treats Infinity as "clamp to max"
    // — that would mask a real caller-side bug.
    expect(clampHedraDurationMs(Infinity)).toBe(15_000);
    expect(clampHedraDurationMs(-Infinity)).toBe(15_000);
  });

  it('durationSeconds > 90 → clamped to 90000 ms (Hedra Character 3 hard cap)', async () => {
    captureFetch({ status: 200, body: { id: 'g' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-1',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 500,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as { generated_video_inputs: Record<string, unknown> };
    expect(body.generated_video_inputs.duration_ms).toBe(90_000);
  });

  it('durationSeconds < 1s → clamped to 1000 ms floor', async () => {
    captureFetch({ status: 200, body: { id: 'g' } });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-1',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 0.5,
    });
    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit)
        .body as string,
    ) as { generated_video_inputs: Record<string, unknown> };
    expect(body.generated_video_inputs.duration_ms).toBe(1_000);
  });

  it('exported duration constants match the clamp behavior (public contract)', async () => {
    const { HEDRA_DEFAULT_DURATION_MS, HEDRA_MIN_DURATION_MS, HEDRA_MAX_DURATION_MS } =
      await import('../src/hedra-video');
    expect(HEDRA_DEFAULT_DURATION_MS).toBe(15_000);
    expect(HEDRA_MIN_DURATION_MS).toBe(1_000);
    expect(HEDRA_MAX_DURATION_MS).toBe(90_000);
  });
});

describe('Polish-21.0.3: renderFastApiDetail + extractHedraErrorMessage on 422', () => {
  it('renders the exact job-2026-07-03 duration_ms failure shape verbatim', async () => {
    const { renderFastApiDetail } = await import('../src/hedra-video');
    // Actual Hedra response body captured by operator:
    const detail = [
      {
        type: 'missing',
        loc: ['body', 'generated_video_inputs', 'duration_ms'],
        msg: 'Field required',
      },
    ];
    const r = renderFastApiDetail(detail);
    expect(r).toBe('missing at body.generated_video_inputs.duration_ms: Field required');
  });

  it('joins multiple detail entries with " | " (multi-field errors)', async () => {
    const { renderFastApiDetail } = await import('../src/hedra-video');
    const detail = [
      { type: 'missing', loc: ['body', 'x'], msg: 'X required' },
      { type: 'string_type', loc: ['body', 'y'], msg: 'Not a string' },
    ];
    expect(renderFastApiDetail(detail)).toBe(
      'missing at body.x: X required | string_type at body.y: Not a string',
    );
  });

  it('gracefully omits type when missing, still renders loc + msg', async () => {
    const { renderFastApiDetail } = await import('../src/hedra-video');
    expect(renderFastApiDetail([{ loc: ['a', 'b'], msg: 'nope' }])).toBe('a.b: nope');
  });

  it('returns undefined on empty / shape-mismatched arrays (extractor falls through)', async () => {
    const { renderFastApiDetail } = await import('../src/hedra-video');
    expect(renderFastApiDetail([])).toBeUndefined();
    expect(renderFastApiDetail([null, undefined, 'string'])).toBeUndefined();
  });

  it('extractHedraErrorMessage surfaces the array-detail path for FastAPI-shape 422 bodies', async () => {
    const { extractHedraErrorMessage } = await import('../src/hedra-video');
    const body = {
      detail: [
        {
          type: 'missing',
          loc: ['body', 'generated_video_inputs', 'duration_ms'],
          msg: 'Field required',
        },
      ],
    };
    const r = extractHedraErrorMessage(body);
    // Regression pin: the field path is IN the message.
    expect(r).toMatch(/duration_ms/);
    expect(r).toMatch(/Field required/);
  });

  it('extractHedraErrorMessage still handles the string-detail path (Hedra 5xx sometimes returns string detail)', async () => {
    const { extractHedraErrorMessage } = await import('../src/hedra-video');
    expect(extractHedraErrorMessage({ detail: 'plain string message' })).toBe(
      'plain string message',
    );
  });
});

describe('Polish-21.0.3: 422 responses surface Hedra field-level detail (not just status)', () => {
  it('submitHedraGeneration on 422 with FastAPI detail array returns errorMessage containing the field path', async () => {
    captureFetch({
      status: 422,
      body: {
        detail: [
          {
            type: 'missing',
            loc: ['body', 'generated_video_inputs', 'duration_ms'],
            msg: 'Field required',
          },
        ],
      },
    });
    const { submitHedraGeneration } = await import('../src/hedra-video');
    const r = await submitHedraGeneration({
      userId: 'u',
      apiKey: 'k1234567890abcd',
      aiModelId: 'ai',
      startKeyframeId: 'img',
      audioAssetId: 'audio-asset-1',
      textPrompt: 's',
      resolution: '720p',
      aspectRatio: '9:16',
      durationSeconds: 15,
    });
    expect(r.ok).toBe(false);
    // Polish-21.0.3 regression pin: the extracted message names the
    // failing field. Pre-hotfix the operator only saw the generic
    // translated 422 hint, losing the "duration_ms missing" signal.
    expect(r.errorMessage).toMatch(/duration_ms/);
    expect(r.errorMessage).toMatch(/Field required/);
  });
});

// Polish-21.0.3 worker regression pin lives in
// packages/jobs/tests/generate-video-variant-helpers.test.ts —
// direct file access to generate-video-variant.ts source is cleaner
// from that package than crossing package boundaries here.

// ===================================================================
// Polish-21.0.9: env-override resolvers for the three Hedra model UUIDs
// ===================================================================
//
// Mirrors the Polish-21.0.8 NANO_BANANA_MODEL_ID env-override pattern:
// env is read at CALL TIME so operators can rotate a Hedra model UUID
// via HEDRA_{CHARACTER_3,KLING_V2_STANDARD,KLING_V2_PRO}_MODEL_ID
// without a redeploy.

describe('Polish-21.0.9: getHedraCharacter3ModelId + env override', () => {
  const KEY = 'HEDRA_CHARACTER_3_MODEL_ID';
  const originalEnv = process.env[KEY];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[KEY];
    else process.env[KEY] = originalEnv;
  });

  it('defaults to d1dd37a3-… (Character 3 UUID verified from live GET /models)', async () => {
    delete process.env[KEY];
    const { getHedraCharacter3ModelId } = await import('../src/hedra-video');
    expect(getHedraCharacter3ModelId()).toBe('d1dd37a3-e39a-4854-a298-6510289f9cf2');
  });

  it('HEDRA_CHARACTER_3_MODEL_ID env override wins at call time (no restart needed)', async () => {
    process.env[KEY] = 'ffffffff-aaaa-bbbb-cccc-000000000001';
    const { getHedraCharacter3ModelId } = await import('../src/hedra-video');
    expect(getHedraCharacter3ModelId()).toBe('ffffffff-aaaa-bbbb-cccc-000000000001');
  });

  it('whitespace-only env override falls through to the default', async () => {
    process.env[KEY] = '   ';
    const { getHedraCharacter3ModelId } = await import('../src/hedra-video');
    expect(getHedraCharacter3ModelId()).toBe('d1dd37a3-e39a-4854-a298-6510289f9cf2');
  });
});

describe('Polish-21.0.9: getHedraKlingV2StandardModelId + env override', () => {
  const KEY = 'HEDRA_KLING_V2_STANDARD_MODEL_ID';
  const originalEnv = process.env[KEY];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[KEY];
    else process.env[KEY] = originalEnv;
  });

  it('defaults to d7eb3b2e-… (Kling v2 Standard UUID verified from live GET /models)', async () => {
    delete process.env[KEY];
    const { getHedraKlingV2StandardModelId } = await import('../src/hedra-video');
    expect(getHedraKlingV2StandardModelId()).toBe('d7eb3b2e-c8f8-45f9-83db-34f18dd0ba85');
  });

  it('HEDRA_KLING_V2_STANDARD_MODEL_ID env override wins at call time', async () => {
    process.env[KEY] = 'ffffffff-aaaa-bbbb-cccc-000000000002';
    const { getHedraKlingV2StandardModelId } = await import('../src/hedra-video');
    expect(getHedraKlingV2StandardModelId()).toBe('ffffffff-aaaa-bbbb-cccc-000000000002');
  });

  it('empty string falls through to the default', async () => {
    process.env[KEY] = '';
    const { getHedraKlingV2StandardModelId } = await import('../src/hedra-video');
    expect(getHedraKlingV2StandardModelId()).toBe('d7eb3b2e-c8f8-45f9-83db-34f18dd0ba85');
  });
});

describe('Polish-21.0.9: getHedraKlingV2ProModelId + env override', () => {
  const KEY = 'HEDRA_KLING_V2_PRO_MODEL_ID';
  const originalEnv = process.env[KEY];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[KEY];
    else process.env[KEY] = originalEnv;
  });

  it('defaults to 0451ceea-… (Kling v2 Pro UUID verified from live GET /models)', async () => {
    delete process.env[KEY];
    const { getHedraKlingV2ProModelId } = await import('../src/hedra-video');
    expect(getHedraKlingV2ProModelId()).toBe('0451ceea-a7b5-4275-a970-82bf4ef38055');
  });

  it('HEDRA_KLING_V2_PRO_MODEL_ID env override wins at call time', async () => {
    process.env[KEY] = 'ffffffff-aaaa-bbbb-cccc-000000000003';
    const { getHedraKlingV2ProModelId } = await import('../src/hedra-video');
    expect(getHedraKlingV2ProModelId()).toBe('ffffffff-aaaa-bbbb-cccc-000000000003');
  });
});

describe('Polish-21.0.9: resolveHedraModelIdForVideoModel dispatches by VideoModelId', () => {
  // Preserve every env key we might touch.
  const KEYS = [
    'HEDRA_CHARACTER_3_MODEL_ID',
    'HEDRA_KLING_V2_STANDARD_MODEL_ID',
    'HEDRA_KLING_V2_PRO_MODEL_ID',
  ] as const;
  const originalEnv: Record<string, string | undefined> = Object.fromEntries(
    KEYS.map((k) => [k, process.env[k]]),
  );
  afterEach(() => {
    for (const k of KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k]!;
    }
  });

  it('routes hedra_character_3 → getHedraCharacter3ModelId (env or default)', async () => {
    process.env['HEDRA_CHARACTER_3_MODEL_ID'] = 'char3-override';
    const { resolveHedraModelIdForVideoModel } = await import('../src/hedra-video');
    expect(resolveHedraModelIdForVideoModel('hedra_character_3', 'descriptor-fallback')).toBe(
      'char3-override',
    );
  });

  it('routes hedra_kling_avatar_v2_standard → getHedraKlingV2StandardModelId', async () => {
    process.env['HEDRA_KLING_V2_STANDARD_MODEL_ID'] = 'kling-std-override';
    const { resolveHedraModelIdForVideoModel } = await import('../src/hedra-video');
    expect(
      resolveHedraModelIdForVideoModel('hedra_kling_avatar_v2_standard', 'descriptor-fallback'),
    ).toBe('kling-std-override');
  });

  it('routes hedra_kling_avatar_v2_pro → getHedraKlingV2ProModelId', async () => {
    process.env['HEDRA_KLING_V2_PRO_MODEL_ID'] = 'kling-pro-override';
    const { resolveHedraModelIdForVideoModel } = await import('../src/hedra-video');
    expect(
      resolveHedraModelIdForVideoModel('hedra_kling_avatar_v2_pro', 'descriptor-fallback'),
    ).toBe('kling-pro-override');
  });

  it('unknown / non-Hedra videoModelId → returns descriptorDefault untouched (defensive fallback)', async () => {
    const { resolveHedraModelIdForVideoModel } = await import('../src/hedra-video');
    expect(resolveHedraModelIdForVideoModel('seedance_1_5_pro', 'descriptor-fallback')).toBe(
      'descriptor-fallback',
    );
    expect(resolveHedraModelIdForVideoModel('nope', 'descriptor-fallback')).toBe(
      'descriptor-fallback',
    );
  });

  it('no env set → each Hedra model resolves to its verified default UUID', async () => {
    for (const k of KEYS) delete process.env[k];
    const { resolveHedraModelIdForVideoModel } = await import('../src/hedra-video');
    expect(resolveHedraModelIdForVideoModel('hedra_character_3', 'ignored')).toBe(
      'd1dd37a3-e39a-4854-a298-6510289f9cf2',
    );
    expect(resolveHedraModelIdForVideoModel('hedra_kling_avatar_v2_standard', 'ignored')).toBe(
      'd7eb3b2e-c8f8-45f9-83db-34f18dd0ba85',
    );
    expect(resolveHedraModelIdForVideoModel('hedra_kling_avatar_v2_pro', 'ignored')).toBe(
      '0451ceea-a7b5-4275-a970-82bf4ef38055',
    );
  });
});
