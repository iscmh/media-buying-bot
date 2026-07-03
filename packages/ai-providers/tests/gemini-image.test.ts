import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_IMAGE_TEMPERATURE, callGeminiImage } from '../src/gemini-client';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetchOnce(responseBody: object): { captured: CapturedRequest } {
  const captured: CapturedRequest = { url: '', init: {}, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      captured.body = init.body ? JSON.parse(init.body as string) : {};
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { captured };
}

const GEMINI_IMAGE_OK = {
  candidates: [
    {
      content: {
        parts: [
          {
            inline_data: {
              mime_type: 'image/png',
              data: Buffer.from('png').toString('base64'),
            },
          },
        ],
      },
    },
  ],
};

describe('callGeminiImage — Phase 3d call shape', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stub.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends temperature 0.4 in generationConfig (anchor on reference, not invent)', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({
      userId: 'u',
      apiKey: 'k',
      prompt: 'edit this',
    });
    const config = (captured.body.generationConfig ?? {}) as Record<string, unknown>;
    expect(config.temperature).toBe(0.4);
    expect(GEMINI_IMAGE_TEMPERATURE).toBe(0.4);
  });

  it('declares responseModalities: ["Image"] for nano-banana', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({ userId: 'u', apiKey: 'k', prompt: 'p' });
    const config = (captured.body.generationConfig ?? {}) as Record<string, unknown>;
    expect(config.responseModalities).toEqual(['Image']);
  });

  it('includes systemInstruction when provided (Phase 3d edit framing)', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({
      userId: 'u',
      apiKey: 'k',
      prompt: 'p',
      systemInstruction: 'You are an image editor, not an image generator.',
    });
    const sys = captured.body.systemInstruction as { parts: Array<{ text: string }> } | undefined;
    expect(sys?.parts?.[0]?.text).toMatch(/image editor, not an image generator/);
  });

  it('omits systemInstruction when caller does not pass one (backward compat)', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(captured.body.systemInstruction).toBeUndefined();
  });

  it('puts the reference image part BEFORE the text part so the model anchors on it', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({
      userId: 'u',
      apiKey: 'k',
      prompt: 'edit this',
      referenceImageBase64: Buffer.from('img').toString('base64'),
      referenceImageMimeType: 'image/png',
    });
    const contents = captured.body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const parts = contents[0]?.parts ?? [];
    expect(parts[0]).toHaveProperty('inline_data');
    expect(parts[1]).toHaveProperty('text');
  });

  it('Polish-21.0.8: hits the Nano Banana 2 (gemini-3.1-flash-image) model endpoint by default', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({ userId: 'u', apiKey: 'k', prompt: 'p' });
    // Polish-21.0.8 hotfix: upgraded from Nano Banana Pro
    // (gemini-2.5-flash-image, plastic-face smart-downgrade
    // reports) to Nano Banana 2 (gemini-3.1-flash-image, better
    // character consistency + half the cost + ~3x faster).
    expect(captured.url).toMatch(/models\/gemini-3\.1-flash-image:generateContent/);
    // Regression pin: Pro model MUST NOT be the default anymore.
    expect(captured.url).not.toMatch(/models\/gemini-2\.5-flash-image:generateContent/);
  });
});

describe('Polish-21.0.8: getNanoBananaModelId + NANO_BANANA_MODEL_ID env override', () => {
  const originalEnv = process.env['NANO_BANANA_MODEL_ID'];
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['NANO_BANANA_MODEL_ID'];
    } else {
      process.env['NANO_BANANA_MODEL_ID'] = originalEnv;
    }
  });

  it('DEFAULT_NANO_BANANA_MODEL_ID is Nano Banana 2 (gemini-3.1-flash-image)', async () => {
    const { DEFAULT_NANO_BANANA_MODEL_ID } = await import('../src/gemini-client');
    expect(DEFAULT_NANO_BANANA_MODEL_ID).toBe('gemini-3.1-flash-image');
  });

  it('getNanoBananaModelId returns the default when NANO_BANANA_MODEL_ID env is unset', async () => {
    delete process.env['NANO_BANANA_MODEL_ID'];
    const { getNanoBananaModelId } = await import('../src/gemini-client');
    expect(getNanoBananaModelId()).toBe('gemini-3.1-flash-image');
  });

  it('NANO_BANANA_MODEL_ID env override threads through to the request URL (A/B testing without redeploy)', async () => {
    // Operator can flip back to Pro (`gemini-2.5-flash-image`) or
    // forward to a preview model without a code change.
    process.env['NANO_BANANA_MODEL_ID'] = 'gemini-2.5-flash-image';
    // Fresh import to pick up the env at module-load time isn't
    // needed — getNanoBananaModelId reads env at call time.
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(captured.url).toMatch(/models\/gemini-2\.5-flash-image:generateContent/);
  });

  it('empty / whitespace-only env override falls through to the default', async () => {
    process.env['NANO_BANANA_MODEL_ID'] = '   ';
    const { getNanoBananaModelId } = await import('../src/gemini-client');
    expect(getNanoBananaModelId()).toBe('gemini-3.1-flash-image');
  });
});
