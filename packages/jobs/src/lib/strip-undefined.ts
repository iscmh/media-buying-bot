/**
 * Polish-26.0.8 Commit 61.8: shallow undefined-value stripper.
 *
 * Two failure modes it defends against, both surfaced as
 * "UNDEFINED_VALUE" from Inngest:
 *
 *   1. Inngest serializes step.run() return values (and event
 *      payloads) as JSON. `undefined` is NOT a valid JSON value —
 *      Inngest's SDK throws UNDEFINED_VALUE before persisting
 *      the step's result, aborting the whole function. Any object
 *      returned from a step.run body must have every field either
 *      present with a real value OR present-and-null OR omitted
 *      entirely.
 *
 *   2. Drizzle's `.set({...})` in an UPDATE serializes the record
 *      shallowly. A field with value `undefined` gets dropped
 *      silently in some code paths but crashes in others depending
 *      on driver version. Safest is to strip before handing to
 *      Drizzle.
 *
 * Scope is INTENTIONALLY shallow: nested objects pass through
 * untouched. Deep-strip would require type recursion that risks
 * mangling arrays / typed structures the caller depends on. When
 * a nested field is the actual source of trouble, coerce
 * explicitly with `?? null` at the call site (see the
 * polish26_avatar_match projection in generate-polish26-heygen.ts
 * for the canonical pattern).
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Polish-26.0.11 Commit 62.1: DEEP undefined-value stripper.
 *
 * The shallow variant above (Commit 61.8) works when the top-level
 * object is the sole boundary — e.g. Drizzle `.set()` where every
 * value is a scalar or Postgres JSON that won't be re-inspected.
 * The Commit 62 sync worker returns step results that CARRY nested
 * dicts (FailureSample.diagnostics, geminiRawBody excerpts) — a
 * shallow strip leaves an `undefined` key inside diagnostics and
 * Inngest's step-result serializer still throws UNDEFINED_VALUE.
 *
 * Deep-strip walks plain objects recursively, drops `undefined`-
 * valued keys at every level. Preserves:
 *   - null / 0 / '' / false / NaN (meaningful JSON)
 *   - Arrays: recurses into elements, keeps array shape
 *   - Non-plain objects (Date, RegExp, Buffer, Map, Set, class
 *     instances): passed through as-is because deep-cloning
 *     them here would mangle downstream consumers
 *
 * Cycle-safe via a WeakSet — a self-referential input returns a
 * shallow copy at the first repeat, never blowing the stack.
 *
 * Use this at every Inngest step.run() return boundary in a worker
 * that constructs objects from mixed sources (analyzer diagnostics,
 * Zod parse output, DB rows).
 */
type DeepStripped<T> = T extends undefined
  ? never
  : T extends readonly (infer U)[]
    ? Array<DeepStripped<U>>
    : T extends object
      ? { [K in keyof T]: DeepStripped<T[K]> }
      : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function stripUndefinedDeep<T>(value: T): DeepStripped<T> {
  const seen = new WeakSet<object>();
  function walk(v: unknown): unknown {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return v;
    seen.add(v as object);
    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }
    if (!isPlainObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = walk(val);
    }
    return out;
  }
  return walk(value) as DeepStripped<T>;
}

/**
 * Polish-26.0.12 Commit 62.2: sanitize a value for Inngest's
 * step-result serializer. Two failure modes both surface as
 * UNDEFINED_VALUE at the step boundary:
 *
 *   1. The overall result is `undefined` — void async callbacks
 *      trip this because `JSON.stringify(undefined)` returns
 *      undefined, not a JSON scalar. Commit 62.1's deep-strip
 *      doesn't help here; the input was never an object.
 *      Real evidence: sync worker's `mark-disappeared-deleted`
 *      and `touch-fresh-rows` steps ran void callbacks (no
 *      explicit return) — post-26.0.11, still UNDEFINED_VALUE.
 *
 *   2. Any nested undefined-valued key inside a returned object
 *      (the 62.1 vector).
 *
 * safeInngestStepReturn maps undefined → { _void: true } (an
 * inert sentinel that JSON.stringify serializes fine) and runs
 * everything else through stripUndefinedDeep. Wrap every
 * step.run() callback return in the sync worker with this.
 *
 * The `_void: true` sentinel is intentional shape — grep-friendly
 * if a downstream consumer ever tries to read the result of a
 * void step. Reading it as a summary is fine (it just says "this
 * step didn't produce a value").
 */
export const INNGEST_VOID_STEP_RESULT = { _void: true } as const;

export function safeInngestStepReturn<T>(
  value: T,
): T extends undefined ? typeof INNGEST_VOID_STEP_RESULT : DeepStripped<T> {
  if (value === undefined) {
    return INNGEST_VOID_STEP_RESULT as T extends undefined
      ? typeof INNGEST_VOID_STEP_RESULT
      : DeepStripped<T>;
  }
  return stripUndefinedDeep(value) as T extends undefined
    ? typeof INNGEST_VOID_STEP_RESULT
    : DeepStripped<T>;
}
