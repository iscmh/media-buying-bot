/**
 * Polish-26.0.12 Commit 62.2 tripwire: safeInngestStepReturn.
 *
 * Failure mode this defends against: even AFTER Commit 62.1's
 * deep-strip landed, the sync worker still failed with Inngest
 * UNDEFINED_VALUE. Root cause turned out to be two void-callback
 * steps (mark-disappeared-deleted + touch-fresh-rows) — their
 * async callbacks had no explicit return, so the promise resolved
 * to bare undefined. `JSON.stringify(undefined)` returns undefined
 * (not a JSON scalar), and Inngest v3 flags exactly that at the
 * step-result boundary.
 *
 * Commit 62.1's deep-strip is defined only for objects/arrays; a
 * bare undefined never enters the walker. safeInngestStepReturn is
 * the two-part fix:
 *   (a) undefined value → { _void: true } sentinel (JSON-safe)
 *   (b) anything else → stripUndefinedDeep (Commit 62.1 vector)
 *
 * Wrap EVERY step.run() callback return in the sync worker with
 * this. Turning a step return into a compile-time contract would
 * require patching Inngest's types; the wrapper is the safest
 * runtime alternative.
 */
import { describe, expect, it } from 'vitest';
import { INNGEST_VOID_STEP_RESULT, safeInngestStepReturn } from '../src/lib/strip-undefined';

describe('safeInngestStepReturn — void-callback coercion', () => {
  it('maps bare undefined to the void sentinel { _void: true }', () => {
    // The failure vector: an async () => { await db.something(); }
    // callback resolves to undefined. Post-fix, the wrapper returns
    // an inert JSON-serializable sentinel instead.
    expect(safeInngestStepReturn(undefined)).toEqual({ _void: true });
    expect(safeInngestStepReturn(undefined)).toBe(INNGEST_VOID_STEP_RESULT);
  });

  it('JSON.stringify of the void sentinel is a real JSON string (not undefined)', () => {
    // Inngest's check is essentially JSON.stringify(result) !== undefined.
    // The sentinel MUST serialize to something.
    const stringified = JSON.stringify(safeInngestStepReturn(undefined));
    expect(stringified).toBe('{"_void":true}');
    expect(stringified).not.toBe(undefined);
  });
});

describe('safeInngestStepReturn — pass-through with deep-strip', () => {
  it('deep-strips object returns (composes Commit 62.1 vector)', () => {
    const out = safeInngestStepReturn({
      keep: 1,
      drop: undefined,
      nested: { alsoDrop: undefined, alsoKeep: 'yes' },
    });
    expect(out).toEqual({ keep: 1, nested: { alsoKeep: 'yes' } });
  });

  it('passes through primitives untouched', () => {
    expect(safeInngestStepReturn('hello')).toBe('hello');
    expect(safeInngestStepReturn(42)).toBe(42);
    expect(safeInngestStepReturn(false)).toBe(false);
    expect(safeInngestStepReturn(0)).toBe(0);
    expect(safeInngestStepReturn('')).toBe('');
  });

  it('passes through null (present-as-null is meaningful JSON)', () => {
    expect(safeInngestStepReturn(null)).toBe(null);
  });

  it('deep-strips arrays of objects', () => {
    const out = safeInngestStepReturn([
      { id: 1, drop: undefined },
      { id: 2, drop: undefined },
    ]);
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('handles the sync-worker chunk-return shape end-to-end', () => {
    // The exact shape returned from analyze-persist-chunk-N step.run.
    // Post-fix, every level is clean regardless of upstream drift.
    const chunkResult = {
      attempted: 12,
      successful: 10,
      failed: 2,
      coerced: 1,
      persisted: 10,
      costUsd: 0.0034,
      resultSigs: [
        null,
        null,
        null,
        'schema:ethnicity',
        null,
        null,
        null,
        null,
        null,
        null,
        'schema:hair_color',
        null,
      ],
      chunkFailureSamples: [
        {
          avatarId: 'heygen_x',
          avatarName: 'Alex',
          previewUrl: 'https://x.webp',
          errorMessage: 'schema-fail',
          signature: 'schema:ethnicity',
          diagnostics: {
            imageMime: 'image/webp',
            geminiStatus: undefined, // <-- 62.1 vector
            failedAt: 'parse',
          },
          schemaFieldIssues: ['ethnicity: martian'],
          schemaRawSnapshot: '{}',
        },
      ],
    };
    const out = safeInngestStepReturn(chunkResult) as typeof chunkResult;
    expect(out.attempted).toBe(12);
    // Nested undefined dropped
    const firstSample = out.chunkFailureSamples[0]!;
    expect('geminiStatus' in firstSample.diagnostics).toBe(false);
    // Top-level array preserved
    expect(out.chunkFailureSamples.length).toBe(1);
    // Full-tree serialization check — proves nothing undefined remains.
    expect(JSON.stringify(out).includes('undefined')).toBe(false);
  });

  it('handles the sync-worker void-step return shape (Commit 62.2 fix path)', () => {
    // The exact fix pattern used in mark-disappeared-deleted +
    // touch-fresh-rows: an object with a defined summary field.
    const softDeleteReturn = safeInngestStepReturn({ softDeleted: 42 });
    expect(softDeleteReturn).toEqual({ softDeleted: 42 });
    const touchReturn = safeInngestStepReturn({ touched: 800 });
    expect(touchReturn).toEqual({ touched: 800 });
    // Both serialize cleanly for Inngest.
    expect(JSON.stringify(softDeleteReturn)).toBe('{"softDeleted":42}');
    expect(JSON.stringify(touchReturn)).toBe('{"touched":800}');
  });
});
