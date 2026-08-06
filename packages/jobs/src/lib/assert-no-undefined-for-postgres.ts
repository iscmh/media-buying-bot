/**
 * Polish-26.0.13 Commit 62.3: postgres-js UNDEFINED_VALUE guard.
 *
 * The project uses `postgres` (postgres-js by porsager) as the
 * database driver behind Drizzle. When a query parameter is
 * `undefined` — top-level in `.values()`, `.set()`, or an
 * argument to `eq()` / `inArray()` — postgres-js throws its own
 * error with code UNDEFINED_VALUE from src/query.js:
 *
 *   if (value === undefined)
 *     throw errors.generic('UNDEFINED_VALUE',
 *                          'Undefined values are not allowed')
 *
 * This is DISTINCT from Inngest v3's UNDEFINED_VALUE (step-result
 * serializer) — Commits 61.8 / 62.1 / 62.2 patched the Inngest
 * side. Commit 62.3 patches the postgres-js side, which was the
 * actual leak in the sync worker (the Socket.emit + addChunk
 * stack trace was postgres-js's binary protocol writer, not
 * Inngest).
 *
 * assertNoUndefinedForPostgres walks the record shallowly (Drizzle
 * only binds top-level values) and throws BEFORE postgres-js sees
 * the query. The thrown error names the offending field, the
 * calling context, and dumps the full sanitized record — infinitely
 * more diagnostic than postgres-js's opaque "Undefined values are
 * not allowed".
 *
 * Use at every Drizzle write call site:
 *   assertNoUndefinedForPostgres(record, 'refresh-heygen-avatar-index:persist');
 *   await db.insert(...).values(record).onConflictDoUpdate({ set: record });
 *
 * Also exports assertArrayNoUndefinedForPostgres for `inArray` /
 * `notInArray` inputs — a single undefined element in the list is
 * enough to trip postgres-js.
 */

/**
 * Throws a diagnostic-rich Error if `record` contains any
 * undefined top-level value. Returns `record` unchanged on
 * success (chainable).
 *
 * The thrown message includes:
 *   - Every field whose value is undefined (comma-separated)
 *   - The caller-provided `context` string (step name / call site)
 *   - JSON-stringified snapshot of the whole record (truncated at
 *     2000 chars) so an operator reading the log sees the ACTUAL
 *     row that failed
 *
 * Non-goal: value coercion. Callers must guarantee defined values
 * upstream (via `?? null` at the projection); this helper is a
 * tripwire, not a sanitizer. It DOES catch the case where a
 * shallow `stripUndefined` already ran but a downstream mutation
 * re-introduced undefined.
 */
export function assertNoUndefinedForPostgres<T extends Record<string, unknown>>(
  record: T,
  context: string,
): T {
  const undefinedFields: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) undefinedFields.push(key);
  }
  if (undefinedFields.length > 0) {
    const snapshot = JSON.stringify(record, (_k, v) =>
      v === undefined ? '__UNDEFINED__' : v,
    ).slice(0, 2000);
    throw new Error(
      `[assertNoUndefinedForPostgres] context=${context} would trip postgres-js UNDEFINED_VALUE. ` +
        `Undefined field(s): ${undefinedFields.join(', ')}. Record snapshot (undefined marked as ` +
        `__UNDEFINED__): ${snapshot}`,
    );
  }
  return record;
}

/**
 * Throws a diagnostic-rich Error if `arr` contains any undefined
 * element. Returns `arr` (filtered to defined-only) on success.
 *
 * Use at `inArray` / `notInArray` call sites:
 *   const ids = assertArrayNoUndefinedForPostgres(rawIds, 'sync:soft-delete');
 *   .where(inArray(schema.foo.id, ids));
 *
 * Also useful as a defense on where-clause `eq(column, value)`
 * — call sites can guard: `assertArrayNoUndefinedForPostgres([userId], ctx)`
 * before running the query.
 */
export function assertArrayNoUndefinedForPostgres<T>(arr: readonly T[], context: string): T[] {
  const undefinedIndices: number[] = [];
  arr.forEach((v, i) => {
    if (v === undefined) undefinedIndices.push(i);
  });
  if (undefinedIndices.length > 0) {
    throw new Error(
      `[assertArrayNoUndefinedForPostgres] context=${context} would trip postgres-js ` +
        `UNDEFINED_VALUE. Undefined element indices: [${undefinedIndices.join(', ')}] out of ` +
        `${arr.length}. First 20 elements: ${JSON.stringify(arr.slice(0, 20), (_k, v) => (v === undefined ? '__UNDEFINED__' : v))}`,
    );
  }
  return arr.filter((v): v is Exclude<T, undefined> => v !== undefined);
}

/**
 * Assert a scalar value is not undefined. Use before an eq() /
 * loadDecryptedKeys() call that would silently trip UNDEFINED_VALUE
 * inside postgres-js if the parameter is undefined.
 *
 * Returns the value narrowed to non-undefined for downstream use.
 */
export function assertScalarDefinedForPostgres<T>(
  value: T,
  fieldName: string,
  context: string,
): Exclude<T, undefined> {
  if (value === undefined) {
    throw new Error(
      `[assertScalarDefinedForPostgres] context=${context} field '${fieldName}' is undefined; ` +
        `postgres-js would throw UNDEFINED_VALUE at the query boundary. Trace upstream.`,
    );
  }
  return value as Exclude<T, undefined>;
}

/**
 * Recognize a caught error as postgres-js's UNDEFINED_VALUE and
 * annotate it with caller context. Re-throws either the annotated
 * error (if it WAS the postgres-js class) or the original error
 * (otherwise) so callers can wrap without changing semantics for
 * unrelated errors.
 *
 * Use at the outer try/catch in a worker function:
 *
 *   try { await step.run(...); }
 *   catch (e) { rethrowWithUndefinedContext(e, 'sync:chunk-42'); }
 */
export function rethrowWithUndefinedContext(err: unknown, context: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  // postgres-js formats as: "UNDEFINED_VALUE: Undefined values are not allowed"
  // OR the code is on err.code. Match on both.
  const looksLikePgUndefined =
    /\bUNDEFINED_VALUE\b/i.test(msg) ||
    (err !== null &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'UNDEFINED_VALUE');
  if (looksLikePgUndefined) {
    const annotated = new Error(
      `[postgres-js UNDEFINED_VALUE at ${context}] ${msg}. ` +
        `An undefined query parameter reached the driver. Check every Drizzle .values/.set/.where ` +
        `in the code path leading to '${context}' — a top-level undefined column value, an eq(col, undefined) ` +
        `WHERE, or an inArray with undefined elements is the usual suspect.`,
    );
    (annotated as Error & { cause?: unknown }).cause = err;
    throw annotated;
  }
  throw err;
}
