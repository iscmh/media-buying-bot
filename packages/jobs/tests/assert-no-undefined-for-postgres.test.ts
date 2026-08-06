/**
 * Polish-26.0.13 Commit 62.3 tripwire: postgres-js UNDEFINED_VALUE
 * guards.
 *
 * Failure mode this defends against: three consecutive commits
 * (61.8 / 62.1 / 62.2) patched Inngest's UNDEFINED_VALUE (step
 * result serializer). Sync worker STILL failed with the same
 * error string. Real root cause: the project uses `postgres`
 * (postgres-js by porsager) as its DB driver, and postgres-js
 * throws its OWN UNDEFINED_VALUE from src/query.js when any
 * query parameter is undefined:
 *
 *   if (value === undefined)
 *     throw errors.generic('UNDEFINED_VALUE',
 *                          'Undefined values are not allowed')
 *
 * The stack trace's "Socket.emit + addChunk" was postgres-js's
 * binary protocol writer, not Inngest's step-result serializer.
 *
 * These tripwires fire BEFORE postgres-js sees the record, with
 * caller context + field name + full record snapshot — infinitely
 * more diagnostic than postgres-js's opaque error.
 */
import { describe, expect, it } from 'vitest';
import {
  assertArrayNoUndefinedForPostgres,
  assertNoUndefinedForPostgres,
  assertScalarDefinedForPostgres,
  rethrowWithUndefinedContext,
} from '../src/lib/assert-no-undefined-for-postgres';

describe('assertNoUndefinedForPostgres', () => {
  it('passes through a clean record unchanged', () => {
    const record = { a: 1, b: 'x', c: null, d: false, e: 0 };
    expect(assertNoUndefinedForPostgres(record, 'ctx')).toBe(record);
  });

  it('throws when any top-level value is undefined', () => {
    expect(() => assertNoUndefinedForPostgres({ a: 1, b: undefined }, 'test-ctx')).toThrow(
      /UNDEFINED_VALUE/,
    );
  });

  it('error names the offending field(s) and the caller context', () => {
    let caught: Error | null = null;
    try {
      assertNoUndefinedForPostgres({ a: 1, b: undefined, c: undefined, d: 'x' }, 'sync:persist');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/context=sync:persist/);
    expect(caught!.message).toMatch(/\bb\b/);
    expect(caught!.message).toMatch(/\bc\b/);
    // The two named fields must both appear; unrelated ones must not
    // be listed as offenders.
    expect(caught!.message).toMatch(/Undefined field\(s\): (b, c|c, b)/);
  });

  it('includes a JSON snapshot with __UNDEFINED__ markers', () => {
    let caught: Error | null = null;
    try {
      assertNoUndefinedForPostgres({ id: 'row_1', missing: undefined }, 'ctx');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/"missing":"__UNDEFINED__"/);
    expect(caught!.message).toMatch(/"id":"row_1"/);
  });

  it('keeps null / 0 / "" / false / NaN (these are NOT the postgres-js failure vector)', () => {
    const clean = {
      nullField: null,
      zero: 0,
      empty: '',
      flag: false,
      nan: NaN,
    };
    expect(() => assertNoUndefinedForPostgres(clean, 'ctx')).not.toThrow();
  });
});

describe('assertArrayNoUndefinedForPostgres', () => {
  it('returns the array (filtered) when every element is defined', () => {
    const arr = ['a', 'b', 'c'];
    expect(assertArrayNoUndefinedForPostgres(arr, 'ctx')).toEqual(['a', 'b', 'c']);
  });

  it('throws with element indices when any element is undefined', () => {
    let caught: Error | null = null;
    try {
      assertArrayNoUndefinedForPostgres(['a', undefined, 'c', undefined], 'sync:inArray');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/UNDEFINED_VALUE/);
    expect(caught!.message).toMatch(/context=sync:inArray/);
    expect(caught!.message).toMatch(/\[1, 3\]/);
  });

  it('keeps null / 0 / "" / false (only undefined trips the check)', () => {
    const arr = [null, 0, '', false];
    expect(() => assertArrayNoUndefinedForPostgres(arr, 'ctx')).not.toThrow();
    expect(assertArrayNoUndefinedForPostgres(arr, 'ctx')).toEqual([null, 0, '', false]);
  });
});

describe('assertScalarDefinedForPostgres', () => {
  it('returns the value when defined', () => {
    expect(assertScalarDefinedForPostgres('abc', 'userId', 'ctx')).toBe('abc');
    expect(assertScalarDefinedForPostgres(0, 'count', 'ctx')).toBe(0);
    expect(assertScalarDefinedForPostgres(null, 'nullable', 'ctx')).toBe(null);
    expect(assertScalarDefinedForPostgres(false, 'flag', 'ctx')).toBe(false);
  });

  it('throws with field name + context when undefined', () => {
    let caught: Error | null = null;
    try {
      assertScalarDefinedForPostgres(undefined, 'userId', 'sync:entry');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/userId/);
    expect(caught!.message).toMatch(/context=sync:entry/);
    expect(caught!.message).toMatch(/UNDEFINED_VALUE/);
  });
});

describe('rethrowWithUndefinedContext', () => {
  it('annotates postgres-js UNDEFINED_VALUE errors with the caller context', () => {
    // Simulates postgres-js's error message shape.
    const pgErr = new Error('UNDEFINED_VALUE: Undefined values are not allowed');
    let caught: Error | null = null;
    try {
      rethrowWithUndefinedContext(pgErr, 'sync:cron');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\[postgres-js UNDEFINED_VALUE at sync:cron\]/);
    expect(caught!.message).toContain('Undefined values are not allowed');
  });

  it('annotates errors that carry the code on the object shape', () => {
    // postgres-js also sets err.code = 'UNDEFINED_VALUE' on some paths.
    const pgErr = Object.assign(new Error('some driver-side message'), { code: 'UNDEFINED_VALUE' });
    expect(() => rethrowWithUndefinedContext(pgErr, 'ctx')).toThrow(
      /postgres-js UNDEFINED_VALUE at ctx/,
    );
  });

  it('re-throws unrelated errors unchanged', () => {
    const other = new Error('completely different problem');
    expect(() => rethrowWithUndefinedContext(other, 'ctx')).toThrow(other);
  });

  it('re-throws non-Error thrown values unchanged (never swallows)', () => {
    expect(() => rethrowWithUndefinedContext('string thrown', 'ctx')).toThrow();
    expect(() => rethrowWithUndefinedContext(42, 'ctx')).toThrow();
  });

  it('preserves the original error via .cause when annotating', () => {
    const pgErr = new Error('UNDEFINED_VALUE: Undefined values are not allowed');
    let caught: (Error & { cause?: unknown }) | null = null;
    try {
      rethrowWithUndefinedContext(pgErr, 'ctx');
    } catch (err) {
      caught = err as Error & { cause?: unknown };
    }
    expect(caught).not.toBeNull();
    expect(caught!.cause).toBe(pgErr);
  });
});

describe('end-to-end: the exact failure vector the operator hit', () => {
  it('catches an undefined userId slipping into what would be eq(column, userId)', () => {
    // The most likely leak in the sync worker: an eq() WHERE clause
    // where the parameter (userId) is bare undefined. Guard fires
    // at entry so no query is issued.
    expect(() =>
      assertScalarDefinedForPostgres(undefined, 'userId', 'refreshHeygenAvatarIndexCore:entry'),
    ).toThrow(/userId.*undefined.*UNDEFINED_VALUE/);
  });

  it('catches an undefined avatar_id inside a stripUndefined-cleaned record', () => {
    // stripUndefined would DROP an undefined avatarId, then Drizzle
    // would issue an INSERT without the PK -> NOT NULL constraint,
    // NOT the postgres-js UNDEFINED_VALUE class. The Commit 62.3
    // chunk-loop guard skips + logs before reaching Drizzle.
    // If a caller ever forgets that skip and passes an undefined
    // avatarId directly, this assert catches it (before stripUndefined
    // runs).
    let caught: Error | null = null;
    try {
      assertNoUndefinedForPostgres(
        { avatarId: undefined, avatarName: 'x' },
        'refresh-heygen:persist-avatar',
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/avatarId/);
    expect(caught!.message).toMatch(/persist-avatar/);
  });
});
