/**
 * Polish-25.2 Commit 15 regression pins.
 *
 * Root cause of launched_ads row 7632f517 (rejected_by_meta):
 * "https//aima-systems.com" — missing colon after the protocol —
 * passed the pre-Commit-15 client `!offerUrl` check and reached
 * Meta, which rejected it with a localized (Romanian) error the
 * operator only found via SQL.
 *
 * OfferUrlSchema now gates the launch dialog + the server action.
 * These tests pin the exact malformed shape from that row as
 * REJECTED, plus a battery of common valid + invalid shapes.
 */
import { describe, expect, it } from 'vitest';
import { OFFER_URL_MAX_CHARS, OfferUrlSchema, isValidOfferUrl } from '../src/schemas/launch';

describe('Polish-25.2 Commit 15: OfferUrlSchema', () => {
  it('THE regression pin: rejects the malformed "https//..." shape from job 7632f517', () => {
    expect(OfferUrlSchema.safeParse('https//aima-systems.com').success).toBe(false);
    expect(isValidOfferUrl('https//aima-systems.com')).toBe(false);
  });

  it('accepts common valid shapes', () => {
    for (const url of [
      'https://aima-systems.com',
      'https://aima-systems.com/',
      'https://aima-systems.com/landing',
      'https://aima-systems.com/landing?utm=x',
      'https://sub.aima-systems.com/landing#hash',
      'http://localhost:3000/dev',
      'https://xn--exmple-cua.com/', // punycode
    ]) {
      expect(OfferUrlSchema.safeParse(url).success).toBe(true);
      expect(isValidOfferUrl(url)).toBe(true);
    }
  });

  it('rejects http-adjacent shapes that Meta silently rejects', () => {
    for (const bad of [
      '', // empty
      '   ', // whitespace only
      'aima-systems.com', // no protocol
      'https//aima-systems.com', // missing colon
      'https:aima-systems.com', // missing slashes
      'https:/aima-systems.com', // single slash
      'ftp://aima-systems.com', // not http/https
      'javascript:alert(1)', // not http/https
      'mailto:test@example.com', // not http/https
      'not a url at all',
    ]) {
      expect(OfferUrlSchema.safeParse(bad).success).toBe(false);
      expect(isValidOfferUrl(bad)).toBe(false);
    }
  });

  it(`rejects URLs longer than ${OFFER_URL_MAX_CHARS} chars`, () => {
    const long = `https://example.com/${'x'.repeat(OFFER_URL_MAX_CHARS)}`;
    expect(long.length).toBeGreaterThan(OFFER_URL_MAX_CHARS);
    expect(OfferUrlSchema.safeParse(long).success).toBe(false);
  });

  it('trims leading + trailing whitespace before validating', () => {
    expect(OfferUrlSchema.safeParse('  https://ok.example.com  ').success).toBe(true);
    // Whitespace-only should fail on the min(1) check post-trim.
    expect(OfferUrlSchema.safeParse('   ').success).toBe(false);
  });

  it('isValidOfferUrl handles null / undefined / non-string safely', () => {
    expect(isValidOfferUrl(null)).toBe(false);
    expect(isValidOfferUrl(undefined)).toBe(false);
    expect(isValidOfferUrl('')).toBe(false);
  });
});
