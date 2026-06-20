/**
 * Polish-15: translateGenerationError pure tests.
 *
 * Drives the helper through every documented pattern + the unknown-
 * error fallback. Pins userMessage/suggestion/retryable shape so the
 * jobs page UI gets a stable contract.
 */
import { describe, expect, it } from 'vitest';
import { translateGenerationError } from '../src';

describe('Polish-15: translateGenerationError', () => {
  describe('content filters', () => {
    it('PROMINENT_PEOPLE_FILTER_FAILED → public-figure message + retryable', () => {
      const t = translateGenerationError('Segment 2: PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED');
      expect(t.userMessage).toMatch(/public figure/);
      expect(t.suggestion).toMatch(/regenerating/i);
      expect(t.retryable).toBe(true);
    });

    it('AUDIO_FILTERED → audio-filter message + retryable', () => {
      const t = translateGenerationError('PUBLIC_ERROR_AUDIO_FILTERED on segment 0');
      expect(t.userMessage).toMatch(/audio filter/);
      expect(t.retryable).toBe(true);
    });

    it('PERSON_GENERATION_FAILED → person-gen message + retryable', () => {
      const t = translateGenerationError('PUBLIC_ERROR_PERSON_GENERATION_FAILED');
      expect(t.userMessage).toMatch(/person-generation filter/);
      expect(t.retryable).toBe(true);
    });

    it('SAFETY_FILTER_FAILED → safety-filter message + retryable', () => {
      const t = translateGenerationError('PUBLIC_ERROR_SAFETY_FILTER_FAILED');
      expect(t.userMessage).toMatch(/safety filter/);
      expect(t.retryable).toBe(true);
    });
  });

  describe('balance / billing', () => {
    it('insufficient balance → top-up message + retryable', () => {
      const t = translateGenerationError('kie.ai account has insufficient balance.');
      expect(t.userMessage).toMatch(/credits/);
      expect(t.suggestion).toMatch(/Top up/);
      expect(t.retryable).toBe(true);
    });
  });

  describe('auth', () => {
    it('authentication failed → connections page guidance + NOT retryable', () => {
      const t = translateGenerationError('kie.ai authentication failed (invalid API key)');
      expect(t.userMessage).toMatch(/Authentication.*failed/);
      expect(t.suggestion).toMatch(/Connections/);
      expect(t.retryable).toBe(false);
    });

    it('plain 401 → same auth path', () => {
      const t = translateGenerationError('Got 401 from provider');
      expect(t.userMessage).toMatch(/Authentication/);
      expect(t.retryable).toBe(false);
    });
  });

  describe('rate limit', () => {
    it('"rate limit" message → wait-and-retry guidance', () => {
      const t = translateGenerationError('Provider rate limit exceeded');
      expect(t.userMessage).toMatch(/rate limit/);
      expect(t.retryable).toBe(true);
    });

    it('plain 429 → same rate-limit path', () => {
      const t = translateGenerationError('HTTP 429');
      expect(t.userMessage).toMatch(/rate limit/);
      expect(t.retryable).toBe(true);
    });
  });

  describe('transient backend hiccups', () => {
    it('Internal Error prose → backend-hiccup message', () => {
      const t = translateGenerationError('Internal Error, Please try again later.');
      expect(t.userMessage).toMatch(/Backend service hiccup/);
      expect(t.retryable).toBe(true);
    });

    it('bare INTERNAL code → same path', () => {
      const t = translateGenerationError('INTERNAL');
      expect(t.userMessage).toMatch(/Backend service hiccup/);
      expect(t.retryable).toBe(true);
    });

    it('service unavailable / deadline exceeded → same path', () => {
      expect(translateGenerationError('Service Unavailable').userMessage).toMatch(/Backend/);
      expect(translateGenerationError('Upstream deadline exceeded').userMessage).toMatch(/Backend/);
      expect(translateGenerationError('Backend error: lost connection').userMessage).toMatch(
        /Backend/,
      );
    });
  });

  describe('validation', () => {
    it('"validation failed" → malformed-request guidance + NOT retryable', () => {
      const t = translateGenerationError('kie.ai validation failed: prompt too long');
      expect(t.userMessage).toMatch(/malformed/);
      expect(t.retryable).toBe(false);
    });

    it('plain 422 → same validation path', () => {
      const t = translateGenerationError('HTTP 422');
      expect(t.userMessage).toMatch(/malformed/);
      expect(t.retryable).toBe(false);
    });
  });

  describe('missing provider key', () => {
    it('"missing key" prose → connections guidance + NOT retryable', () => {
      const t = translateGenerationError('Missing key for gemini');
      expect(t.userMessage).toMatch(/not connected/);
      expect(t.suggestion).toMatch(/Connections/);
      expect(t.retryable).toBe(false);
    });
  });

  describe('fallback paths', () => {
    it('null / undefined / empty → "without a recorded error" message', () => {
      expect(translateGenerationError(null).userMessage).toMatch(/without a recorded error/);
      expect(translateGenerationError(undefined).userMessage).toMatch(/without a recorded error/);
      expect(translateGenerationError('').userMessage).toMatch(/without a recorded error/);
    });

    it('unknown error → generic "Generation failed" message + retryable', () => {
      const t = translateGenerationError('something completely novel went wrong');
      expect(t.userMessage).toBe('Generation failed.');
      expect(t.suggestion).toMatch(/regenerating/i);
      expect(t.retryable).toBe(true);
    });
  });

  describe('match-order priority (specific patterns win over generic)', () => {
    it('error that mentions BOTH a filter AND "Internal Error" → filter wins', () => {
      // Filter patterns come first in the table; "Internal Error" later.
      const t = translateGenerationError(
        'Internal Error during PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED check',
      );
      expect(t.userMessage).toMatch(/public figure/);
    });
  });
});
