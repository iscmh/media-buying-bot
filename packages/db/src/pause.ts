import { and, desc, eq, isNull } from 'drizzle-orm';
import { logAuditEvent } from './audit';
import { getDb } from './client';
import { userPauseLog } from './schema/ops';
import { users } from './schema/users';

/**
 * Cascade-pause a user. Used by every disconnect action (Meta, Telegram, AI
 * provider) and any future "auto-pause" trigger. The pause is intentionally
 * sticky: reconnecting does NOT auto-unpause. The user must hit the dashboard
 * pause banner's Unpause button (Phase 2c) to deliberately resume.
 *
 *   1. users.is_paused = true
 *   2. user_pause_log row inserted (paused_by, reason)
 *   3. audit log entry
 *
 * Idempotent: if the user is already paused, this still inserts a new
 * pause-log row so the reason history is preserved (e.g. "first pause was
 * Meta disconnect; while still paused, AI provider also got disconnected").
 */
export async function cascadePauseUser(input: {
  userId: string;
  reason: string;
  pausedBy: 'user' | 'admin' | 'auto';
}): Promise<void> {
  const db = getDb();
  await db.update(users).set({ isPaused: true }).where(eq(users.id, input.userId));

  await db.insert(userPauseLog).values({
    userId: input.userId,
    reason: input.reason,
    pausedBy: input.pausedBy,
  });

  await logAuditEvent({
    userId: input.userId,
    eventType: 'user_paused',
    eventData: { reason: input.reason, paused_by: input.pausedBy },
  });
}

/**
 * For the dashboard banner: surface the active (unresolved) pause reason
 * + count of open pause-log rows. "Active" = pause log rows whose
 * unpaused_at is NULL. Returns null if the user has no open pauses.
 */
export async function getLatestPauseReason(userId: string): Promise<{
  reason: string;
  pausedAt: Date;
  pausedBy: 'user' | 'admin' | 'auto';
  openPauseCount: number;
} | null> {
  const db = getDb();
  const openRows = await db.query.userPauseLog.findMany({
    where: and(eq(userPauseLog.userId, userId), isNull(userPauseLog.unpausedAt)),
    orderBy: desc(userPauseLog.pausedAt),
    columns: { reason: true, pausedAt: true, pausedBy: true },
  });
  if (openRows.length === 0) return null;
  const latest = openRows[0]!;
  return { ...latest, openPauseCount: openRows.length };
}

/**
 * Inverse of cascadePauseUser. Closes ALL open user_pause_log rows for the
 * user (sets unpaused_at = now()) and flips users.is_paused = false. Audit-
 * logs the unpause with the count and array of reasons that were closed,
 * which is useful debugging signal later (was this user paused for one
 * reason or three?).
 *
 * Returns the closed reasons. If the user is not actually paused (no open
 * log rows), returns null and writes nothing — the banner won't be visible
 * in that case anyway, but a stale POST shouldn't write spurious logs.
 *
 * Reconnecting a previously-disconnected service does NOT call this; the
 * user must explicitly unpause from the dashboard banner.
 */
export async function unpauseUser(
  userId: string,
): Promise<{ previousPauseCount: number; previousReasons: string[] } | null> {
  const db = getDb();

  const openRows = await db.query.userPauseLog.findMany({
    where: and(eq(userPauseLog.userId, userId), isNull(userPauseLog.unpausedAt)),
    columns: { reason: true },
  });
  if (openRows.length === 0) {
    // Defensive: user is already unpaused. Don't write phantom audit rows.
    await db.update(users).set({ isPaused: false }).where(eq(users.id, userId));
    return null;
  }

  const now = new Date();
  await db
    .update(userPauseLog)
    .set({ unpausedAt: now })
    .where(and(eq(userPauseLog.userId, userId), isNull(userPauseLog.unpausedAt)));

  await db.update(users).set({ isPaused: false }).where(eq(users.id, userId));

  const previousReasons = openRows.map((r) => r.reason);
  await logAuditEvent({
    userId,
    eventType: 'user_unpaused',
    eventData: {
      previous_pause_count: openRows.length,
      previous_reasons: previousReasons,
    },
  });

  return { previousPauseCount: openRows.length, previousReasons };
}
