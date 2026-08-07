/**
 * Polish-28.0.3 Commit 64.3 tripwire: extract-source-audio input router.
 *
 * Failure mode this defends against: Polish-28 crashed with
 * `Failed to parse URL from 843ca6d6-.../concepts/ddca175b-.../source.mp4`
 * because concept.file_url stores a Supabase-storage RELATIVE PATH,
 * not an https URL, and Commit-64's helper piped that string straight
 * into fetch().
 *
 * Post-Commit-64.3 the helper accepts TWO input shapes:
 *   - { sourceVideoUrl }               → HTTPS fetch()
 *   - { storageBucket, storagePath }   → Supabase authenticated download
 *
 * We can't invoke the full extractor here (would require spawning
 * ffmpeg + a real Supabase client), but we CAN pin the input-router
 * contract via cheap failure-path assertions: both branches must
 * short-circuit with a clean `source-video-fetch-failed` outcome
 * when the underlying I/O breaks. Anything else (e.g. a TypeError
 * from URL parsing) means the router was bypassed.
 */
import { describe, expect, it } from 'vitest';
import { extractSourceAudioLoopMitigated } from '../src/lib/extract-source-audio';

describe('extractSourceAudioLoopMitigated input router', () => {
  it('storage-tuple shape: empty storagePath returns actionable error (no crash)', async () => {
    const r = await extractSourceAudioLoopMitigated({
      storageBucket: 'concepts',
      storagePath: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('source-video-fetch-failed');
      expect(r.detail).toMatch(/storagePath is empty|Re-upload/i);
    }
  });

  it('storage-tuple shape: non-existent path returns source-video-fetch-failed (no URL parse crash)', async () => {
    // A path that doesn't resolve — Supabase returns { error } which
    // the helper wraps. The KEY assertion is that we DON'T get a
    // TypeError like the Commit-64 bug: `Failed to parse URL from ...`.
    // Real: this will hit real Supabase; skip if unavailable.
    const r = await extractSourceAudioLoopMitigated({
      storageBucket: 'concepts',
      storagePath: 'polish28-regression-test/nonexistent.mp4',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('source-video-fetch-failed');
      // Regression: the Commit-64 bug produced this exact string.
      // Post-Commit-64.3 the storage-tuple path never touches fetch()
      // so this substring must NOT appear in the returned detail.
      expect(r.detail).not.toMatch(/Failed to parse URL from/);
    }
  }, 30_000);

  it('url-shape: malformed URL string returns source-video-fetch-failed (no crash)', async () => {
    // This IS the exact Commit-64 failure case, now routed cleanly.
    const r = await extractSourceAudioLoopMitigated({
      sourceVideoUrl: '843ca6d6/concepts/ddca175b/source.mp4',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('source-video-fetch-failed');
      // The error message now includes the useful "Failed to parse URL"
      // signal (bubbled from fetch), but it's returned as a graceful
      // failure, not an uncaught throw.
      expect(typeof r.detail).toBe('string');
    }
  });

  it('missing both shapes: returns actionable error', async () => {
    const r = await extractSourceAudioLoopMitigated({} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('source-video-fetch-failed');
      expect(r.detail).toMatch(/sourceVideoUrl.*storageBucket|neither was provided/i);
    }
  });
});
