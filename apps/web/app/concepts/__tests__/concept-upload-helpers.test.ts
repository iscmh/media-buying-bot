/**
 * Polish-9.1: pure-helper tests for the concept signed-URL upload flow.
 * Mirror of the Polish-9 reference-upload-helpers tests, scoped to the
 * concepts bucket + per-content-type mime allowlist.
 */
import { describe, expect, it } from 'vitest';
import {
  CONCEPT_STATIC_MAX_BYTES,
  CONCEPT_UGC_MAX_BYTES,
  conceptStoragePathBelongsToUser,
  isAllowedConceptMime,
  maxConceptBytes,
  sanitizeConceptExt,
  stripConceptExtension,
} from '../concept-upload-helpers';

describe('Polish-9.1: isAllowedConceptMime', () => {
  it('accepts PNG/JPEG/WEBP for static, rejects video', () => {
    expect(isAllowedConceptMime('image/png', 'static')).toBe(true);
    expect(isAllowedConceptMime('image/jpeg', 'static')).toBe(true);
    expect(isAllowedConceptMime('image/webp', 'static')).toBe(true);
    expect(isAllowedConceptMime('video/mp4', 'static')).toBe(false);
    expect(isAllowedConceptMime('image/gif', 'static')).toBe(false);
  });

  it('accepts mp4/mov/m4v/webm for ugc, rejects images', () => {
    expect(isAllowedConceptMime('video/mp4', 'ugc')).toBe(true);
    expect(isAllowedConceptMime('video/quicktime', 'ugc')).toBe(true);
    expect(isAllowedConceptMime('video/x-m4v', 'ugc')).toBe(true);
    expect(isAllowedConceptMime('video/webm', 'ugc')).toBe(true);
    expect(isAllowedConceptMime('image/png', 'ugc')).toBe(false);
    expect(isAllowedConceptMime('application/pdf', 'ugc')).toBe(false);
  });
});

describe('Polish-9.1: maxConceptBytes', () => {
  it('static cap is 10 MB', () => {
    expect(maxConceptBytes('static')).toBe(10 * 1024 * 1024);
    expect(CONCEPT_STATIC_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ugc cap is 100 MB (matches reference-creatives bucket)', () => {
    expect(maxConceptBytes('ugc')).toBe(100 * 1024 * 1024);
    expect(CONCEPT_UGC_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('Polish-9.1: sanitizeConceptExt', () => {
  it('passes allowed extensions through (lowercased)', () => {
    expect(sanitizeConceptExt('clip.MP4')).toBe('.mp4');
    expect(sanitizeConceptExt('ad.mov')).toBe('.mov');
    expect(sanitizeConceptExt('photo.JPEG')).toBe('.jpeg');
    expect(sanitizeConceptExt('image.webp')).toBe('.webp');
  });

  it('drops disallowed extensions', () => {
    expect(sanitizeConceptExt('virus.exe')).toBe('');
    expect(sanitizeConceptExt('script.js')).toBe('');
    expect(sanitizeConceptExt('noext')).toBe('');
  });
});

describe('Polish-9.1: conceptStoragePathBelongsToUser', () => {
  const userId = '843ca6d6-233e-4c19-9ef1-4b8c0f6288d1';

  it('accepts the documented prefix scheme', () => {
    expect(conceptStoragePathBelongsToUser(`${userId}/concepts/abc-uuid/source.mp4`, userId)).toBe(
      true,
    );
  });

  it('rejects a path scoped to another user', () => {
    expect(
      conceptStoragePathBelongsToUser(
        '00000000-0000-0000-0000-000000000000/concepts/x/source.mp4',
        userId,
      ),
    ).toBe(false);
  });

  it('rejects paths with .. traversal even when prefix matches', () => {
    expect(
      conceptStoragePathBelongsToUser(
        `${userId}/concepts/../other-user/concepts/x/source.mp4`,
        userId,
      ),
    ).toBe(false);
  });

  it('rejects bare-userId paths (must include /concepts/)', () => {
    // Defense against a stale Polish-9 reference-creative path leaking.
    expect(conceptStoragePathBelongsToUser(`${userId}/uuid/something.mp4`, userId)).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(conceptStoragePathBelongsToUser('', userId)).toBe(false);
    expect(conceptStoragePathBelongsToUser(null as unknown as string, userId)).toBe(false);
    expect(conceptStoragePathBelongsToUser(undefined as unknown as string, userId)).toBe(false);
  });
});

describe('Polish-9.1: stripConceptExtension', () => {
  it('removes extension + path components, caps at 120', () => {
    expect(stripConceptExtension('winning-ad.mp4')).toBe('winning-ad');
    expect(stripConceptExtension('/Users/x/Movies/clip.mov')).toBe('clip');
    expect(stripConceptExtension('a'.repeat(200) + '.mp4').length).toBeLessThanOrEqual(120);
    expect(stripConceptExtension('')).toBe('Untitled concept');
  });
});
