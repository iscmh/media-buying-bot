import { and, eq, isNull, lt } from 'drizzle-orm';
import { getDb } from './client';
import {
  DEFAULT_TELEGRAM_PREFS,
  telegramConnections,
  telegramConversationState,
  type TelegramNotificationPreferences,
} from './schema/connections';
import { users } from './schema/users';

/**
 * Polish-25.8 Commit 48: preference + conversation-state helpers.
 * All Telegram surfaces (bot commands, notification helpers, cron
 * summaries, web settings UI) go through these so there's one source
 * of truth for defaults + merging.
 */

const CONVERSATION_TTL_MS = 15 * 60 * 1000;

export interface TelegramUser {
  userId: string;
  tgChatId: string;
  timezone: string;
  isPaused: boolean;
  preferences: TelegramNotificationPreferences;
}

/**
 * Returns null if not linked. Merges stored prefs with defaults so a
 * partially-populated row (from a pre-Commit-48 install) reads clean.
 */
export async function getTelegramUserByChatId(tgChatId: string): Promise<TelegramUser | null> {
  const db = getDb();
  const row = await db
    .select({
      userId: telegramConnections.userId,
      tgChatId: telegramConnections.tgChatId,
      preferences: telegramConnections.notificationPreferences,
      timezone: users.timezone,
      isPaused: users.isPaused,
    })
    .from(telegramConnections)
    .innerJoin(users, eq(users.id, telegramConnections.userId))
    .where(
      and(eq(telegramConnections.tgChatId, tgChatId), eq(telegramConnections.status, 'active')),
    )
    .limit(1);
  const r = row[0];
  if (!r || !r.tgChatId) return null;
  return {
    userId: r.userId,
    tgChatId: r.tgChatId,
    timezone: r.timezone,
    isPaused: r.isPaused,
    preferences: { ...DEFAULT_TELEGRAM_PREFS, ...(r.preferences ?? {}) },
  };
}

/**
 * All actively-linked Telegram users. Used by daily/weekly cron
 * dispatchers. Filters on status=active and non-null tg_chat_id.
 */
export async function listTelegramUsers(): Promise<TelegramUser[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: telegramConnections.userId,
      tgChatId: telegramConnections.tgChatId,
      preferences: telegramConnections.notificationPreferences,
      timezone: users.timezone,
      isPaused: users.isPaused,
    })
    .from(telegramConnections)
    .innerJoin(users, eq(users.id, telegramConnections.userId))
    .where(and(eq(telegramConnections.status, 'active'), isNull(users.deletedAt)));
  return rows
    .filter((r) => r.tgChatId != null)
    .map((r) => ({
      userId: r.userId,
      tgChatId: r.tgChatId as string,
      timezone: r.timezone,
      isPaused: r.isPaused,
      preferences: { ...DEFAULT_TELEGRAM_PREFS, ...(r.preferences ?? {}) },
    }));
}

/**
 * Get preferences by userId (for web settings UI). Returns defaults
 * if the user has no telegram_connections row yet.
 */
export async function getTelegramPreferences(
  userId: string,
): Promise<TelegramNotificationPreferences> {
  const db = getDb();
  const row = await db.query.telegramConnections.findFirst({
    where: eq(telegramConnections.userId, userId),
    columns: { notificationPreferences: true },
  });
  return { ...DEFAULT_TELEGRAM_PREFS, ...(row?.notificationPreferences ?? {}) };
}

/**
 * Patch preferences by userId. Only supplied keys are updated;
 * missing keys keep their current values. Upserts a placeholder row
 * if none exists (user setting prefs before linking is a valid
 * onboarding flow).
 */
export async function updateTelegramPreferences(
  userId: string,
  patch: Partial<TelegramNotificationPreferences>,
): Promise<TelegramNotificationPreferences> {
  const db = getDb();
  const current = await getTelegramPreferences(userId);
  const next = { ...current, ...patch };
  const existing = await db.query.telegramConnections.findFirst({
    where: eq(telegramConnections.userId, userId),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(telegramConnections)
      .set({ notificationPreferences: next, updatedAt: new Date() })
      .where(eq(telegramConnections.id, existing.id));
  } else {
    await db.insert(telegramConnections).values({
      userId,
      status: 'pending',
      notificationPreferences: next,
    });
  }
  return next;
}

/**
 * True if `now` (a Date in UTC) falls within the user's configured
 * quiet-hours window in their local timezone. Wraps midnight: e.g.
 * start=22 end=8 → true from 22:00 through 07:59 local.
 */
export function isInQuietHours(
  prefs: TelegramNotificationPreferences,
  timezone: string,
  now: Date = new Date(),
): boolean {
  if (!prefs.quiet_hours_enabled) return false;
  const localHour = localHourInZone(now, timezone);
  const start = prefs.quiet_hours_start_local;
  const end = prefs.quiet_hours_end_local;
  if (start === end) return false;
  if (start < end) return localHour >= start && localHour < end;
  // Wrap-around window.
  return localHour >= start || localHour < end;
}

/**
 * IANA-timezone-aware local hour (0-23). Uses Intl.DateTimeFormat so
 * DST transitions handle themselves.
 */
export function localHourInZone(now: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  });
  return Number(fmt.format(now));
}

/**
 * True iff the current hour matches the user's daily_summary_hour_local.
 * Used by the hourly dailyTelegramSummary cron to select who to
 * notify this tick.
 */
export function isDailySummaryHour(
  prefs: TelegramNotificationPreferences,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return localHourInZone(now, timezone) === prefs.daily_summary_hour_local;
}

/**
 * Multi-turn conversation state helpers. State lives in
 * telegram_conversation_state (single row per user, 15-min TTL).
 */
export async function getConversationState(
  userId: string,
): Promise<{ state: string; data: Record<string, unknown> } | null> {
  const db = getDb();
  const row = await db.query.telegramConversationState.findFirst({
    where: eq(telegramConversationState.userId, userId),
  });
  if (!row) return null;
  if (Date.now() - row.updatedAt.getTime() > CONVERSATION_TTL_MS) {
    // Expired — clean up + return null.
    await db.delete(telegramConversationState).where(eq(telegramConversationState.userId, userId));
    return null;
  }
  return { state: row.state, data: row.data };
}

export async function setConversationState(input: {
  userId: string;
  tgChatId: string;
  state: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const existing = await db.query.telegramConversationState.findFirst({
    where: eq(telegramConversationState.userId, input.userId),
    columns: { userId: true },
  });
  if (existing) {
    await db
      .update(telegramConversationState)
      .set({
        tgChatId: input.tgChatId,
        state: input.state,
        data: input.data,
        updatedAt: new Date(),
      })
      .where(eq(telegramConversationState.userId, input.userId));
  } else {
    await db.insert(telegramConversationState).values({
      userId: input.userId,
      tgChatId: input.tgChatId,
      state: input.state,
      data: input.data,
    });
  }
}

export async function clearConversationState(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(telegramConversationState).where(eq(telegramConversationState.userId, userId));
}

/**
 * Sweep expired conversation state — called from a low-priority cron
 * or opportunistically before starting a new command flow.
 */
export async function pruneExpiredConversationState(): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - CONVERSATION_TTL_MS);
  const deleted = await db
    .delete(telegramConversationState)
    .where(lt(telegramConversationState.updatedAt, cutoff))
    .returning({ userId: telegramConversationState.userId });
  return deleted.length;
}
