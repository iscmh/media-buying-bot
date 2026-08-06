import { afterEach, describe, expect, it } from 'vitest';
import {
  chunkArray,
  errorSignature,
  resolveHeygenAnalyzeChunkSize,
} from '../src/functions/refresh-heygen-avatar-index';

/**
 * Polish-26.0.4 Commit 61.4 tripwires. The three exported utilities
 * that gate the Vercel-Hobby-safe chunking behavior:
 *
 *   1. resolveHeygenAnalyzeChunkSize() must default to 12 (safely
 *      under Vercel Hobby's 60s per-invocation ceiling given
 *      Gemini-vision ~2-5s × concurrency 5).
 *   2. chunkArray() must split N items into ceil(N/size) chunks
 *      of at most `size`, preserving order.
 *   3. errorSignature() must normalize digits so
 *      "Gemini 500 Internal (req 123)" and
 *      "Gemini 500 Internal (req 456)" hash identically — that's
 *      what makes the cross-chunk circuit breaker actually catch
 *      1000 identical failures instead of resetting per-chunk.
 */

describe('resolveHeygenAnalyzeChunkSize', () => {
  const original = process.env['HEYGEN_ANALYZE_CHUNK_SIZE'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['HEYGEN_ANALYZE_CHUNK_SIZE'];
    } else {
      process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = original;
    }
  });

  it('defaults to 12 when env is unset', () => {
    delete process.env['HEYGEN_ANALYZE_CHUNK_SIZE'];
    expect(resolveHeygenAnalyzeChunkSize()).toBe(12);
  });

  it('honors a numeric env override (e.g. Vercel Pro tier bump to 100)', () => {
    process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = '100';
    expect(resolveHeygenAnalyzeChunkSize()).toBe(100);
  });

  it('falls back to default on non-numeric / zero / negative env', () => {
    process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = 'nope';
    expect(resolveHeygenAnalyzeChunkSize()).toBe(12);
    process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = '0';
    expect(resolveHeygenAnalyzeChunkSize()).toBe(12);
    process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = '-5';
    expect(resolveHeygenAnalyzeChunkSize()).toBe(12);
  });

  it('floors fractional overrides', () => {
    process.env['HEYGEN_ANALYZE_CHUNK_SIZE'] = '12.9';
    expect(resolveHeygenAnalyzeChunkSize()).toBe(12);
  });
});

describe('chunkArray', () => {
  it('splits 1264 avatars into 106 chunks at default size 12', () => {
    const items = Array.from({ length: 1264 }, (_, i) => i);
    const chunks = chunkArray(items, 12);
    expect(chunks.length).toBe(Math.ceil(1264 / 12));
    expect(chunks.length).toBe(106);
    // First 105 chunks are full, last is the remainder.
    for (let i = 0; i < 105; i++) {
      expect(chunks[i]!.length).toBe(12);
    }
    expect(chunks[105]!.length).toBe(1264 - 105 * 12);
  });

  it('preserves order — flatten(chunks) === items', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const chunks = chunkArray(items, 3);
    expect(chunks).toEqual([['a', 'b', 'c'], ['d', 'e', 'f'], ['g']]);
    expect(chunks.flat()).toEqual(items);
  });

  it('returns [] for an empty input', () => {
    expect(chunkArray([], 12)).toEqual([]);
  });

  it('returns [items] when items.length <= size', () => {
    expect(chunkArray([1, 2, 3], 12)).toEqual([[1, 2, 3]]);
  });

  it('throws on size < 1 (guardrail against silent zero-length loops)', () => {
    expect(() => chunkArray([1, 2, 3], 0)).toThrow(/size must be >= 1/);
    expect(() => chunkArray([1, 2, 3], -1)).toThrow(/size must be >= 1/);
  });
});

describe('errorSignature', () => {
  it('normalizes digits so per-request IDs hash identically', () => {
    const a = errorSignature('Gemini 500 Internal (req 123)');
    const b = errorSignature('Gemini 500 Internal (req 456)');
    expect(a).toBe(b);
  });

  it("normalizes whitespace and case so 'Gemini 500' matches 'gemini    500'", () => {
    expect(errorSignature('Gemini    500 Internal')).toBe(errorSignature('gemini 500 internal'));
  });

  it('truncates to 120 chars (bounded fingerprint size)', () => {
    const long = 'x'.repeat(1000);
    expect(errorSignature(long).length).toBeLessThanOrEqual(120);
  });

  it('distinguishes genuinely different error shapes', () => {
    const geminiFail = errorSignature('Google GenAI API 500 Internal error encountered');
    const mimeFail = errorSignature('Refusing to send unsupported MIME type "video/mp4" to Gemini');
    expect(geminiFail).not.toBe(mimeFail);
  });
});
