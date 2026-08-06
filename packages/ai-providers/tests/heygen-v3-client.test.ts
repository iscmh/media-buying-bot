import { describe, expect, it } from 'vitest';
// Test imports go straight against the source file so we don't need
// to worry about the barrel's V3-suffix aliases here.
import {
  HEYGEN_DEFAULT_VIDEO_SECONDS,
  HEYGEN_USD_PER_SECOND_AVATAR_V,
  HEYGEN_VOICE_SCRIPT_MAX_CHARS,
  assertHeygenScriptLength,
  classifyHeygenError,
  estimateHeygenVideoCostUsd,
  HeygenScriptTooLongError,
  isHeygenTransientError,
} from '../src/heygen-v3-client';

/**
 * Polish-26.0 Commit 61 tripwires. The four things that would ship
 * a silent cost/economics bug if they drifted:
 *
 *   1. estimateHeygenVideoCostUsd must return $1.50 for a 30-sec
 *      Avatar V video (0.05 * 30). Any change here directly changes
 *      what /concepts/[id]/generate quotes the user, and what the
 *      worker stamps into generation_jobs.actualCostUsd.
 *   2. classifyHeygenError must route the exact HeyGen error shapes
 *      to the right bucket — a moderation rejection misclassified
 *      as transient would loop retries on a permanently-rejected
 *      script and burn credits.
 *   3. Script-length ceiling must match HeyGen's real 5000-char cap.
 *   4. Transient detection must catch HeyGen's real transient
 *      phrases so the worker's 2-retry gate actually fires.
 */

describe('estimateHeygenVideoCostUsd', () => {
  it('defaults to Avatar V at HEYGEN_DEFAULT_VIDEO_SECONDS', () => {
    const cost = estimateHeygenVideoCostUsd();
    expect(cost).toBeCloseTo(HEYGEN_USD_PER_SECOND_AVATAR_V * HEYGEN_DEFAULT_VIDEO_SECONDS, 5);
    // Pinned expectation: 0.05 * 30 = $1.50
    expect(cost).toBeCloseTo(1.5, 5);
  });

  it('scales linearly with seconds on Avatar V', () => {
    // 60-sec hook = 2x the cost of a 30-sec hook.
    expect(estimateHeygenVideoCostUsd({ seconds: 60 })).toBeCloseTo(3.0, 5);
    expect(estimateHeygenVideoCostUsd({ seconds: 15 })).toBeCloseTo(0.75, 5);
  });

  it('Avatar IV 1080p is ~33% more expensive than Avatar V per second', () => {
    const v = estimateHeygenVideoCostUsd({ engine: 'avatar_v', seconds: 60 });
    const iv1080 = estimateHeygenVideoCostUsd({
      engine: 'avatar_iv',
      seconds: 60,
      resolution: '1080p',
    });
    // Avatar V: $3.00/min. Avatar IV 1080p: $4.00/min. Ratio 4/3.
    expect(iv1080 / v).toBeCloseTo(4 / 3, 3);
    expect(iv1080).toBeCloseTo(4.0, 5);
  });

  it('Avatar IV 4K is $5/min', () => {
    expect(
      estimateHeygenVideoCostUsd({ engine: 'avatar_iv', seconds: 60, resolution: '4k' }),
    ).toBeCloseTo(5.0, 5);
  });
});

describe('classifyHeygenError', () => {
  it('401/403 → auth', () => {
    expect(classifyHeygenError(401, 'unauthorized')).toBe('auth');
    expect(classifyHeygenError(403, 'forbidden')).toBe('auth');
  });

  it('429 → rate_limit', () => {
    expect(classifyHeygenError(429, 'too many requests')).toBe('rate_limit');
  });

  it('402 or credit-mentioning body → quota_exceeded', () => {
    expect(classifyHeygenError(402, 'payment required')).toBe('quota_exceeded');
    expect(classifyHeygenError(400, 'insufficient credit balance')).toBe('quota_exceeded');
    expect(classifyHeygenError(400, 'account quota exhausted')).toBe('quota_exceeded');
  });

  it('moderation-language body → moderation, even at 400/422', () => {
    // This is the critical routing — a moderation rejection MUST NOT
    // be classified as validation/transient, or the worker's retry
    // loop would burn credits on a permanently-rejected script.
    expect(classifyHeygenError(400, 'content policy violation')).toBe('moderation');
    expect(classifyHeygenError(422, 'script violates our moderation policy')).toBe('moderation');
  });

  it('5xx → server (transient-eligible upstream)', () => {
    expect(classifyHeygenError(500, 'internal server error')).toBe('server');
    expect(classifyHeygenError(503, 'service unavailable')).toBe('server');
  });

  it('404 → not_found', () => {
    expect(classifyHeygenError(404, 'video not found')).toBe('not_found');
  });

  it('otherwise unknown', () => {
    expect(classifyHeygenError(undefined, undefined)).toBe('unknown');
  });
});

describe('assertHeygenScriptLength', () => {
  it('accepts scripts up to HEYGEN_VOICE_SCRIPT_MAX_CHARS', () => {
    const script = 'a'.repeat(HEYGEN_VOICE_SCRIPT_MAX_CHARS);
    expect(() => assertHeygenScriptLength(script)).not.toThrow();
  });

  it('rejects a script one char over the ceiling with HeygenScriptTooLongError', () => {
    const script = 'a'.repeat(HEYGEN_VOICE_SCRIPT_MAX_CHARS + 1);
    expect(() => assertHeygenScriptLength(script)).toThrow(HeygenScriptTooLongError);
  });

  it('the ceiling matches HeyGen v3 documented 1-5000 char per input block', () => {
    // Pin the exact number — a drift here silently changes what the
    // Claude condenser can safely emit before HeyGen rejects it.
    expect(HEYGEN_VOICE_SCRIPT_MAX_CHARS).toBe(5000);
  });
});

describe('isHeygenTransientError', () => {
  it('catches gateway / 502 / 503 / 504 / timeout phrases', () => {
    expect(isHeygenTransientError('502 bad gateway')).toBe(true);
    expect(isHeygenTransientError('504 gateway timeout')).toBe(true);
    expect(isHeygenTransientError('server temporarily unavailable')).toBe(true);
    expect(isHeygenTransientError('request timeout')).toBe(true);
  });

  it("doesn't fire on legitimately-terminal errors", () => {
    expect(isHeygenTransientError('invalid avatar_id')).toBe(false);
    expect(isHeygenTransientError('script violates moderation policy')).toBe(false);
    expect(isHeygenTransientError('insufficient credit balance')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isHeygenTransientError(undefined)).toBe(false);
    expect(isHeygenTransientError(null)).toBe(false);
    expect(isHeygenTransientError(500)).toBe(false);
  });
});
