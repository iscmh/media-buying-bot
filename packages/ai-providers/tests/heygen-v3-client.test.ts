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
import { isGeminiInlineImageMimeSupported, resolveInlineImageMime } from '../src/gemini-client';

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

/**
 * Polish-26.0.3 Commit 61.3 tripwire: MIME inference fallback for
 * CDN responses that mis-serve real images as binary/octet-stream.
 * The reported failure was HeyGen's files2.heygen.ai CDN returning
 *   Content-Type: binary/octet-stream
 *   URL:          https://files2.heygen.ai/…/preview_target.webp
 *   Body:         real 39096-byte WebP
 * which Commit-61.2's naive MIME allowlist correctly rejected but
 * left 100% of HeyGen avatars unindexable. Inference recovers.
 */
describe('resolveInlineImageMime', () => {
  const emptyBytes = new Uint8Array(0);

  it('keeps a valid image mime unchanged (no inference)', () => {
    const r = resolveInlineImageMime('image/png', 'https://cdn.example/foo.png', emptyBytes);
    expect(r).toEqual({ mime: 'image/png', inferred: false, source: 'header' });
  });

  it('handles content-type parameter suffixes on the happy path', () => {
    const r = resolveInlineImageMime(
      'image/webp; charset=binary',
      'https://cdn.example/foo.webp',
      emptyBytes,
    );
    expect(r).toEqual({ mime: 'image/webp', inferred: false, source: 'header' });
  });

  it('infers image/webp from a .webp URL when CDN says binary/octet-stream (HeyGen case)', () => {
    const r = resolveInlineImageMime(
      'binary/octet-stream',
      'https://files2.heygen.ai/avatar/v3/1ad51ab9fee24ae88af067206e14a1d8_44250/preview_target.webp',
      emptyBytes,
    );
    expect(r).toEqual({ mime: 'image/webp', inferred: true, source: 'url-extension' });
  });

  it('infers image/png from a .png URL with application/octet-stream', () => {
    const r = resolveInlineImageMime(
      'application/octet-stream',
      'https://cdn.example/portrait.png',
      emptyBytes,
    );
    expect(r).toEqual({ mime: 'image/png', inferred: true, source: 'url-extension' });
  });

  it('infers image/jpeg from .jpg AND .jpeg extensions', () => {
    expect(
      resolveInlineImageMime('binary/octet-stream', 'https://cdn.example/a.jpg', emptyBytes),
    ).toEqual({ mime: 'image/jpeg', inferred: true, source: 'url-extension' });
    expect(
      resolveInlineImageMime('binary/octet-stream', 'https://cdn.example/a.jpeg', emptyBytes),
    ).toEqual({ mime: 'image/jpeg', inferred: true, source: 'url-extension' });
  });

  it('strips query + fragment before extension lookup', () => {
    const r = resolveInlineImageMime(
      'binary/octet-stream',
      'https://cdn.example/portrait.webp?token=abc&expires=123#anchor',
      emptyBytes,
    );
    expect(r.mime).toBe('image/webp');
  });

  it('falls back to magic bytes when URL has no extension', () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A + arbitrary tail
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const r = resolveInlineImageMime(
      'binary/octet-stream',
      'https://cdn.example/download/abc123',
      png,
    );
    expect(r).toEqual({ mime: 'image/png', inferred: true, source: 'magic-bytes' });
  });

  it('detects JPEG via magic bytes (FF D8 FF)', () => {
    const jpg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const r = resolveInlineImageMime('', 'https://cdn.example/download/abc123', jpg);
    expect(r).toEqual({ mime: 'image/jpeg', inferred: true, source: 'magic-bytes' });
  });

  it('detects WebP via magic bytes (RIFF????WEBP)', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x10, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const r = resolveInlineImageMime('', 'https://cdn.example/download/abc123', webp);
    expect(r).toEqual({ mime: 'image/webp', inferred: true, source: 'magic-bytes' });
  });

  it('returns null when URL + magic both fail (no false-positive)', () => {
    const notAnImage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1" (PDF)
    const r = resolveInlineImageMime(
      'binary/octet-stream',
      'https://cdn.example/download/abc123', // no extension
      notAnImage,
    );
    expect(r).toEqual({ mime: null, inferred: false, source: 'none' });
  });

  it('does NOT fight a wrong-but-specific header (video/mp4 stays rejected)', () => {
    // The .webp extension is a lie — if the CDN is EXPLICIT that it's
    // serving video/mp4, we trust the header and reject. Otherwise
    // we'd send real videos to Gemini and get the exact 500 we're
    // trying to prevent.
    const r = resolveInlineImageMime(
      'video/mp4',
      'https://cdn.example/lying.webp',
      new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    );
    expect(r).toEqual({ mime: null, inferred: false, source: 'none' });
  });

  it('rejects .gif extension even under a generic content-type (animated → Gemini 500)', () => {
    const r = resolveInlineImageMime(
      'binary/octet-stream',
      'https://cdn.example/animated.gif',
      emptyBytes,
    );
    expect(r).toEqual({ mime: null, inferred: false, source: 'none' });
  });

  it("treats 'text/plain' and empty as generic-need-inference", () => {
    expect(
      resolveInlineImageMime('text/plain', 'https://cdn.example/foo.png', emptyBytes).mime,
    ).toBe('image/png');
    expect(resolveInlineImageMime('', 'https://cdn.example/foo.webp', emptyBytes).mime).toBe(
      'image/webp',
    );
    expect(resolveInlineImageMime(undefined, 'https://cdn.example/foo.jpg', emptyBytes).mime).toBe(
      'image/jpeg',
    );
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
