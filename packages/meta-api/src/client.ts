import {
  checkSpendSafety,
  logMetaApiCall,
  recordRateLimitHit,
  reserveRateLimitSlot,
} from '@mbb/db';
import { isRateLimitError } from './errors';

/**
 * The single chokepoint for ALL Meta Graph API calls. EVERY call must go
 * through here. Direct fetch() to graph.facebook.com is a code review block.
 *
 * Responsibilities (in order):
 *   1. Spend safety check — denies if user is paused, over ceiling, etc.
 *   2. Rate limit reservation — blocks if cooldown active.
 *   3. Dry-run short-circuit — when BOT_DRY_RUN=true, returns
 *      { dryRun: true, status: 0, body: null } and audit-logs the *intent*.
 *   4. Actual fetch (Phase 4 wires this up; Phase 1 throws).
 *   5. Always audit-log via @mbb/db/meta-api-log.
 *   6. On rate limit error: record hit, throw a typed error, do NOT retry
 *      here (callers + scheduler handle retry/backoff).
 */

export interface MetaCallInput {
  userId: string;
  endpoint: string; // e.g. "/act_123456789/campaigns"
  method: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
  /** USD this call is expected to spend (0 for reads). */
  plannedSpend?: number;
  /** User's decrypted access token. Caller decrypts; we never see ciphertext here. */
  accessToken: string;
}

export interface MetaCallResult {
  status: number;
  body: unknown;
  dryRun: boolean;
  latencyMs: number;
}

export async function callMeta(input: MetaCallInput): Promise<MetaCallResult> {
  const dryRun = (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';
  const t0 = Date.now();

  // 1. Spend safety.
  const safety = await checkSpendSafety({
    userId: input.userId,
    plannedSpend: input.plannedSpend ?? 0,
  });
  if (!safety.allow) {
    await logMetaApiCall({
      userId: input.userId,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: input.body ?? {},
      responseStatus: 0,
      responseBody: { _denied_by_safety: true, code: safety.code, reason: safety.reason },
      latencyMs: Date.now() - t0,
      dryRun,
    });
    throw new MetaSafetyDeniedError(safety.code, safety.reason);
  }

  // 2. Rate limit reservation.
  const cooldown = await reserveRateLimitSlot(input.userId);
  if (cooldown) {
    await logMetaApiCall({
      userId: input.userId,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: input.body ?? {},
      responseStatus: 0,
      responseBody: { _rate_limited_pre_call: true, retryAfter: cooldown.retryAfter.toISOString() },
      latencyMs: Date.now() - t0,
      dryRun,
    });
    throw new MetaRateLimitedError(cooldown.retryAfter);
  }

  // 3. Dry-run short-circuit.
  if (dryRun) {
    await logMetaApiCall({
      userId: input.userId,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: input.body ?? {},
      responseStatus: 0,
      responseBody: { _dry_run: true },
      latencyMs: Date.now() - t0,
      dryRun: true,
    });
    return { status: 0, body: null, dryRun: true, latencyMs: Date.now() - t0 };
  }

  // 4. Actual call.
  // Phase 4 will implement: build URL with META_API_VERSION, fetch with
  // Authorization: Bearer <accessToken>, parse JSON, handle errors.
  // For Phase 1 we throw to make accidental live calls obvious.
  void input.accessToken;
  await logMetaApiCall({
    userId: input.userId,
    endpoint: input.endpoint,
    method: input.method,
    requestBody: input.body ?? {},
    responseStatus: 0,
    responseBody: { _phase_1_stub: true },
    latencyMs: Date.now() - t0,
    dryRun: false,
  });
  throw new Error(
    'callMeta: live Meta API calls not implemented in Phase 1. Set BOT_DRY_RUN=true.',
  );
}

export class MetaSafetyDeniedError extends Error {
  constructor(
    public readonly code: string,
    reason: string,
  ) {
    super(`Meta call denied by safety layer (${code}): ${reason}`);
    this.name = 'MetaSafetyDeniedError';
  }
}

export class MetaRateLimitedError extends Error {
  constructor(public readonly retryAfter: Date) {
    super(`Meta call denied by rate limiter; retry after ${retryAfter.toISOString()}`);
    this.name = 'MetaRateLimitedError';
  }
}

/** Helper for Phase 4 use: convert a Meta error response to a recordable hit. */
export async function handleMetaErrorResponse(
  userId: string,
  metaErrorCode: number | undefined,
): Promise<void> {
  if (isRateLimitError(metaErrorCode)) {
    await recordRateLimitHit({ userId, errorCode: metaErrorCode! });
  }
}
