import { describe, expect, it } from 'vitest';
import { POLISH_RELEASE_NAME, POLISH_RELEASE_SHA, POLISH_VERSION } from '../src/polish-version';

describe('Polish-21.0.15: POLISH_VERSION constant', () => {
  it('is a MAJOR.MINOR.PATCH string in the Polish-21/23/24/25/26/28 series', () => {
    // Regression pin: any typo (`25..0.2`, `25.0.2-beta`, trailing
    // whitespace) breaks downstream string-format consumers. Keep
    // the schema tight so a future bump can only land clean values.
    // Polish-25 launched patch-only (25.0.x) with the MakeUGC pivot;
    // Polish-25.1 is the first MINOR bump for the UX-layer overhaul.
    // Polish-25.6 = launch-readiness milestone.
    // Polish-26.0 Commit 61: first Polish-26 release lands the HeyGen
    // v3 backend replacement. Regex now permits the "26" major slot.
    expect(POLISH_VERSION).toMatch(
      /^2(1|3|4|5|6|7|8|9|10)\.\d+\.\d+$|^26\.\d+\.\d+$|^28\.\d+\.\d+$|^29\.\d+\.\d+$/,
    );
    // Polish-28.4.0 Commit 98: Meta launch backend un-hardcoded. The
    // 28.\d+.\d+ arm above already covers 28.4.x — no regex bump
    // needed. Pinned here so a future extractor can grep the version
    // history without hunting through commit messages.
    // Polish-28.3.0 Commit 85: MINOR-bump for variations pipeline is
    // covered by the existing 28.\d+.\d+ arm above.
  });

  it('is currently 29.0.18 (Polish-29.0.18 Commit 127 — fix: Dreamina asset upload uses raw bytes with image mime as Content-Type, not multipart)', () => {
    // The value MUST match packages/shared/src/polish-version.ts.
    // Bumping the constant without updating this pin fails CI —
    // that's the point: a version bump is a deliberate act, not
    // a silent edit.
    expect(POLISH_VERSION).toBe('29.0.18');
  });

  it('POLISH_RELEASE_NAME is a non-empty human-readable slug', () => {
    expect(typeof POLISH_RELEASE_NAME).toBe('string');
    expect(POLISH_RELEASE_NAME.length).toBeGreaterThan(0);
  });

  it('POLISH_RELEASE_SHA is a string (either env-injected SHA or the placeholder)', () => {
    // In test / local runs the placeholder fires. In Vercel prod
    // VERCEL_GIT_COMMIT_SHA is set and this becomes the real SHA.
    expect(typeof POLISH_RELEASE_SHA).toBe('string');
    expect(POLISH_RELEASE_SHA.length).toBeGreaterThan(0);
  });
});

describe('Polish-21.0.15: shared index re-exports', () => {
  it('POLISH_VERSION reachable from the @mbb/shared barrel', async () => {
    const barrel = await import('../src/index');
    expect(barrel.POLISH_VERSION).toBe(POLISH_VERSION);
    expect(barrel.POLISH_RELEASE_NAME).toBe(POLISH_RELEASE_NAME);
    // The @mbb/shared barrel is what apps/web + packages/jobs
    // import from. A future edit that removes the re-export line
    // (`export * from './polish-version'`) breaks the cross-
    // package rebuild chain silently — pin it here.
    expect(barrel.POLISH_RELEASE_SHA).toBeDefined();
  });
});
