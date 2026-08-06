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
