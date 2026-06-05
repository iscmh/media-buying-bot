/**
 * Polish-9: pure-helper tests for the reference-creative signed-URL
 * upload flow. The server actions themselves bind to Supabase + Drizzle
 * + Next cookies which aren't trivially mockable in vitest — these
 * helpers are the validation surface where a bad input could let a
 * malicious or stale client hit storage paths it shouldn't own.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_REFERENCE_BYTES,
  isAllowedReferenceMime,
  sanitizeFilename,
  storagePathBelongsToUser,
} from '../reference-upload-helpers';

describe('Polish-9: isAllowedReferenceMime', () => {
  it('accepts the documented mp4/mov/webm video types', () => {
    expect(isAllowedReferenceMime('video/mp4')).toBe(true);
    expect(isAllowedReferenceMime('video/quicktime')).toBe(true);
    expect(isAllowedReferenceMime('video/webm')).toBe(true);
  });

  it('accepts png/jpeg/webp image types', () => {
    expect(isAllowedReferenceMime('image/png')).toBe(true);
    expect(isAllowedReferenceMime('image/jpeg')).toBe(true);
    expect(isAllowedReferenceMime('image/webp')).toBe(true);
  });

  it('rejects unsupported types', () => {
    expect(isAllowedReferenceMime('application/pdf')).toBe(false);
    expect(isAllowedReferenceMime('text/plain')).toBe(false);
    expect(isAllowedReferenceMime('image/gif')).toBe(false);
    expect(isAllowedReferenceMime('')).toBe(false);
  });
});

describe('Polish-9: sanitizeFilename', () => {
  it('keeps safe ASCII + dots + underscores + hyphens unchanged', () => {
    expect(sanitizeFilename('my-ad_video.mp4')).toBe('my-ad_video.mp4');
  });

  it('neutralizes path-traversal slashes (storagePathBelongsToUser also defends)', () => {
    // Slashes get replaced; dots are allowed in filenames so they survive.
    // The combination "../" → ".._" can no longer escape a directory because
    // forward slashes are gone.
    const out = sanitizeFilename('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).toBe('.._.._etc_passwd');
  });

  it('replaces spaces and unicode with underscores', () => {
    expect(sanitizeFilename('my photo é.png')).toBe('my_photo__.png');
  });

  it('truncates to 120 chars', () => {
    const long = 'a'.repeat(200) + '.mp4';
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(120);
  });

  it('returns "upload" for an all-invalid empty result', () => {
    // Note: the regex replaces invalid chars with _ so the result is
    // rarely literally empty. Truly empty input still hits the fallback.
    expect(sanitizeFilename('')).toBe('upload');
  });
});

describe('Polish-9: storagePathBelongsToUser', () => {
  const userId = '843ca6d6-233e-4c19-9ef1-4b8c0f6288d1';

  it('accepts a path that starts with the user id', () => {
    expect(storagePathBelongsToUser(`${userId}/uuid/ad.mp4`, userId)).toBe(true);
  });

  it('rejects a path scoped to a different user', () => {
    expect(storagePathBelongsToUser('00000000-0000-0000-0000-000000000000/x/y.mp4', userId)).toBe(
      false,
    );
  });

  it('rejects paths containing .. (traversal)', () => {
    expect(storagePathBelongsToUser(`${userId}/../other-user/y.mp4`, userId)).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(storagePathBelongsToUser('', userId)).toBe(false);
    expect(storagePathBelongsToUser(null as unknown as string, userId)).toBe(false);
    expect(storagePathBelongsToUser(undefined as unknown as string, userId)).toBe(false);
  });
});

describe('Polish-9: MAX_REFERENCE_BYTES', () => {
  it('matches the bucket file_size_limit in migration 0028 (100 MB)', () => {
    expect(MAX_REFERENCE_BYTES).toBe(100 * 1024 * 1024);
  });
});
