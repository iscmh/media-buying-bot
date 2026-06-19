/**
 * Polish-14.1: client-side source-duration detection — DOM-free
 * branches only.
 *
 * The full lifecycle (createElement('video') → onloadedmetadata →
 * duration) needs a real DOM, which apps/web's vitest env doesn't
 * provide today. The branches covered here are the boundary guards
 * that protect the worker + cost estimator from junk inputs: bad
 * MIME, empty URL, server-side render (no document). The "happy
 * path" is exercised end-to-end via the live generate page.
 */
import { describe, expect, it } from 'vitest';
import { detectVideoDurationFromFile, detectVideoDurationFromUrl } from '../detect-video-duration';

describe('Polish-14.1: detectVideoDurationFromFile', () => {
  it('returns null for an image MIME type (no DOM call)', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    expect(await detectVideoDurationFromFile(file)).toBeNull();
  });

  it('returns null for an empty MIME type', async () => {
    const file = new File(['x'], 'a.bin', { type: '' });
    expect(await detectVideoDurationFromFile(file)).toBeNull();
  });

  it('returns null for a text MIME type', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(await detectVideoDurationFromFile(file)).toBeNull();
  });
});

describe('Polish-14.1: detectVideoDurationFromUrl', () => {
  it('returns null for an empty URL string', async () => {
    expect(await detectVideoDurationFromUrl('')).toBeNull();
  });

  it('returns null when no document is available (SSR / non-browser env)', async () => {
    // Vitest's default env is node — typeof document === 'undefined'.
    // The helper's `if (typeof document === 'undefined')` branch
    // resolves null without touching the DOM. Sanity-check it.
    expect(await detectVideoDurationFromUrl('https://supa/signed.mp4')).toBeNull();
  });
});
