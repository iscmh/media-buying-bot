/**
 * Polish-19.0.1: regression tests for the truncation-detect-and-retry
 * path. The bug pattern was: long UGC sources made Gemini blow past
 * its silent default maxOutputTokens (~8192), truncating the response
 * mid-JSON-string. tryParseGeminiJson then failed with an unhelpful
 * "not parseable as JSON" error.
 *
 * Coverage:
 *   1. isGeminiVisionTruncated decision branches.
 *   2. clampGeminiOutputTokens clamp bounds.
 *   3. callGeminiVision retries with doubled cap when first attempt
 *      truncates; uses the second attempt's result.
 *   4. callGeminiVision does NOT retry when the cap is already at the
 *      hard ceiling.
 *   5. The buildVisionBody now wires maxOutputTokens into
 *      generationConfig (verified via captured request body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('Polish-19.0.1: isGeminiVisionTruncated', () => {
  it('returns true when finishReason is MAX_TOKENS (authoritative signal)', async () => {
    const { isGeminiVisionTruncated } = await import('../src/gemini-client');
    expect(
      isGeminiVisionTruncated({
        finishReason: 'MAX_TOKENS',
        candidatesTokenCount: 100,
        maxOutputTokens: 16384,
      }),
    ).toBe(true);
  });

  it('returns true when candidatesTokenCount is within 95% of cap (fallback)', async () => {
    const { isGeminiVisionTruncated } = await import('../src/gemini-client');
    expect(
      isGeminiVisionTruncated({
        finishReason: 'STOP',
        candidatesTokenCount: 15600, // 95.2% of 16384
        maxOutputTokens: 16384,
      }),
    ).toBe(true);
  });

  it('returns false for normal-length finishReason=STOP responses', async () => {
    const { isGeminiVisionTruncated } = await import('../src/gemini-client');
    expect(
      isGeminiVisionTruncated({
        finishReason: 'STOP',
        candidatesTokenCount: 4000, // well under 95% of 16384
        maxOutputTokens: 16384,
      }),
    ).toBe(false);
  });

  it('returns false when finishReason and token count are both missing', async () => {
    const { isGeminiVisionTruncated } = await import('../src/gemini-client');
    expect(
      isGeminiVisionTruncated({
        finishReason: null,
        candidatesTokenCount: null,
        maxOutputTokens: 16384,
      }),
    ).toBe(false);
  });

  it('returns true on the boundary case (token count exactly at 95% of cap)', async () => {
    const { isGeminiVisionTruncated } = await import('../src/gemini-client');
    expect(
      isGeminiVisionTruncated({
        finishReason: 'STOP',
        candidatesTokenCount: 9728, // exactly 95% of 10240
        maxOutputTokens: 10240,
      }),
    ).toBe(true);
  });
});

describe('Polish-19.0.1: clampGeminiOutputTokens', () => {
  it('clamps values above the hard ceiling (65536) down to it', async () => {
    const { clampGeminiOutputTokens } = await import('../src/gemini-client');
    expect(clampGeminiOutputTokens(100_000)).toBe(65_536);
    expect(clampGeminiOutputTokens(999_999)).toBe(65_536);
  });

  it('returns the default for non-positive / NaN / Infinity input', async () => {
    const { clampGeminiOutputTokens, GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS } =
      await import('../src/gemini-client');
    expect(clampGeminiOutputTokens(0)).toBe(GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(clampGeminiOutputTokens(-1)).toBe(GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(clampGeminiOutputTokens(NaN)).toBe(GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(clampGeminiOutputTokens(Infinity)).toBe(GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('passes mid-range values through, floored', async () => {
    const { clampGeminiOutputTokens } = await import('../src/gemini-client');
    expect(clampGeminiOutputTokens(16_384)).toBe(16_384);
    expect(clampGeminiOutputTokens(32_768)).toBe(32_768);
    expect(clampGeminiOutputTokens(8_192.6)).toBe(8_192);
  });
});

/**
 * Helpers to mock Gemini's response shape. Returns a fetch that yields
 * either a fully-formed success body or a truncation-shaped body.
 */
function geminiSuccessBody(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: text.length / 4 },
  };
}
function geminiTruncatedBody(partialText: string, cap: number) {
  return {
    candidates: [{ content: { parts: [{ text: partialText }] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: cap },
  };
}

function setupVisionFetchSequence(responses: Array<{ status: number; body: unknown }>): {
  capturedBodies: unknown[];
} {
  const capturedBodies: unknown[] = [];
  let attempt = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.body) {
      try {
        capturedBodies.push(JSON.parse(init.body as string));
      } catch {
        capturedBodies.push(init.body);
      }
    }
    const r = responses[attempt] ?? responses[responses.length - 1]!;
    attempt += 1;
    return {
      status: r.status,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as typeof globalThis.fetch;
  return { capturedBodies };
}

describe('Polish-19.0.1: callGeminiVision retries on truncation', () => {
  it('retries with doubled cap when first attempt finishReason=MAX_TOKENS', async () => {
    const { capturedBodies } = setupVisionFetchSequence([
      { status: 200, body: geminiTruncatedBody('{"analysis":"partial...', 16_384) },
      { status: 200, body: geminiSuccessBody('{"analysis":"full"}') },
    ]);
    const { callGeminiVision } = await import('../src/gemini-client');
    const r = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: 'AAAA',
      videoMimeType: 'video/mp4',
    });
    expect(r.ok).toBe(true);
    expect(capturedBodies.length).toBe(2);
    const firstCap = (capturedBodies[0] as { generationConfig: { maxOutputTokens: number } })
      .generationConfig.maxOutputTokens;
    const secondCap = (capturedBodies[1] as { generationConfig: { maxOutputTokens: number } })
      .generationConfig.maxOutputTokens;
    expect(firstCap).toBe(16_384);
    expect(secondCap).toBe(32_768);
  });

  it('does NOT retry when the first attempt already used the hard ceiling', async () => {
    const { capturedBodies } = setupVisionFetchSequence([
      { status: 200, body: geminiTruncatedBody('{"analysis":"partial...', 65_536) },
      { status: 200, body: geminiSuccessBody('{"analysis":"full"}') }, // never reached
    ]);
    const { callGeminiVision, GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS } =
      await import('../src/gemini-client');
    const r = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: 'AAAA',
      videoMimeType: 'video/mp4',
      maxOutputTokens: GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS,
    });
    // Truncated response → parse fails → ok=false (no retry to "save" it).
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(capturedBodies.length).toBe(1);
  });

  it('does NOT retry when the first attempt parsed cleanly', async () => {
    const { capturedBodies } = setupVisionFetchSequence([
      { status: 200, body: geminiSuccessBody('{"analysis":"all good"}') },
    ]);
    const { callGeminiVision } = await import('../src/gemini-client');
    const r = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: 'AAAA',
      videoMimeType: 'video/mp4',
    });
    expect(r.ok).toBe(true);
    expect(capturedBodies.length).toBe(1);
  });

  it('threads the requested maxOutputTokens into generationConfig', async () => {
    const { capturedBodies } = setupVisionFetchSequence([
      { status: 200, body: geminiSuccessBody('{"analysis":"x"}') },
    ]);
    const { callGeminiVision } = await import('../src/gemini-client');
    await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: 'AAAA',
      videoMimeType: 'video/mp4',
      maxOutputTokens: 24_000,
    });
    expect(
      (capturedBodies[0] as { generationConfig: { maxOutputTokens: number } }).generationConfig
        .maxOutputTokens,
    ).toBe(24_000);
  });

  it('surfaces truncated=true on the returned result so callers can branch', async () => {
    setupVisionFetchSequence([
      { status: 200, body: geminiTruncatedBody('{"a":"truncated...', 65_536) },
      // No retry — already at hard ceiling
      { status: 200, body: geminiSuccessBody('{"a":"b"}') },
    ]);
    const { callGeminiVision, GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS } =
      await import('../src/gemini-client');
    const r = await callGeminiVision({
      userId: 'u',
      apiKey: 'k',
      systemPrompt: 'analyze',
      videoBase64: 'AAAA',
      videoMimeType: 'video/mp4',
      maxOutputTokens: GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS,
    });
    expect(r.truncated).toBe(true);
  });
});
