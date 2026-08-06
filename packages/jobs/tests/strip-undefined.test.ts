import { describe, expect, it } from 'vitest';
import { stripUndefined } from '../src/lib/strip-undefined';

/**
 * Polish-26.0.8 Commit 61.8 tripwire: the undefined-value stripper
 * that guards every metadata write in the polish26-heygen worker
 * (and, by extension, every downstream Inngest step whose result
 * gets serialized to the run journal).
 *
 * Failure mode this defends against: Inngest raises
 * "UNDEFINED_VALUE" when a step.run body returns (or a Drizzle
 * update sets) an object containing any `undefined`-valued key.
 * Aborts the function BEFORE any `if (!x)` guard downstream gets
 * to run — surfaced on Inngest run 01KZBK8ZRY990R72PD4BW039JG
 * (Polish-26.0.7 era). Strip at the boundary keeps every write
 * safe.
 *
 * Contract the tests pin:
 *   - undefined values dropped
 *   - null / 0 / '' / false / NaN kept (they are meaningful JSON)
 *   - nested objects passed through untouched (deep-strip would
 *     mangle arrays + typed nested structures)
 *   - empty input → {}
 *   - original object not mutated
 */

describe('stripUndefined', () => {
  it('drops keys with undefined values', () => {
    const input = { a: 1, b: undefined, c: 'yes' };
    expect(stripUndefined(input)).toEqual({ a: 1, c: 'yes' });
  });

  it('keeps null (present-as-null is meaningful JSON)', () => {
    // This is THE critical distinction for the polish26_avatar_match
    // projection. Nullable heygen_avatar_index columns get `?? null`
    // at the projection site; if we stripped null here, all that
    // work would be undone.
    expect(stripUndefined({ hair_style: null, hair_color: 'brown' })).toEqual({
      hair_style: null,
      hair_color: 'brown',
    });
  });

  it('keeps falsy-but-defined values (0, empty string, false, NaN)', () => {
    // Every one of these is a valid JSON value the metadata
    // consumer might depend on — the stripper MUST NOT touch them.
    const input = { zero: 0, empty: '', flag: false, nan: NaN };
    const out = stripUndefined(input);
    expect(out.zero).toBe(0);
    expect(out.empty).toBe('');
    expect(out.flag).toBe(false);
    // NaN !== NaN in JS but the key must still be present.
    expect('nan' in out).toBe(true);
  });

  it('is shallow — nested undefined values pass through untouched', () => {
    // Deep-strip would mangle arrays / typed nested structures.
    // Call sites that need to sanitize nested values do so
    // explicitly with `?? null` at the projection.
    const input = {
      keep: 1,
      drop: undefined,
      nested: { inner: undefined, alsoInner: 'kept' },
    };
    const out = stripUndefined(input);
    expect(out).toEqual({
      keep: 1,
      nested: { inner: undefined, alsoInner: 'kept' },
    });
  });

  it('returns {} on an empty input', () => {
    expect(stripUndefined({})).toEqual({});
  });

  it('does not mutate the input object', () => {
    const input = { a: 1, b: undefined };
    const before = Object.keys(input).sort();
    stripUndefined(input);
    expect(Object.keys(input).sort()).toEqual(before);
    // 'b' still present on the original.
    expect('b' in input).toBe(true);
  });

  it('handles the operator-reported polish26_avatar_match shape without dropping null coercions', () => {
    // Simulates the Commit-61.8 projection after `?? null`
    // coercion. All nullable heygen_avatar_index columns land as
    // present-and-null; only truly-undefined keys get dropped.
    const projection = {
      matchStrategy: 'enriched-index' as const,
      winnerAvatarId: 'avatar_123',
      winnerAgeBucket: '30s',
      winnerEthnicity: null, // avatar row had null
      winnerHairColor: null, // avatar row had null
      winnerHairStyle: null,
      winnerFacialHair: null,
      winnerWardrobeStyle: null,
      winnerWardrobeSummary: null,
      winnerBackground: 'indoor_home',
      backgroundTier: 'primary' as const,
      // Simulates a stray undefined that would otherwise crash Inngest.
      somethingAccidentallyUndefined: undefined,
    };
    const out = stripUndefined(projection);
    expect('somethingAccidentallyUndefined' in out).toBe(false);
    expect(out.winnerEthnicity).toBeNull();
    expect(out.winnerHairColor).toBeNull();
    expect(out.winnerHairStyle).toBeNull();
    expect(out.winnerAvatarId).toBe('avatar_123');
  });
});
