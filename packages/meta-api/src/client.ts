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
  /**
   * Phase 4b: multipart/form-data path for /adimages uploads. When set,
   * `body` is ignored and `formData` is sent verbatim. Audit log records
   * the field names + sizes (not the bytes themselves).
   */
  formData?: FormData;
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

  // 4. Actual call — Phase 4b implementation.
  //
  // Auth: Bearer <user access token>. The token never leaves this
  // function as plaintext — caller decrypted it from
  // meta_connections.access_token_encrypted, we forward it to the
  // Graph endpoint, and only the sanitized request body lands in
  // meta_api_call_logs.
  //
  // Per-call 30s timeout (matches spec). On 4xx Meta returns a
  // structured error body; on 5xx it varies. We log everything and
  // surface the parsed body so the caller can decide whether to retry
  // (5xx → yes via Inngest retry) or write a launched_ads
  // rejected_by_meta row (4xx).
  const url = `https://graph.facebook.com/${META_API_VERSION}${input.endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS);

  let status = 0;
  let body: unknown = null;
  // Phase 4b: multipart branch for /adimages uploads. Caller passes
  // pre-built FormData; we let fetch set the boundary header automatically
  // (don't set Content-Type manually with multipart or the boundary is
  // missing and Meta returns 400).
  const isMultipart = !!input.formData;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
  };
  if (!isMultipart) {
    headers['Content-Type'] = 'application/json';
  }
  const requestBody = isMultipart
    ? (input.formData as FormData)
    : input.body == null
      ? undefined
      : JSON.stringify(input.body);
  try {
    const res = await fetch(url, {
      method: input.method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    status = res.status;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { _non_json_body: text.slice(0, 4096) };
      }
    }

    // 5xx returns get a record of the hit but no rate-limit penalty —
    // we let Inngest retry policy handle them. 4xx with rate-limit
    // codes mark the user for cooldown; other 4xx are Meta business
    // errors and surface as-is.
    const metaErrorCode = extractMetaErrorCode(body);
    if (status >= 400 && status < 500 && isRateLimitError(metaErrorCode)) {
      await recordRateLimitHit({ userId: input.userId, errorCode: metaErrorCode! });
    }

    await logMetaApiCall({
      userId: input.userId,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: isMultipart
        ? sanitizeFormData(input.formData!)
        : sanitizeRequestBody(input.body),
      responseStatus: status,
      responseBody: body,
      latencyMs: Date.now() - t0,
      dryRun: false,
    });

    return { status, body, dryRun: false, latencyMs: Date.now() - t0 };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const errorMessage = isAbort
      ? `Meta call timed out after ${META_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    await logMetaApiCall({
      userId: input.userId,
      endpoint: input.endpoint,
      method: input.method,
      requestBody: isMultipart
        ? sanitizeFormData(input.formData!)
        : sanitizeRequestBody(input.body),
      responseStatus: 0,
      responseBody: { _network_error: errorMessage, _timeout: isAbort },
      latencyMs: Date.now() - t0,
      dryRun: false,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const META_API_VERSION = 'v21.0';
const META_TIMEOUT_MS = 30_000;

function extractMetaErrorCode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: { code?: number } }).error;
  return typeof error?.code === 'number' ? error.code : undefined;
}

/**
 * Phase 4b: audit-friendly summary of a multipart upload. We don't log
 * file bytes — just the field names + sizes so an audit trail shows
 * what was attempted.
 */
function sanitizeFormData(form: FormData): Record<string, unknown> {
  const fields: Array<{ name: string; size?: number; type?: string }> = [];
  // `FormData.entries()` exists at runtime under Node 20 + the DOM lib,
  // but @types/node's FormData definition lacks the method. Cast through
  // the minimal iterator shape we actually use.
  const iter = (form as unknown as { entries(): Iterable<[string, string | Blob]> }).entries();
  for (const [name, value] of iter) {
    if (typeof value === 'string') {
      fields.push({ name, size: value.length });
    } else {
      // Blob / File — log size + mime, not bytes.
      fields.push({ name, size: value.size, type: value.type || undefined });
    }
  }
  return { _multipart: true, fields };
}

/**
 * Audit-log payload sanitizer. The request body itself never contains
 * the access token (that's a header), but we drop anything that looks
 * like a token/key as a belt-and-suspenders measure.
 */
function sanitizeRequestBody(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!body) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (/token|secret|password|api_key|access_token/i.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
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
