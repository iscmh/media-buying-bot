import { describe, expect, it } from 'vitest';
import { POLISH_RELEASE_NAME, POLISH_RELEASE_SHA, POLISH_VERSION } from '../src/polish-version';

describe('Polish-21.0.15: POLISH_VERSION constant', () => {
  it('is a MAJOR.MINOR.PATCH string in the Polish-21/23 series', () => {
    // Regression pin: any typo (`23..0.2`, `23.0.2-beta`, trailing
    // whitespace) breaks downstream string-format consumers. Keep
    // the schema tight so a future bump can only land clean values.
    expect(POLISH_VERSION).toMatch(/^2(1|3)\.0\.\d+$/);
  });

  it('is currently 23.0.14 (Polish-23 Commit 3.0.7 — bump this pin deliberately on the next hotfix)', () => {
    // The value MUST match packages/shared/src/polish-version.ts.
    // Bumping the constant without updating this pin fails CI —
    // that's the point: a version bump is a deliberate act, not
    // a silent edit.
    expect(POLISH_VERSION).toBe('23.0.14');
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
