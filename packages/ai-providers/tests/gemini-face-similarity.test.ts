/**
 * Polish-12.8 v2: anti-celebrity Nano Banana pre-validation.
 *
 * parseFaceSimilarityScore is a pure helper covering Gemini's
 * response-shape variations. rateGeminiFaceSimilarity is exercised
 * via a stubbed fetch that drives both the image-download leg and
 * the Gemini Vision generateContent leg.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFaceSimilarityScore, rateGeminiFaceSimilarity } from '../src/gemini-client';

vi.mock('@mbb/db', () => ({
  logAiProviderApiCall: vi.fn().mockResolvedValue(undefined),
}));

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('Polish-12.8 v2: parseFaceSimilarityScore', () => {
  it('parses a bare single-digit response', () => {
    expect(parseFaceSimilarityScore('3')).toBe(3);
    expect(parseFaceSimilarityScore('0')).toBe(0);
    expect(parseFaceSimilarityScore('9')).toBe(9);
  });

  it('parses 10 as a special two-digit token', () => {
    expect(parseFaceSimilarityScore('10')).toBe(10);
  });

  it('extracts the first digit from a verbose response that ignored the "ONLY the number" instruction', () => {
    expect(parseFaceSimilarityScore('Score: 7')).toBe(7);
    expect(parseFaceSimilarityScore('I would rate this a 4 out of 10.')).toBe(4);
    expect(parseFaceSimilarityScore('**5**')).toBe(5);
  });

  it('returns undefined for non-numeric / empty responses', () => {
    expect(parseFaceSimilarityScore(null)).toBeUndefined();
    expect(parseFaceSimilarityScore(undefined)).toBeUndefined();
    expect(parseFaceSimilarityScore('')).toBeUndefined();
    expect(parseFaceSimilarityScore('unknown')).toBeUndefined();
  });

  it('rejects bare out-of-range tokens (\\b anchoring keeps "11"/"99" from quietly clamping)', () => {
    // Both digits inside "11" / "99" are word chars with no
    // surrounding boundary, so the alternation fails outright and
    // we return undefined — the validator-failure path is safer
    // than silently scoring a malformed response.
    expect(parseFaceSimilarityScore('11')).toBeUndefined();
    expect(parseFaceSimilarityScore('99')).toBeUndefined();
    // But when the prose IS bounded ("score: 7 (out of 11)"), the
    // first in-range token still parses cleanly.
    expect(parseFaceSimilarityScore('score: 7 out of 11')).toBe(7);
  });
});

describe('Polish-12.8 v2: rateGeminiFaceSimilarity', () => {
  function stubImageThenScore(scoreText: string) {
    // Returns the bytes of a fake image on the first fetch (the image
    // download leg), then the Gemini generateContent response on the
    // second fetch. Order matters because rateGeminiFaceSimilarity
    // fetches the image first.
    let call = 0;
    globalThis.fetch = vi.fn(async (urlOrInput: unknown) => {
      call++;
      if (call === 1) {
        // Image download leg.
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]).buffer, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      // Gemini generateContent leg.
      void urlOrInput;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: scoreText }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
  }

  it('returns the parsed score on success', async () => {
    stubImageThenScore('3');
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
    });
    expect(r.ok).toBe(true);
    expect(r.similarityScore).toBe(3);
    expect(r.rawResponse).toBe('3');
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('returns the parsed score for the 10 edge case', async () => {
    stubImageThenScore('10');
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
    });
    expect(r.similarityScore).toBe(10);
  });

  it('returns ok=false when the image fetch errors out', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('', { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/missing.png',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Failed to fetch face image/);
  });

  it('returns ok=false when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof globalThis.fetch;
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Face image fetch failed/);
    expect(r.errorMessage).toMatch(/ECONNRESET/);
  });

  it('returns ok=false when the Gemini response is unparseable as a score', async () => {
    stubImageThenScore('I cannot evaluate this image.');
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Could not parse similarity score/);
    expect(r.rawResponse).toBe('I cannot evaluate this image.');
  });

  it('still surfaces costUsd from the API call even when parsing fails', async () => {
    stubImageThenScore('not a number');
    const r = await rateGeminiFaceSimilarity({
      userId: 'u',
      apiKey: 'k',
      imageUrl: 'https://supa/ref.png',
    });
    expect(r.ok).toBe(false);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });
});
