import type { SpendSafetyResult } from '@mbb/shared';
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { globalEmergencyStop } from '../schema/ops';
import { users } from '../schema/users';

/**
 * Check global + per-user kill switches before any bot action.
 * Returns the same shape as spend safety so callers can compose them.
 *
 * Hot path — runs on every Meta mutation. Keep cheap.
 */
export async function checkKillSwitches(userId: string): Promise<SpendSafetyResult> {
  const db = getDb();

  // Global emergency stop. Single row, id=1.
  const stop = await db.query.globalEmergencyStop.findFirst({
    where: eq(globalEmergencyStop.id, 1),
  });
  if (stop?.isActive) {
    return {
      allow: false,
      reason: `global emergency stop active${stop.reason ? `: ${stop.reason}` : ''}`,
      code: 'global_emergency_stop',
    };
  }

  // Per-user pause.
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    return { allow: false, reason: 'user not found', code: 'token_missing' };
  }
  if (user.isPaused) {
    return { allow: false, reason: 'user is paused', code: 'user_paused' };
  }

  return { allow: true };
}
