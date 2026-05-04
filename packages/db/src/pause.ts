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
 * if any. "Active" = the most recent pause log row whose unpaused_at is
 * NULL. Returns null if the user is not paused or has no pause history.
 */
export async function getLatestPauseReason(userId: string): Promise<{
  reason: string;
  pausedAt: Date;
  pausedBy: 'user' | 'admin' | 'auto';
} | null> {
  const db = getDb();
  const row = await db.query.userPauseLog.findFirst({
    where: and(eq(userPauseLog.userId, userId), isNull(userPauseLog.unpausedAt)),
    orderBy: desc(userPauseLog.pausedAt),
    columns: { reason: true, pausedAt: true, pausedBy: true },
  });
  return row ?? null;
}
