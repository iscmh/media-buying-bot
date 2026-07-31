import { describe, expect, it } from 'vitest';
import { computeFingerprint } from '../src/error-log';

/**
 * Polish-25.7 Commit 46: pin fingerprint normalization so the
 * /admin/errors grouped view keeps deduping the same repeated
 * errors across future edits. If someone tweaks the normalization
 * regexes without thinking, the group counts will silently drift
 * and one week of "same error 200 times" becomes 200 separate
 * groups again. This test catches that.
 */

describe('computeFingerprint: same source + normalized message → same hash', () => {
  it('collapses UUIDs so per-user errors group together', () => {
    const a = computeFingerprint(
      'worker',
      'meta/launch.requested',
      'Job 1ccebde7-5e2b-4d5a-9da7-28707a696645 failed to load context',
    );
    const b = computeFingerprint(
      'worker',
      'meta/launch.requested',
      'Job aa11bb22-cc33-dd44-ee55-ff6677889900 failed to load context',
    );
    expect(a).toBe(b);
  });

  it('collapses long numeric ids (>=8 digits) so per-ad errors group', () => {
    const a = computeFingerprint(
      'server_action',
      'launchApprovedAction',
      'Meta ad 123456789012 rejected',
    );
    const b = computeFingerprint(
      'server_action',
      'launchApprovedAction',
      'Meta ad 987654321098 rejected',
    );
    expect(a).toBe(b);
  });

  it('collapses ISO timestamps', () => {
    const a = computeFingerprint(
      'worker',
      'meta/launch.requested',
      'Snapshot at 2026-01-15T09:12:34.567Z stale',
    );
    const b = computeFingerprint(
      'worker',
      'meta/launch.requested',
      'Snapshot at 2026-07-31T23:00:00Z stale',
    );
    expect(a).toBe(b);
  });

  it('is case-insensitive on the message but sensitive to source', () => {
    const a = computeFingerprint('server_action', 'foo', 'Something FAILED');
    const b = computeFingerprint('server_action', 'foo', 'something failed');
    expect(a).toBe(b);

    const c = computeFingerprint('worker', 'foo', 'something failed');
    expect(c).not.toBe(a);
  });

  it('different source_name → different fingerprint even if message matches', () => {
    const a = computeFingerprint('server_action', 'launchApprovedAction', 'boom');
    const b = computeFingerprint('server_action', 'unpauseUserAction', 'boom');
    expect(a).not.toBe(b);
  });
});
