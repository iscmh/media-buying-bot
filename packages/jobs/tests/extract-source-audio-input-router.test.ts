/**
 * Polish-28.0.5 Commit 64.5 tripwire: extract-source-audio input router
 * (Replicate-backed).
 *
 * Post-64.5 the extractor accepts either a { sourceVideoUrl } or
 * { storageBucket, storagePath } shape, PLUS the required
 * userId + replicateApiKey Replicate credentials. Local ffmpeg
 * spawning is dropped entirely (Vercel Hobby function-size limit).
 *
 * These tests pin the input-router contract via cheap failure-path
 * assertions — the extractor must short-circuit with `ffmpeg-missing`
 * (env-config missing) OR `source-video-fetch-failed` (bad input)
 * rather than throwing an uncaught TypeError. The prior Commit-64
 * "Failed to parse URL from" bug must never re-appear.
 */
import { describe, expect, it } from 'vitest';
import { extractSourceAudioLoopMitigated } from '../src/lib/extract-source-audio';

const REPLICATE_KEY_STUB = 'r8_stub_test_key_polish28';
const USER_ID_STUB = 'polish28-regression-test';

describe('extractSourceAudioLoopMitigated input router (Replicate-backed)', () => {
  it('storage-tuple shape: empty storagePath returns actionable error (no crash)', async () => {
    // Set the env so we get past the model-id check and hit the router.
    const prev = process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
    process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = 'test-model';
    try {
      const r = await extractSourceAudioLoopMitigated({
        storageBucket: 'concepts',
        storagePath: '',
        userId: USER_ID_STUB,
        replicateApiKey: REPLICATE_KEY_STUB,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('source-video-fetch-failed');
        expect(r.detail).toMatch(/storagePath is empty|Re-upload/i);
      }
    } finally {
      if (prev == null) delete process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
      else process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = prev;
    }
  });

  it('Commit 64.6: missing env-config falls back to POLISH28_DEFAULT_FFMPEG_MODEL (no ffmpeg-missing block)', async () => {
    // Polish-28.0.6 Commit 64.6 hotfix: getPolish28FfmpegModelId now
    // returns a hardcoded 'cuuupid/cog-ffmpeg' default when neither env
    // is set. So with both envs cleared, the extractor DOES NOT fail
    // at 'ffmpeg-missing' — it proceeds and hits downstream failure
    // paths (Supabase / Replicate). The regression tripwire here
    // asserts we never re-introduce the pre-64.6 block-on-env-unset
    // behavior that stranded operators without config.
    const prev = process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
    const prevTrim = process.env['REPLICATE_AUDIO_TRIM_MODEL_ID'];
    delete process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
    delete process.env['REPLICATE_AUDIO_TRIM_MODEL_ID'];
    try {
      const { getPolish28FfmpegModelId, POLISH28_DEFAULT_FFMPEG_MODEL } =
        await import('../src/lib/extract-source-audio');
      expect(getPolish28FfmpegModelId()).toBe(POLISH28_DEFAULT_FFMPEG_MODEL);
      // And the extractor proceeds past the env check — reason CANNOT
      // be 'ffmpeg-missing' when envs are unset (that's the regression).
      const r = await extractSourceAudioLoopMitigated({
        storageBucket: 'concepts',
        storagePath: 'ignored',
        userId: USER_ID_STUB,
        replicateApiKey: REPLICATE_KEY_STUB,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toBe('ffmpeg-missing');
    } finally {
      if (prev != null) process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = prev;
      if (prevTrim != null) process.env['REPLICATE_AUDIO_TRIM_MODEL_ID'] = prevTrim;
    }
  }, 30_000);

  it('regression: no local ffmpeg-spawn path exists (no ENOENT / Failed-to-parse-URL from prior commits)', async () => {
    // The prior Commit-64 bug: piping concept.file_url (a relative
    // storage path) straight to fetch() throws "Failed to parse URL
    // from". Post-64.5 the storage-tuple router never touches fetch()
    // — it uses Supabase signed URLs → Replicate. Prior Commit-64.4
    // bug: local ffmpeg spawn ENOENTs on Vercel Hobby. Post-64.5 all
    // ffmpeg work goes through Replicate.
    //
    // We can't invoke real Supabase/Replicate here without live creds,
    // so this test asserts the failure MODES the router produces are
    // ONLY ones the router explicitly emits — not raw thrown errors.
    const prev = process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
    process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = 'test-model';
    try {
      const r = await extractSourceAudioLoopMitigated({
        storageBucket: 'concepts',
        storagePath: 'polish28-regression/some/nonexistent.mp4',
        userId: USER_ID_STUB,
        replicateApiKey: REPLICATE_KEY_STUB,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(['source-video-fetch-failed', 'ffmpeg-failed']).toContain(r.reason);
        expect(r.detail).not.toMatch(/spawn ffmpeg ENOENT/);
        expect(r.detail).not.toMatch(/Failed to parse URL from/);
      }
    } finally {
      if (prev == null) delete process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
      else process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = prev;
    }
  }, 30_000);

  it('missing both shapes: returns actionable error', async () => {
    const prev = process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
    process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = 'test-model';
    try {
      const r = await extractSourceAudioLoopMitigated({
        userId: USER_ID_STUB,
        replicateApiKey: REPLICATE_KEY_STUB,
      } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('source-video-fetch-failed');
        expect(r.detail).toMatch(/sourceVideoUrl.*storageBucket|neither was provided/i);
      }
    } finally {
      if (prev == null) delete process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'];
      else process.env['POLISH28_REPLICATE_FFMPEG_MODEL_ID'] = prev;
    }
  });
});
