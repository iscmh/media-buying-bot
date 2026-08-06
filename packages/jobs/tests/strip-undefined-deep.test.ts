/**
 * Polish-26.0.11 Commit 62.1 tripwire: deep undefined stripper.
 *
 * Failure mode this defends against: refresh-heygen-avatar-index
 * (the Commit 62 sync worker) returns step results that carry
 * nested `diagnostics` dicts sourced from the Gemini analyzer.
 * The Commit 61.8 shallow stripUndefined stops at the top level;
 * an `undefined`-valued key nested inside diagnostics
 * (e.g. `geminiStatus: undefined` when the HTTP response lacked
 * a status field) still trips Inngest's UNDEFINED_VALUE at the
 * step-result serializer.
 *
 * stripUndefinedDeep walks recursively, dropping every
 * undefined-valued key at every level. Preserves null / 0 / '' /
 * false / NaN (meaningful JSON), preserves array shape (with
 * per-element recursion), passes through non-plain objects
 * (Date, Buffer, class instances) untouched.
 */
import { describe, expect, it } from 'vitest';
import { stripUndefinedDeep } from '../src/lib/strip-undefined';

describe('stripUndefinedDeep', () => {
  it('drops top-level undefined keys', () => {
    expect(stripUndefinedDeep({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it("drops nested undefined keys — the Commit 62.1 raison-d'être", () => {
    // This is the failure-sample-with-diagnostics shape. Nested
    // `geminiStatus: undefined` from the analyzer would have leaked
    // through the shallow strip and tripped UNDEFINED_VALUE.
    const input = {
      avatarId: 'a1',
      diagnostics: {
        imageMime: 'image/webp',
        geminiStatus: undefined,
        geminiRawBodyExcerpt: '(500)',
      },
    };
    expect(stripUndefinedDeep(input)).toEqual({
      avatarId: 'a1',
      diagnostics: { imageMime: 'image/webp', geminiRawBodyExcerpt: '(500)' },
    });
  });

  it('keeps null (present-as-null is meaningful JSON)', () => {
    expect(stripUndefinedDeep({ a: null, b: { c: null } })).toEqual({
      a: null,
      b: { c: null },
    });
  });

  it('keeps falsy-but-defined values (0, empty string, false, NaN)', () => {
    const out = stripUndefinedDeep({
      zero: 0,
      empty: '',
      flag: false,
      nan: NaN,
      nested: { zero: 0, flag: false },
    });
    expect(out.zero).toBe(0);
    expect(out.empty).toBe('');
    expect(out.flag).toBe(false);
    expect('nan' in out).toBe(true);
    expect(out.nested).toEqual({ zero: 0, flag: false });
  });

  it('recurses into arrays and cleans object elements', () => {
    const input = {
      samples: [
        { id: 1, error: undefined },
        { id: 2, error: 'boom' },
      ],
    };
    expect(stripUndefinedDeep(input)).toEqual({
      samples: [{ id: 1 }, { id: 2, error: 'boom' }],
    });
  });

  it('preserves array shape (does not drop undefined elements — they become undefined)', () => {
    // Array positions carry positional meaning; dropping middle
    // elements would shift indices. We do NOT filter arrays,
    // only recurse into object elements. Primitive undefined
    // elements pass through as-is (JSON.stringify will turn them
    // into null downstream anyway).
    const input = [1, undefined, 3];
    const out = stripUndefinedDeep(input);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(1);
    expect(out[2]).toBe(3);
  });

  it('passes through non-plain objects untouched (Date, Buffer, class instances)', () => {
    class Marker {
      value = 42;
    }
    const marker = new Marker();
    const date = new Date('2026-01-01T00:00:00Z');
    const buffer = Buffer.from('hi', 'utf8');
    const out = stripUndefinedDeep({ marker, date, buffer, drop: undefined });
    expect(out.marker).toBe(marker);
    expect(out.date).toBe(date);
    expect(out.buffer).toBe(buffer);
    expect('drop' in out).toBe(false);
  });

  it('returns {} for {}', () => {
    expect(stripUndefinedDeep({})).toEqual({});
  });

  it('is cycle-safe on self-referential inputs', () => {
    interface Node {
      name: string;
      drop?: undefined;
      self?: Node;
    }
    const root: Node = { name: 'root', drop: undefined };
    root.self = root;
    // Should not blow the stack; the cycle is broken by returning
    // the object once seen. Content check: top-level drop is gone.
    const out = stripUndefinedDeep(root);
    expect(out.name).toBe('root');
    expect('drop' in out).toBe(false);
  });

  it('does not mutate the input object', () => {
    const input = { a: 1, b: undefined, nested: { c: undefined, d: 'kept' } };
    stripUndefinedDeep(input);
    expect('b' in input).toBe(true);
    expect('c' in input.nested).toBe(true);
  });

  it('handles the operator-reported FailureSample shape without leaking undefined', () => {
    // Mirrors the exact chunkFailureSamples[i] payload the sync
    // worker returns from step.run. Every level must be undefined-
    // free after the deep strip.
    const sample = {
      avatarId: 'heygen_abc123',
      avatarName: 'Alex_Suit_public',
      previewUrl: 'https://files2.heygen.ai/xyz.webp',
      errorMessage: 'schema-fail: cannot coerce required field(s): ethnicity',
      signature: 'schema:ethnicity',
      diagnostics: {
        imageMime: 'image/webp',
        imageBytes: 45231,
        imageFetchStatus: 200,
        geminiStatus: undefined, // <-- the failure vector
        geminiRawBodyExcerpt: '{"candidates":...',
        failedAt: 'parse',
        mimeInferred: true,
        mimeInferredFrom: 'url-extension',
        mimeSentToGemini: 'image/webp',
      },
      schemaFieldIssues: ['ethnicity: martian not in enum + no alias'],
      schemaRawSnapshot: '{"age_bucket":"30s","ethnicity":"martian",...}',
    };
    const out = stripUndefinedDeep(sample) as typeof sample;
    // Every undefined-valued key is dropped, everything else preserved.
    expect(out.avatarId).toBe(sample.avatarId);
    expect(out.diagnostics.imageMime).toBe('image/webp');
    expect('geminiStatus' in out.diagnostics).toBe(false);
    expect(out.diagnostics.failedAt).toBe('parse');
    expect(out.schemaFieldIssues).toEqual(sample.schemaFieldIssues);
    // Bulletproof: no undefined values anywhere in the tree.
    const flatCheck = JSON.stringify(out);
    expect(flatCheck.includes('undefined')).toBe(false);
  });
});
