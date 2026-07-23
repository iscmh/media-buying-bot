import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE,
  OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE,
  OPENAI_IMAGE_DEFAULT_MODEL,
  OpenaiContentPolicyError,
  OpenaiInsufficientFundsError,
  OpenaiInvalidImageError,
  OpenaiRateLimitError,
  estimateOpenaiImageCostUsd,
  isOpenaiTransientError,
  redactOpenaiApiKey,
  submitOpenaiImageGeneration,
} from '../src/openai-image-client';

/**
 * Polish-25.3 Commit 18b: OpenAI image-gen client regression pins.
 * Covers request-shape correctness for both endpoints, response
 * parsing, cost estimation across quality tiers, typed-error
 * classification, and log-safe key redaction.
 */

interface Captured {
  url: string;
  init: RequestInit;
  bodyText?: string;
  bodyJson?: Record<string, unknown>;
  isMultipart?: boolean;
}

function mockFetchOnce(response: {
  status?: number;
  body: object;
  contentType?: string;
}): Captured {
  const captured: Captured = { url: '', init: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      const body = init.body;
      if (body instanceof FormData) {
        captured.isMultipart = true;
      } else if (typeof body === 'string') {
        captured.bodyText = body;
        try {
          captured.bodyJson = JSON.parse(body);
        } catch {
          // non-JSON body — leave bodyJson unset
        }
      }
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { 'content-type': response.contentType ?? 'application/json' },
      });
    }),
  );
  return captured;
}

const B64_PNG = Buffer.from('fake-png-bytes').toString('base64');
const OK_RESPONSE = {
  created: 1234567890,
  data: [{ b64_json: B64_PNG }],
};

describe('OpenAI image-gen — request shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses /v1/images/generations when no reference image is supplied', async () => {
    const captured = mockFetchOnce({ body: OK_RESPONSE });
    const result = await submitOpenaiImageGeneration({
      apiKey: 'sk-test',
      prompt: 'a cinematic ad',
      quality: 'medium',
    });
    expect(result.ok).toBe(true);
    expect(captured.url).toBe('https://api.openai.com/v1/images/generations');
    expect(captured.bodyJson).toMatchObject({
      model: OPENAI_IMAGE_DEFAULT_MODEL,
      prompt: 'a cinematic ad',
      n: 1,
      size: '1024x1024',
      quality: 'medium',
    });
  });

  it('uses /v1/images/edits with multipart body when reference image supplied', async () => {
    const captured = mockFetchOnce({ body: OK_RESPONSE });
    await submitOpenaiImageGeneration({
      apiKey: 'sk-test',
      prompt: 'edit overlay',
      quality: 'high',
      referenceImageBase64: B64_PNG,
      referenceImageMimeType: 'image/png',
    });
    expect(captured.url).toBe('https://api.openai.com/v1/images/edits');
    expect(captured.isMultipart).toBe(true);
  });

  it('sends Bearer <apiKey> in Authorization header', async () => {
    const captured = mockFetchOnce({ body: OK_RESPONSE });
    await submitOpenaiImageGeneration({
      apiKey: 'sk-proj-abcdef',
      prompt: 'x',
    });
    const headers = captured.init.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer sk-proj-abcdef');
  });

  it('defaults quality to medium + size to 1024x1024 when unspecified', async () => {
    const captured = mockFetchOnce({ body: OK_RESPONSE });
    await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'p' });
    expect(captured.bodyJson).toMatchObject({ quality: 'medium', size: '1024x1024' });
  });
});

describe('OpenAI image-gen — response parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns imageBase64 + imageMimeType on 200 OK', async () => {
    mockFetchOnce({ body: OK_RESPONSE });
    const r = await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(r.imageBase64).toBe(B64_PNG);
    expect(r.imageMimeType).toBe('image/png');
  });

  it('surfaces revised_prompt when OpenAI rewrites the prompt', async () => {
    mockFetchOnce({
      body: {
        data: [{ b64_json: B64_PNG, revised_prompt: 'a sanitized prompt' }],
      },
    });
    const r = await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'p' });
    expect(r.revisedPrompt).toBe('a sanitized prompt');
  });

  it('returns ok=false when data[0].b64_json is missing', async () => {
    mockFetchOnce({ body: { data: [{}] } });
    const r = await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/b64_json/);
  });

  it('returns ok=false on non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 })),
    );
    const r = await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/non-JSON/);
  });
});

describe('OpenAI image-gen — typed error classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws OpenaiContentPolicyError on moderation code', async () => {
    mockFetchOnce({
      status: 400,
      body: {
        error: { code: 'content_policy_violation', message: 'safety system blocked this' },
      },
    });
    await expect(
      submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'bad' }),
    ).rejects.toBeInstanceOf(OpenaiContentPolicyError);
  });

  it('throws OpenaiInsufficientFundsError on insufficient_quota', async () => {
    mockFetchOnce({
      status: 429,
      body: {
        error: { code: 'insufficient_quota', message: 'You have exceeded your quota' },
      },
    });
    await expect(
      submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'x' }),
    ).rejects.toBeInstanceOf(OpenaiInsufficientFundsError);
  });

  it('throws OpenaiInvalidImageError when reference image rejected', async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { code: 'invalid_image', message: 'invalid image format' } },
    });
    await expect(
      submitOpenaiImageGeneration({
        apiKey: 'sk-x',
        prompt: 'x',
        referenceImageBase64: B64_PNG,
        referenceImageMimeType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(OpenaiInvalidImageError);
  });

  it('throws OpenaiRateLimitError on 429 without insufficient_quota code', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'Rate limit' } },
    });
    await expect(
      submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'x' }),
    ).rejects.toBeInstanceOf(OpenaiRateLimitError);
  });

  it('returns ok=false for other 4xx (falls through — worker classifies)', async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { code: 'other_error', message: 'something else' } },
    });
    const r = await submitOpenaiImageGeneration({ apiKey: 'sk-x', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(400);
    expect(r.errorMessage).toMatch(/other_error|something else/);
  });
});

describe('OpenAI image-gen — cost estimation', () => {
  it('pins per-quality cost at 1024x1024', () => {
    expect(estimateOpenaiImageCostUsd({ quality: 'high' })).toBe(
      OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE,
    );
    expect(estimateOpenaiImageCostUsd({ quality: 'medium' })).toBe(
      OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE,
    );
    expect(estimateOpenaiImageCostUsd({ quality: 'low' })).toBe(
      OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE,
    );
  });

  it('applies 1.5x multiplier for non-square sizes', () => {
    expect(estimateOpenaiImageCostUsd({ quality: 'medium', size: '1024x1536' })).toBe(
      round4(OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE * 1.5),
    );
    expect(estimateOpenaiImageCostUsd({ quality: 'medium', size: '1536x1024' })).toBe(
      round4(OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE * 1.5),
    );
  });

  it('has-a-price relationships: low < medium < high', () => {
    expect(OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE).toBeLessThan(
      OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE,
    );
    expect(OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE).toBeLessThan(
      OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE,
    );
  });
});

describe('OpenAI image-gen — helpers', () => {
  it('redacts the api key to sk-…{last4}', () => {
    expect(redactOpenaiApiKey('sk-proj-abcdefghijklmnop')).toBe('sk-…mnop');
    expect(redactOpenaiApiKey('sk-x')).toBe('sk-…');
    expect(redactOpenaiApiKey('')).toBe('(empty)');
  });

  it('isOpenaiTransientError catches rate-limit + network errors', () => {
    expect(isOpenaiTransientError(new OpenaiRateLimitError('x', 429))).toBe(true);
    expect(isOpenaiTransientError(new Error('request timeout'))).toBe(true);
    expect(isOpenaiTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isOpenaiTransientError(new OpenaiContentPolicyError('x', 400))).toBe(false);
    expect(isOpenaiTransientError(new Error('some other error'))).toBe(false);
  });
});

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
