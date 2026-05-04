import type { SpendSafetyResult } from '@mbb/shared';
import { and, eq, gte, sum } from 'drizzle-orm';
import { getDb } from '../client.js';
import { dailySummaries } from '../schema/performance.js';
import { userSettings } from '../schema/settings.js';
import { users } from '../schema/users.js';
import { checkKillSwitches } from './kill-switches.js';

/**
 * The mandatory gate before EVERY Meta mutation that would spend money.
 *
 * Order of checks (cheapest first):
 *   1. Kill switches (global emergency stop, user pause, suspicious activity).
 *   2. Token presence + non-expiry. (Token decrypt happens in @mbb/meta-api;
 *      this layer just checks token_expires_at.)
 *   3. Per-user daily spend ceiling: stricter of (env, user_settings).
 *
 * Returns `{ allow: true }` to proceed, or `{ allow: false, reason, code }`
 * with a human-readable explanation. Callers MUST audit-log denies.
 */
export async function checkSpendSafety(input: {
  userId: string;
  plannedSpend: number; // USD
}): Promise<SpendSafetyResult> {
  const { userId, plannedSpend } = input;

  // 1. Kill switches.
  const ks = await checkKillSwitches(userId);
  if (!ks.allow) return ks;

  // 2. Spend ceiling.
  const db = getDb();
  const settingsRow = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!settingsRow) {
    return {
      allow: false,
      reason: 'user_settings missing — onboarding incomplete',
      code: 'user_ceiling_exceeded',
    };
  }
  const userRow = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!userRow) {
    return { allow: false, reason: 'user not found', code: 'token_missing' };
  }

  const envCeiling = Number(process.env.PLATFORM_DAILY_SPEND_CEILING_USD ?? '500');
  const userCeiling = Number(settingsRow.platformDailySpendCeiling);
  const effectiveCeiling = Math.min(envCeiling, userCeiling);

  // Sum today's spend in the user's local timezone. For MVP we use UTC date;
  // user-timezone math is added when the daily-summary job lands (Phase 6).
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const spentRows = await db
    .select({ total: sum(dailySummaries.spend) })
    .from(dailySummaries)
    .where(and(eq(dailySummaries.userId, userId), gte(dailySummaries.date, isoDate(today))));

  const spentToday = Number(spentRows[0]?.total ?? 0);

  if (spentToday + plannedSpend > effectiveCeiling) {
    return {
      allow: false,
      reason: `would exceed daily ceiling: spent=${spentToday}, planned=${plannedSpend}, ceiling=${effectiveCeiling}`,
      code:
        envCeiling < userCeiling ? 'platform_ceiling_exceeded' : 'user_ceiling_exceeded',
    };
  }

  return { allow: true };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
