import { and, gt, sql } from 'drizzle-orm';
import { getDb } from './client';
import { apiKeys } from './schema/api-keys';
import { apiRequestLog } from './schema/api-request-log';

/**
 * Polish-25.10 Commit 59: DB-backed sliding-window rate limiter for
 * /api/v1/*. No Redis in the stack, so we count rows in
 * api_request_log over the last 60 seconds via the
 * (api_key_id, created_at desc) index.
 *
 * Cost per check at steady state (60 rows/min per key): a single
 * indexed count. The alternative — an in-memory limiter — dies on
 * Vercel's serverless model since each request may hit a fresh
 * lambda instance.
 */

const WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_WINDOW = 60;

export interface RateLimitCheck {
  allowed: boolean;
  /** Requests already recorded in the current window. */
  used: number;
  /** MAX_REQUESTS_PER_WINDOW; echoed for header consistency. */
  limit: number;
  /** Seconds until the caller should retry (window size, worst case). */
  retryAfterSeconds: number;
}

export async function checkApiRateLimit(apiKeyId: string): Promise<RateLimitCheck> {
  const db = getDb();
  const cutoff = new Date(Date.now() - WINDOW_SECONDS * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiRequestLog)
    .where(and(sql`${apiRequestLog.apiKeyId} = ${apiKeyId}`, gt(apiRequestLog.createdAt, cutoff)));
  const used = rows[0]?.count ?? 0;
  return {
    allowed: used < MAX_REQUESTS_PER_WINDOW,
    used,
    limit: MAX_REQUESTS_PER_WINDOW,
    retryAfterSeconds: WINDOW_SECONDS,
  };
}

/**
 * Log a request after it completes. Called from the api-auth wrapper
 * with the actual status code so the log doubles as an audit trail
 * (2xx vs 4xx vs 5xx over time per key).
 *
 * Never throws — a broken log write must not fail the response.
 */
export async function recordApiRequest(input: {
  apiKeyId: string;
  userId: string;
  method: string;
  path: string;
  statusCode: number;
}): Promise<void> {
  try {
    const db = getDb();
    await db.insert(apiRequestLog).values({
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      method: input.method,
      path: input.path,
      statusCode: input.statusCode,
    });
  } catch {
    // Swallow — logging is not on the response critical path.
  }
}

export const RATE_LIMIT_WINDOW_SECONDS = WINDOW_SECONDS;
export const RATE_LIMIT_MAX_REQUESTS = MAX_REQUESTS_PER_WINDOW;

// Re-export for callers importing rate-limit + key helpers together.
export { apiKeys };
