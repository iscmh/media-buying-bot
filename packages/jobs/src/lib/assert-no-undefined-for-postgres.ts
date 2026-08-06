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
/**
 * Polish-26.0.14 Commit 62.4: widened matcher. Handles:
 *   - Error whose message contains "UNDEFINED_VALUE" (postgres-js
 *     shape, Inngest v3 shape).
 *   - Error/object with `code === 'UNDEFINED_VALUE'`.
 *   - Error whose CAUSE chain (via `.cause`) contains a matching
 *     error — Inngest v3 wraps step errors in SerializationError /
 *     StepError, hiding postgres-js's original message on `.cause`.
 *   - Plain object thrown value with the code field.
 *   - Class name heuristics: SerializationError, StepError.
 *
 * Also handles the edge case where the thrown value itself is
 * `undefined` (rare but possible if a callback does `throw
 * undefined`) — this used to fall through unlogged; now it's
 * annotated as a distinct sub-case for the operator.
 */
function looksLikeUndefinedValueError(err: unknown, depth = 0): boolean {
  if (depth > 5) return false; // cycle / deep chain guard
  if (err === undefined) return true; // bare undefined throw
  if (err === null) return false;
  const asRecord = err as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  if (asRecord.code === 'UNDEFINED_VALUE') return true;
  const message = typeof asRecord.message === 'string' ? asRecord.message : String(err);
  if (/\bUNDEFINED_VALUE\b/i.test(message)) return true;
  const name = typeof asRecord.name === 'string' ? asRecord.name : '';
  // Inngest v3 SerializationError signals undefined-in-step-result.
  if (/SerializationError/i.test(name) && /undefined/i.test(message)) return true;
  if ('cause' in asRecord && asRecord.cause !== undefined) {
    return looksLikeUndefinedValueError(asRecord.cause, depth + 1);
  }
  return false;
}

export function rethrowWithUndefinedContext(err: unknown, context: string): never {
  // Polish-26.0.14 Commit 62.4: log the raw shape ALWAYS, even
  // when we decide not to annotate. The operator's diagnostic
  // said prior fixes silently missed the error shape — the raw
  // dump proves whether this catch fired and what err looked like.
  const rawShape = safeErrorShape(err);
  console.error(
    `[rethrowWithUndefinedContext] context=${context} caught raw error: ${JSON.stringify(rawShape).slice(0, 2000)}`,
  );
  if (looksLikeUndefinedValueError(err)) {
    const originalMessage = err instanceof Error ? err.message : String(err);
    const annotated = new Error(
      `[UNDEFINED_VALUE at ${context}] ${originalMessage}. ` +
        `Source is either postgres-js (undefined query parameter) or Inngest v3 (undefined ` +
        `step-return / event value). Check every Drizzle .values/.set/.where AND every step.run ` +
        `return in the code path leading to '${context}'.`,
    );
    (annotated as Error & { cause?: unknown }).cause = err;
    throw annotated;
  }
  throw err;
}

/**
 * Compact, JSON-safe snapshot of an error for logging. Extracts
 * name/message/code/cause/stack (truncated) without triggering the
 * Error's default toString hiding.
 */
export function safeErrorShape(err: unknown): Record<string, unknown> {
  if (err === undefined) return { __thrownValue: 'undefined' };
  if (err === null) return { __thrownValue: 'null' };
  if (typeof err !== 'object') return { __thrownValue: String(err), type: typeof err };
  const asRecord = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  const shape: Record<string, unknown> = {};
  if (asRecord.name !== undefined) shape.name = asRecord.name;
  if (asRecord.message !== undefined) shape.message = asRecord.message;
  if (asRecord.code !== undefined) shape.code = asRecord.code;
  if (typeof asRecord.stack === 'string') {
    shape.stack = asRecord.stack.slice(0, 800);
  }
  if (asRecord.cause !== undefined) {
    shape.cause = safeErrorShape(asRecord.cause);
  }
  return shape;
}

/**
 * Polish-26.0.14 Commit 62.4: guarded step.run wrapper.
 *
 * Wraps a step.run callback with:
 *   1. A pre-run log line (unique marker per step) — proves the
 *      step was invoked and helps trace execution order in Vercel
 *      logs.
 *   2. Try/catch INSIDE the callback that logs the raw error
 *      shape and re-throws with `rethrowWithUndefinedContext` +
 *      step-scoped context. Even if the outer function's catch is
 *      bypassed by Inngest's SDK internals, the per-step catch
 *      fires here.
 *
 * Type-parameterized: the caller-provided callback signature is
 * preserved so we don't lose Drizzle type inference at call sites.
 *
 * Usage:
 *   const chunkResult = await guardedStepRun(
 *     step, `analyze-persist-chunk-${chunkIdx}`, async () => { ... }
 *   );
 */
export async function guardedStepRun<T>(
  // Loosely typed step to accept Inngest v3's actual step-tools
  // shape (which uses overloads and generics we can't cleanly
  // subtype). At runtime it must have a .run(id, fn) method.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: { run: (...args: any[]) => Promise<any> },
  stepId: string,
  fn: () => Promise<T>,
): Promise<T> {
  console.log(`[guardedStepRun] BEFORE step=${stepId}`);
  try {
    return await step.run(stepId, async () => {
      try {
        return await fn();
      } catch (err) {
        console.error(
          `[guardedStepRun] step=${stepId} inner-catch raw error: ${JSON.stringify(safeErrorShape(err)).slice(0, 2000)}`,
        );
        rethrowWithUndefinedContext(err, `step:${stepId}`);
      }
    });
  } catch (err) {
    // Belt-and-suspenders: annotate again at the outer boundary
    // in case Inngest's SDK repackaged the inner throw.
    console.error(
      `[guardedStepRun] step=${stepId} OUTER-catch raw error: ${JSON.stringify(safeErrorShape(err)).slice(0, 2000)}`,
    );
    rethrowWithUndefinedContext(err, `step:${stepId}:outer`);
  }
}
