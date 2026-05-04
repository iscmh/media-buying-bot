/**
 * Meta error codes that indicate rate limiting. When we hit these we record
 * the event and trigger backoff/cooldown via @mbb/db/safety/rate-limiter.
 *
 * 17     — User request limit reached
 * 80004  — Too many calls to ads API
 * 613    — Calls to this API have exceeded the rate limit
 *
 * Source: Meta Graph API error reference, integration date 2026-05-04.
 */
export const RATE_LIMIT_ERROR_CODES = new Set<number>([17, 80004, 613]);

export function isRateLimitError(code: number | undefined | null): boolean {
  return code != null && RATE_LIMIT_ERROR_CODES.has(code);
}
