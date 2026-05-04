import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../client.js';
import { rateLimitEvents } from '../schema/ops.js';

/**
 * Rate limit scheduler infrastructure (anti-ban guardrail #1).
 *
 * Meta gives each Standard Access app 200 calls/hr. We cap ourselves at
 * META_RATE_LIMIT_INTERNAL_CAP_PCT (default 60%) = 120 calls/hr per user.
 *
 * Phase 1 ships the bookkeeping API. Actual scheduling/enforcement (sequential
 * per user, exponential backoff on 17/80004/613, 30-min cooldown after
 * second hit in an hour) is wired up in @mbb/meta-api in Phase 4.
 */

const COOLDOWN_AFTER_REPEAT_MIN = 30;

/**
 * Reserve a slot. Returns null if a slot is available, or a Date indicating
 * when the user can try again (cooldown end). Phase 1 stub.
 */
export async function reserveRateLimitSlot(_userId: string): Promise<{ retryAfter: Date } | null> {
  // Phase 1: not implemented. In Phase 4 this will:
  //   1. Read in-memory token bucket for this user.
  //   2. If empty, check `rate_limit_events` for active cooldown.
  //   3. Return retryAfter or null.
  return null;
}

/**
 * Record a rate limit hit (Meta error 17/80004/613). If this is the second
 * hit within an hour, set a 30-minute cooldown.
 */
export async function recordRateLimitHit(input: {
  userId: string;
  errorCode: number;
}): Promise<{ cooldownUntil: Date | null }> {
  const db = getDb();

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db.query.rateLimitEvents.findMany({
    where: and(
      eq(rateLimitEvents.userId, input.userId),
      gte(rateLimitEvents.hitAt, oneHourAgo),
    ),
    orderBy: desc(rateLimitEvents.hitAt),
  });

  let cooldownUntil: Date | null = null;
  if (recent.length >= 1) {
    cooldownUntil = new Date(Date.now() + COOLDOWN_AFTER_REPEAT_MIN * 60 * 1000);
  }

  await db.insert(rateLimitEvents).values({
    userId: input.userId,
    errorCode: input.errorCode,
    cooldownUntil,
  });

  return { cooldownUntil };
}
