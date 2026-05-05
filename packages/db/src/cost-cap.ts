import { and, eq, gte } from 'drizzle-orm';
import { PLATFORM_HARD_AI_CEILING_USD } from '@mbb/shared';
import { getDb } from './client';
import { generationJobs } from './schema/generation';
import { userSettings } from './schema/settings';
import { users } from './schema/users';

/**
 * Server-side guard that gates a new generation job against the user's
 * AI generation daily cap. Sums today's `estimated_cost_usd` for this
 * user (TZ-aware via users.timezone) and rejects if `today + planned`
 * exceeds the stricter of (user setting, platform hard ceiling).
 *
 * Reasons it might fail:
 *   - User's daily cap reached
 *   - Platform hard ceiling (200 USD) reached
 *   - User row missing (defensive — onboarding gate should prevent this)
 *
 * Why TZ-aware: a user in Asia/Singapore at 02:00 local has been "today"
 * for 2 hours, while UTC midnight was 9 hours ago. Without TZ correction,
 * their cap appears to refresh at the wrong wall-clock moment, which
 * costs them money or blocks them surprisingly.
 */
export type DailyCostCapResult =
  | { allowed: true; spentTodayUsd: number; capUsd: number; remainingUsd: number }
  | { allowed: false; reason: string; spentTodayUsd: number; capUsd: number };

export async function assertDailyCostCap(
  userId: string,
  plannedCostUsd: number,
): Promise<DailyCostCapResult> {
  const db = getDb();

  const [user, settings] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { timezone: true },
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { aiGenerationDailyCapUsd: true },
    }),
  ]);

  if (!user || !settings) {
    return {
      allowed: false,
      reason: 'User or user_settings row not found.',
      spentTodayUsd: 0,
      capUsd: 0,
    };
  }

  const userCap = Number(settings.aiGenerationDailyCapUsd);
  const capUsd = Math.min(userCap, PLATFORM_HARD_AI_CEILING_USD);

  const startOfDayUtc = startOfTodayInTimezone(new Date(), user.timezone);

  const todaysJobs = await db.query.generationJobs.findMany({
    where: and(eq(generationJobs.userId, userId), gte(generationJobs.requestedAt, startOfDayUtc)),
    columns: { estimatedCostUsd: true },
  });

  const spentTodayUsd = todaysJobs.reduce((sum, j) => sum + Number(j.estimatedCostUsd ?? 0), 0);

  if (spentTodayUsd + plannedCostUsd > capUsd) {
    const reasonPrefix =
      userCap > PLATFORM_HARD_AI_CEILING_USD
        ? 'Platform hard AI ceiling reached'
        : 'Your AI generation daily cap reached';
    return {
      allowed: false,
      reason: `${reasonPrefix}. Spent today: $${spentTodayUsd.toFixed(2)} of $${capUsd.toFixed(2)}.`,
      spentTodayUsd,
      capUsd,
    };
  }

  return {
    allowed: true,
    spentTodayUsd,
    capUsd,
    remainingUsd: capUsd - spentTodayUsd,
  };
}

/**
 * Compute "midnight today in the user's timezone" expressed as a UTC Date,
 * usable directly in a Drizzle `gte(requested_at, ...)` predicate.
 *
 * Uses Intl.DateTimeFormat to walk the user's local clock back to 00:00
 * without bringing in date-fns-tz. The trick: format `now` in the target
 * zone, parse the YYYY-MM-DD pieces, then construct a UTC Date with the
 * same Y/M/D + 00:00 — that's the wall-clock midnight for that zone, but
 * it's marked as UTC, which is wrong by exactly the zone's offset. We
 * compute the offset by formatting the same `now` in both UTC and the
 * target zone and subtracting.
 */
function startOfTodayInTimezone(now: Date, timezone: string): Date {
  const parts = formatToParts(now, timezone);
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);

  // Wall-clock midnight in the target zone, expressed as a "naive" UTC moment.
  const naiveUtcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);

  // Same wall-clock moment in the target zone — formatted, then parsed back
  // — gives us the offset we need to subtract.
  const offsetMs = computeZoneOffsetMs(new Date(naiveUtcMidnight), timezone);

  return new Date(naiveUtcMidnight - offsetMs);
}

function formatToParts(d: Date, timezone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const result: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') result[p.type] = p.value;
  }
  return result;
}

function computeZoneOffsetMs(d: Date, timezone: string): number {
  // Format the same instant in UTC and in the target zone, then diff.
  const tzParts = formatToParts(d, timezone);
  const utcParts = formatToParts(d, 'UTC');

  const tzMs = Date.UTC(
    Number(tzParts.year),
    Number(tzParts.month) - 1,
    Number(tzParts.day),
    Number(tzParts.hour),
    Number(tzParts.minute),
    Number(tzParts.second),
  );
  const utcMs = Date.UTC(
    Number(utcParts.year),
    Number(utcParts.month) - 1,
    Number(utcParts.day),
    Number(utcParts.hour),
    Number(utcParts.minute),
    Number(utcParts.second),
  );
  return tzMs - utcMs;
}
