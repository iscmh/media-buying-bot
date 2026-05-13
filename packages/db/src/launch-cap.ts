import { and, eq, gte, sql } from 'drizzle-orm';
import { FIRST_LIVE_LAUNCH_HARD_CAP_USD, PLATFORM_HARD_LAUNCH_CEILING_USD } from '@mbb/shared';
import { getDb } from './client';
import { launchedAds } from './schema/launched-ads';
import { userSettings } from './schema/settings';
import { users } from './schema/users';

/**
 * Phase 4a: server-side guard on the daily Meta launch budget cap.
 *
 * Sums today's launched_ads.daily_budget_usd for this user (TZ-aware
 * via users.timezone) and rejects if `today + planned` exceeds the
 * stricter of (user setting, PLATFORM_HARD_LAUNCH_CEILING_USD).
 *
 * Mirrors assertDailyCostCap from Phase 3a — same TZ logic, same
 * return shape, same stricter-of-(user-cap, platform-hard-ceiling)
 * clamping. The launched budget is a recurring DAILY budget per ad, so
 * "today's spend" here means the total daily budget COMMITTED today,
 * not yet-realized spend. The Phase-5 poller will record realized
 * spend separately in meta_spend_usd.
 */
export type DailyLaunchCapResult =
  | { allowed: true; committedTodayUsd: number; capUsd: number; remainingUsd: number }
  | { allowed: false; reason: string; committedTodayUsd: number; capUsd: number };

export async function assertDailyLaunchBudgetCap(
  userId: string,
  plannedBudgetUsd: number,
): Promise<DailyLaunchCapResult> {
  const db = getDb();

  const [user, settings] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { timezone: true },
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { dailyLaunchBudgetCapUsd: true },
    }),
  ]);

  if (!user || !settings) {
    return {
      allowed: false,
      reason: 'User or user_settings row not found.',
      committedTodayUsd: 0,
      capUsd: 0,
    };
  }

  const userCap = Number(settings.dailyLaunchBudgetCapUsd);
  const capUsd = Math.min(userCap, PLATFORM_HARD_LAUNCH_CEILING_USD);

  const startOfDayUtc = startOfTodayInTimezone(new Date(), user.timezone);

  const todaysAds = await db.query.launchedAds.findMany({
    where: and(eq(launchedAds.userId, userId), gte(launchedAds.launchedAt, startOfDayUtc)),
    columns: { dailyBudgetUsd: true, status: true },
  });

  // launch_failed rows didn't actually commit budget on Meta's side, so
  // they don't count against the cap. Everything else (dry_run, active,
  // paused, killed, rejected_by_meta) committed a daily budget that
  // counts towards today's total.
  const committedTodayUsd = todaysAds
    .filter((a) => a.status !== 'launch_failed')
    .reduce((sum, a) => sum + Number(a.dailyBudgetUsd ?? 0), 0);

  if (committedTodayUsd + plannedBudgetUsd > capUsd) {
    const reasonPrefix =
      userCap > PLATFORM_HARD_LAUNCH_CEILING_USD
        ? 'Platform hard launch ceiling reached'
        : 'Your daily launch budget cap reached';
    return {
      allowed: false,
      reason: `${reasonPrefix}. Committed today: $${committedTodayUsd.toFixed(2)} of $${capUsd.toFixed(
        2,
      )}. This batch would add $${plannedBudgetUsd.toFixed(2)}.`,
      committedTodayUsd,
      capUsd,
    };
  }

  return {
    allowed: true,
    committedTodayUsd,
    capUsd,
    remainingUsd: capUsd - committedTodayUsd,
  };
}

/**
 * Phase 4b: HARDCODED first-live-launch hard cap. The user's first
 * EVER live launch session must commit ≤ FIRST_LIVE_LAUNCH_HARD_CAP_USD
 * total daily budget across all variants. After the counter
 * (live_launch_count) is bumped on success, the regular daily launch
 * cap (assertDailyLaunchBudgetCap) takes over.
 *
 * This is a session-level guard, not a per-day guard — it only fires
 * the very first time a user goes live. Defense against an excited
 * operator typo'ing 100 variants at $50/day on day one and waking up
 * to an empty bank account.
 */
export type FirstLaunchCapResult =
  | { allowed: true; isFirstLaunch: boolean; capUsd: number }
  | { allowed: false; reason: string; capUsd: number; liveLaunchCount: number };

export async function assertFirstLiveLaunchCap(
  userId: string,
  plannedTotalBudgetUsd: number,
): Promise<FirstLaunchCapResult> {
  const db = getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { liveLaunchCount: true },
  });
  const liveLaunchCount = settings?.liveLaunchCount ?? 0;
  if (liveLaunchCount > 0) {
    return { allowed: true, isFirstLaunch: false, capUsd: FIRST_LIVE_LAUNCH_HARD_CAP_USD };
  }

  if (plannedTotalBudgetUsd > FIRST_LIVE_LAUNCH_HARD_CAP_USD) {
    return {
      allowed: false,
      reason: `First live launch is hard-capped at $${FIRST_LIVE_LAUNCH_HARD_CAP_USD.toFixed(
        2,
      )} total daily exposure (across all ads in this batch). This batch would commit $${plannedTotalBudgetUsd.toFixed(
        2,
      )}. Reduce the variant count or per-ad budget. Subsequent launches use your normal daily cap.`,
      capUsd: FIRST_LIVE_LAUNCH_HARD_CAP_USD,
      liveLaunchCount,
    };
  }

  return { allowed: true, isFirstLaunch: true, capUsd: FIRST_LIVE_LAUNCH_HARD_CAP_USD };
}

/**
 * Phase 4b: increment user_settings.live_launch_count by 1 (per session,
 * not per ad). Called by the launch job after at least one live ad
 * lands successfully on Meta.
 */
export async function incrementLiveLaunchCount(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(userSettings)
    .set({ liveLaunchCount: sql`${userSettings.liveLaunchCount} + 1` })
    .where(eq(userSettings.userId, userId));
}

// --- TZ helpers — duplicated from cost-cap.ts so each cap module can
// stand alone. Both call sites need the exact same "midnight in zone"
// semantics; sharing a util later is a small refactor we can do once we
// have a third caller. Until then: copy + paste + comment.

function startOfTodayInTimezone(now: Date, timezone: string): Date {
  const parts = formatToParts(now, timezone);
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const naiveUtcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
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
