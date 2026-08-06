import { describe, expect, it } from 'vitest';
// Test imports go straight against the source file so we don't need
// to worry about the barrel's V3-suffix aliases here.
import {
  HEYGEN_DEFAULT_VIDEO_SECONDS,
  HEYGEN_USD_PER_SECOND_STANDARD,
  HEYGEN_VOICE_SCRIPT_MAX_CHARS,
  assertHeygenScriptLength,
  classifyHeygenError,
  estimateHeygenVideoCostUsd,
  HeygenScriptTooLongError,
  isHeygenTransientError,
} from '../src/heygen-v3-client';
import { isGeminiInlineImageMimeSupported } from '../src/gemini-client';

/**
 * Polish-26.0.1 Commit 61.1 hotfix tripwires. Four things that
 * would ship a silent cost/economics bug if they drifted:
 *
 *   1. estimateHeygenVideoCostUsd must return $0.25 for a 30-sec
 *      video at the public-pricing-standard retail rate
 *      ($0.00833/sec × 30). Any change directly changes what
 *      /concepts/[id]/generate quotes the user AND what the worker
 *      stamps into generation_jobs.actualCostUsd. Commit 61
 *      originally quoted $1.50 (Avatar IV Photo Avatar rate from
 *      the help-center per-engine table) which turned out to be
 *      6× the public pricing page — Commit 61.1 pinned to the
 *      public rate pending a first-invoice true-up.
 *   2. classifyHeygenError must route the exact HeyGen error shapes
 *      to the right bucket — a moderation rejection misclassified
 *      as transient would loop retries on a permanently-rejected
 *      script and burn credits.
 *   3. Script-length ceiling must match HeyGen's real 5000-char cap.
 *   4. Transient detection must catch HeyGen's real transient
 *      phrases so the worker's 2-retry gate actually fires.
 */

describe('estimateHeygenVideoCostUsd', () => {
  it('defaults to public-standard rate × HEYGEN_DEFAULT_VIDEO_SECONDS = $0.25 for 30s', () => {
    const cost = estimateHeygenVideoCostUsd();
    expect(cost).toBeCloseTo(HEYGEN_USD_PER_SECOND_STANDARD * HEYGEN_DEFAULT_VIDEO_SECONDS, 5);
    // Pinned expectation: $0.50/min × 0.5 min = $0.25 (retail).
    expect(cost).toBeCloseTo(0.25, 5);
  });

  it('scales linearly with seconds', () => {
    expect(estimateHeygenVideoCostUsd({ seconds: 60 })).toBeCloseTo(0.5, 5);
    expect(estimateHeygenVideoCostUsd({ seconds: 15 })).toBeCloseTo(0.125, 5);
    expect(estimateHeygenVideoCostUsd({ seconds: 120 })).toBeCloseTo(1.0, 5);
  });

  it('engine + resolution inputs are accepted but ignored (Polish-26.0.1 pin)', () => {
    // The estimator flat-rates to the public standard for now —
    // engine/resolution come back into play once we have a real
    // HeyGen invoice to true-up against. Documented behavior;
    // this test pins it so a future contributor doesn't
    // silently re-enable per-tier math without doing the true-up.
    const flat = estimateHeygenVideoCostUsd({ seconds: 30 });
    expect(estimateHeygenVideoCostUsd({ seconds: 30, engine: 'avatar_v' })).toBe(flat);
    expect(estimateHeygenVideoCostUsd({ seconds: 30, engine: 'avatar_iv' })).toBe(flat);
    expect(estimateHeygenVideoCostUsd({ seconds: 30, engine: 'avatar_iv', resolution: '4k' })).toBe(
      flat,
    );
  });

  it('per-second constant matches the public $0.50/min retail rate', () => {
    // Documented public pricing: Avatar video (standard) = $0.50/min.
    // Anything else lands us on the extended ($1/min) or effect
    // ($1.30/video) tiers, which we deliberately don't quote today.
    expect(HEYGEN_USD_PER_SECOND_STANDARD).toBeCloseTo(0.5 / 60, 6);
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

/**
 * Polish-26.0.2 Commit 61.2 tripwire: the MIME-allowlist for the
 * Gemini inline_data image path. Run 01KZAPKYZ03W6DA9ZE8D918BHY
 * hit 1264/1264 Gemini failures with an opaque "500 Internal error
 * encountered" — root cause suspected to be HeyGen preview URLs
 * returning animated WebP / video / other formats the model's
 * decoder rejects. This filter pre-empts those calls so failures
 * surface as actionable "unsupported MIME" messages instead of
 * generic 500s (and doesn't burn Gemini quota on guaranteed rejects).
 *
 * The allowlist MUST stay tight against Gemini's documented
 * inline_data support (PNG / JPEG / WebP / HEIC / HEIF per REST
 * v1beta docs). Any drift here silently changes what avatars our
 * refresh cron will attempt.
 */
describe('isGeminiInlineImageMimeSupported', () => {
  it('accepts documented Gemini inline_data formats', () => {
    expect(isGeminiInlineImageMimeSupported('image/png')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('image/jpeg')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('image/jpg')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('image/webp')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('image/heic')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('image/heif')).toBe(true);
  });

  it('rejects formats the model decoder chokes on', () => {
    // Animated GIFs / SVG / video containers are the likely culprits
    // for HeyGen previews. Rejecting here prevents the opaque
    // "Google GenAI 500 Internal error" we saw pre-Commit-61.2.
    expect(isGeminiInlineImageMimeSupported('image/gif')).toBe(false);
    expect(isGeminiInlineImageMimeSupported('image/svg+xml')).toBe(false);
    expect(isGeminiInlineImageMimeSupported('image/avif')).toBe(false);
    expect(isGeminiInlineImageMimeSupported('video/mp4')).toBe(false);
    expect(isGeminiInlineImageMimeSupported('video/webm')).toBe(false);
    expect(isGeminiInlineImageMimeSupported('application/octet-stream')).toBe(false);
  });

  it('handles content-type header parameter suffixes', () => {
    // Real-world headers often carry charset / codec params:
    // "image/webp; charset=binary" — normalize before comparison.
    expect(isGeminiInlineImageMimeSupported('image/webp; charset=binary')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('IMAGE/PNG')).toBe(true);
    expect(isGeminiInlineImageMimeSupported('  image/jpeg  ')).toBe(true);
  });

  it('rejects null / undefined / empty', () => {
    expect(isGeminiInlineImageMimeSupported(null)).toBe(false);
    expect(isGeminiInlineImageMimeSupported(undefined)).toBe(false);
    expect(isGeminiInlineImageMimeSupported('')).toBe(false);
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
