import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../client.js';
import { featureFlags } from '../schema/ops.js';

/**
 * Resolve a feature flag for a (flag, user) pair.
 *
 * Resolution order:
 *   1. user-scoped row for this user → its `enabled` value.
 *   2. global-scoped row → its `enabled` value.
 *   3. Neither exists → `false` (default off).
 *
 * Cheap enough to call on every action for now; if it becomes hot, add an
 * in-memory TTL cache keyed by flag name with a 30s TTL.
 */
export async function isFeatureEnabled(flagName: string, userId?: string): Promise<boolean> {
  const db = getDb();

  if (userId) {
    const userFlag = await db.query.featureFlags.findFirst({
      where: and(
        eq(featureFlags.flagName, flagName),
        eq(featureFlags.scope, 'user'),
        eq(featureFlags.userId, userId),
      ),
    });
    if (userFlag) return userFlag.enabled;
  }

  const globalFlag = await db.query.featureFlags.findFirst({
    where: and(
      eq(featureFlags.flagName, flagName),
      eq(featureFlags.scope, 'global'),
      // Defensive: a legitimate global row has userId NULL.
      or(isNull(featureFlags.userId), eq(featureFlags.userId, '00000000-0000-0000-0000-000000000000')),
    ),
  });
  return globalFlag?.enabled ?? false;
}
