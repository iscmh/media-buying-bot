/**
 * Polish-26.0.14 Commit 62.4 tripwire: per-step instrumentation
 * + widened error matcher.
 *
 * Failure mode this defends against: Commit 62.3 wrapped the outer
 * Inngest function bodies in try/rethrowWithUndefinedContext, but
 * the operator reported still seeing a BARE "Error: UNDEFINED_VALUE"
 * in Vercel logs with no [postgres-js UNDEFINED_VALUE at ...]
 * annotation prefix. Two possible causes:
 *
 *   (a) The outer catch was bypassed by Inngest's SDK internals.
 *   (b) The rethrow matcher didn't match the error's actual shape
 *       (e.g. Inngest wraps errors, hiding the real message on
 *       `.cause`).
 *
 * Commit 62.4 addresses both:
 *   - guardedStepRun wraps EVERY step.run with per-step try/catch
 *     + unique-marker logs — if the outer catch is bypassed the
 *     per-step catch still fires.
 *   - looksLikeUndefinedValueError walks the .cause chain (up to
 *     depth 5, cycle-safe) and also matches on Inngest v3's
 *     SerializationError class name.
 *   - safeErrorShape produces a JSON-safe snapshot of any thrown
 *     value (Error / object / undefined / primitive) so the raw
 *     log line always shows what was caught.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  guardedStepRun,
  rethrowWithUndefinedContext,
  safeErrorShape,
} from '../src/lib/assert-no-undefined-for-postgres';

describe('rethrowWithUndefinedContext — widened matcher', () => {
  it('matches Error whose message contains UNDEFINED_VALUE (postgres-js shape)', () => {
    const err = new Error('UNDEFINED_VALUE: Undefined values are not allowed');
    expect(() => rethrowWithUndefinedContext(err, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('matches bare "UNDEFINED_VALUE" message (Inngest v3 shape)', () => {
    // Inngest v3's SerializationError message is sometimes just
    // the code itself with no descriptive suffix.
    const err = new Error('UNDEFINED_VALUE');
    expect(() => rethrowWithUndefinedContext(err, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('matches on err.code === UNDEFINED_VALUE (postgres-js object shape)', () => {
    const err = { code: 'UNDEFINED_VALUE', message: 'anything' };
    expect(() => rethrowWithUndefinedContext(err, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('walks .cause chain — Inngest v3 wraps errors and hides real message on cause', () => {
    // The exact shape reported: outer Inngest wrapper doesn't
    // mention UNDEFINED_VALUE in its own message; real error on
    // .cause. Commit 62.3's matcher missed this shape.
    const inner = new Error('UNDEFINED_VALUE: Undefined values are not allowed');
    const wrapper = Object.assign(new Error('step failed with error'), { cause: inner });
    expect(() => rethrowWithUndefinedContext(wrapper, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('walks deep .cause chains (up to depth 5, cycle-safe)', () => {
    const level0 = new Error('UNDEFINED_VALUE');
    const level1 = Object.assign(new Error('lvl1'), { cause: level0 });
    const level2 = Object.assign(new Error('lvl2'), { cause: level1 });
    const level3 = Object.assign(new Error('lvl3'), { cause: level2 });
    expect(() => rethrowWithUndefinedContext(level3, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('matches Inngest v3 SerializationError class + "undefined" in message', () => {
    const err = Object.assign(new Error('undefined value returned from step'), {
      name: 'SerializationError',
    });
    expect(() => rethrowWithUndefinedContext(err, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('matches when a callback throws bare undefined (rare but real)', () => {
    // `throw undefined` — the caller-facing catch receives undefined.
    // Pre-fix this fell through unlogged; now it annotates as a
    // recognizable UNDEFINED_VALUE case.
    expect(() => rethrowWithUndefinedContext(undefined, 'ctx')).toThrow(/UNDEFINED_VALUE at ctx/);
  });

  it('re-throws unrelated errors unchanged (no false positives)', () => {
    const err = new Error('CONNECTION_TIMEOUT: totally different');
    let thrown: unknown = null;
    try {
      rethrowWithUndefinedContext(err, 'ctx');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err); // same reference — not annotated
  });

  it('does NOT match Error whose cause is unrelated', () => {
    const wrapper = Object.assign(new Error('outer'), {
      cause: new Error('inner unrelated'),
    });
    let thrown: unknown = null;
    try {
      rethrowWithUndefinedContext(wrapper, 'ctx');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(wrapper);
  });

  it('always console.errors the raw shape (proves the catch fired)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      rethrowWithUndefinedContext(new Error('CONNECTION_TIMEOUT'), 'ctx');
    } catch {
      // expected
    }
    expect(spy).toHaveBeenCalled();
    const logCall = spy.mock.calls.find((c) =>
      String(c[0]).includes('[rethrowWithUndefinedContext]'),
    );
    expect(logCall).toBeDefined();
    spy.mockRestore();
  });
});

describe('safeErrorShape', () => {
  it('formats an Error into a JSON-safe object with name/message/stack', () => {
    const err = new Error('boom');
    const shape = safeErrorShape(err);
    expect(shape.message).toBe('boom');
    expect(shape.name).toBe('Error');
    expect(typeof shape.stack).toBe('string');
  });

  it('recursively formats .cause chains', () => {
    const inner = new Error('inner');
    const outer = Object.assign(new Error('outer'), { cause: inner });
    const shape = safeErrorShape(outer) as { cause?: { message?: string } };
    expect(shape.cause?.message).toBe('inner');
  });

  it('flags a bare undefined thrown value', () => {
    expect(safeErrorShape(undefined)).toEqual({ __thrownValue: 'undefined' });
  });

  it('flags a bare null thrown value', () => {
    expect(safeErrorShape(null)).toEqual({ __thrownValue: 'null' });
  });

  it('preserves err.code on plain objects (postgres-js shape)', () => {
    const err = { code: 'UNDEFINED_VALUE', message: 'x' };
    const shape = safeErrorShape(err);
    expect(shape.code).toBe('UNDEFINED_VALUE');
    expect(shape.message).toBe('x');
  });

  it('truncates the stack to 800 chars', () => {
    const err = Object.assign(new Error('boom'), { stack: 'x'.repeat(5000) });
    const shape = safeErrorShape(err) as { stack?: string };
    expect(shape.stack?.length).toBe(800);
  });

  it('handles primitive thrown values (string / number / boolean)', () => {
    expect(safeErrorShape('str')).toEqual({ __thrownValue: 'str', type: 'string' });
    expect(safeErrorShape(42)).toEqual({ __thrownValue: '42', type: 'number' });
  });
});

describe('guardedStepRun — per-step instrumentation', () => {
  // Minimal fake step whose .run(id, fn) just invokes fn().
  function makeFakeStep() {
    return {
      run: async (_id: string, fn: () => Promise<unknown>) => await fn(),
    };
  }

  it('passes through a successful step return', async () => {
    const step = makeFakeStep();
    const result = await guardedStepRun(step, 'test-step', async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('logs a BEFORE marker so execution order is traceable in Vercel logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const step = makeFakeStep();
    await guardedStepRun(step, 'my-step', async () => 'result');
    const beforeLog = logSpy.mock.calls.find((c) =>
      String(c[0]).includes('[guardedStepRun] BEFORE step=my-step'),
    );
    expect(beforeLog).toBeDefined();
    logSpy.mockRestore();
  });

  it('re-throws unrelated errors unchanged', async () => {
    const step = makeFakeStep();
    const inputErr = new Error('CONNECTION_TIMEOUT: unrelated');
    let thrown: unknown = null;
    try {
      await guardedStepRun(step, 'my-step', async () => {
        throw inputErr;
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(inputErr);
  });

  it('annotates UNDEFINED_VALUE errors with step-scoped context', async () => {
    const step = makeFakeStep();
    let thrown: (Error & { cause?: unknown }) | null = null;
    try {
      await guardedStepRun(step, 'chunk-42', async () => {
        throw new Error('UNDEFINED_VALUE: Undefined values are not allowed');
      });
    } catch (e) {
      thrown = e as Error & { cause?: unknown };
    }
    expect(thrown).not.toBeNull();
    // Annotated by inner OR outer catch layer — both use step:<id> prefix.
    expect(thrown!.message).toMatch(/UNDEFINED_VALUE at step:chunk-42/);
  });

  it('inner-catch fires on step-callback throw (proves per-step guard works)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const step = makeFakeStep();
    try {
      await guardedStepRun(step, 'chunk-99', async () => {
        throw new Error('UNDEFINED_VALUE');
      });
    } catch {
      // expected
    }
    const innerLog = errSpy.mock.calls.find((c) =>
      String(c[0]).includes('[guardedStepRun] step=chunk-99 inner-catch'),
    );
    expect(innerLog).toBeDefined();
    errSpy.mockRestore();
  });

  it('preserves original error via .cause on annotation', async () => {
    const step = makeFakeStep();
    const inputErr = new Error('UNDEFINED_VALUE');
    let thrown: (Error & { cause?: unknown }) | null = null;
    try {
      await guardedStepRun(step, 'test-step', async () => {
        throw inputErr;
      });
    } catch (e) {
      thrown = e as Error & { cause?: unknown };
    }
    expect(thrown).not.toBeNull();
    // Cause is either the raw input or a wrapping annotated error;
    // in both cases the original error is reachable via the chain.
    let seenOriginal = false;
    let current: unknown = thrown;
    for (let d = 0; d < 5 && current; d++) {
      if (current === inputErr) seenOriginal = true;
      current = (current as { cause?: unknown })?.cause;
    }
    expect(seenOriginal).toBe(true);
  });
});
