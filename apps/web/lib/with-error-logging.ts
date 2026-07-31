import 'server-only';
import { logError } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-25.7 Commit 46: server-action wrapper.
 *
 * Wrap any server action to auto-log unexpected throws to error_log
 * without touching the caller's control flow — the error still
 * propagates to the client for Next.js's own error UI. Only
 * "unexpected" means unexpected: pass `expected: true` on
 * validation / auth errors you deliberately throw so those don't
 * pollute the log.
 *
 * Usage:
 *   export const launchApprovedAction = withErrorLogging(
 *     'launchApprovedAction',
 *     async (input: LaunchInput) => { ... },
 *   );
 *
 * The wrapped function preserves its input + return types exactly.
 * Nothing changes for callers.
 */

/**
 * Marker class for "this throw is a normal user-facing rejection
 * (validation, permissions, quota) — DO NOT log to error_log."
 * The action code throws it instead of a raw Error when the failure
 * is expected + already surfaced to the user via its return type
 * OR a form error.
 */
export class ExpectedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectedActionError';
  }
}

// Loosely typed: server actions take arbitrary shapes, but we need
// to preserve exact input/output types. Using generics keeps callers
// unaffected.
type AnyAsyncFn<A extends unknown[], R> = (...args: A) => Promise<R>;

export function withErrorLogging<A extends unknown[], R>(
  sourceName: string,
  fn: AnyAsyncFn<A, R>,
): AnyAsyncFn<A, R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ExpectedActionError) throw err;
      // Best-effort capture of the calling user. Non-fatal if it
      // fails — logError itself is exception-safe.
      let userId: string | null = null;
      try {
        const supabase = await getSupabaseServerClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        userId = user?.id ?? null;
      } catch {
        // ignore
      }
      // Fire-and-forget log; do NOT await if it could block the
      // rethrow noticeably. We do await here because these paths
      // are already error paths (latency doesn't matter) and the
      // insert is fast + swallows its own failures.
      await logError({
        userId,
        source: 'server_action',
        sourceName,
        error: err,
      });
      throw err;
    }
  };
}
