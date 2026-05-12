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

  it('hits the gemini-2.5-flash-image model endpoint', async () => {
    const { captured } = mockFetchOnce(GEMINI_IMAGE_OK);
    await callGeminiImage({ userId: 'u', apiKey: 'k', prompt: 'p' });
    expect(captured.url).toMatch(/models\/gemini-2\.5-flash-image:generateContent/);
  });
});
