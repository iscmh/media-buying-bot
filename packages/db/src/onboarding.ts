import { TOS_VERSION, type OnboardingStep } from '@mbb/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './client';
import { auditLogs } from './schema/logs';
import { metaConnections, telegramConnections } from './schema/connections';
import { users } from './schema/users';

export interface OnboardingState {
  /** First incomplete step, or null if all four complete. */
  nextStep: OnboardingStep | null;
  completed: Record<OnboardingStep, boolean>;
}

/**
 * Resolve a user's onboarding progress in one trip.
 *
 * Read-only. Safe to call from any server component / server action.
 * Bypasses RLS (uses service-role connection) — caller must already have
 * verified the user is authenticated and authorized to read this user_id.
 *
 * Bumping TOS_VERSION (in @mbb/shared) automatically demotes "tos" to
 * incomplete for users on a stale version, forcing re-acceptance.
 */
export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const db = getDb();

  const [user, metaRow, tgRow, riskAck] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { tosAcceptedAt: true, tosVersion: true },
    }),
    db.query.metaConnections.findFirst({
      where: and(
        eq(metaConnections.userId, userId),
        eq(metaConnections.status, 'active'),
        isNull(metaConnections.deletedAt),
      ),
      columns: { id: true },
    }),
    db.query.telegramConnections.findFirst({
      where: and(eq(telegramConnections.userId, userId), eq(telegramConnections.status, 'active')),
      columns: { id: true },
    }),
    db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.eventType, 'risk_education_acknowledged'),
      ),
      columns: { id: true },
    }),
  ]);

  const tosDone = !!user?.tosAcceptedAt && user.tosVersion === TOS_VERSION;
  const riskDone = !!riskAck;
  const metaDone = !!metaRow;
  const tgDone = !!tgRow;

  const completed: Record<OnboardingStep, boolean> = {
    tos: tosDone,
    risk: riskDone,
    meta: metaDone,
    telegram: tgDone,
  };

  let nextStep: OnboardingStep | null = null;
  if (!tosDone) nextStep = 'tos';
  else if (!riskDone) nextStep = 'risk';
  else if (!metaDone) nextStep = 'meta';
  else if (!tgDone) nextStep = 'telegram';

  return { nextStep, completed };
}
