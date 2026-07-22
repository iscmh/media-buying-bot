import { TOS_VERSION, type OnboardingStep } from '@mbb/shared';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import { getDb } from './client';
import { toolConnections } from './schema/connections';
import { auditLogs } from './schema/logs';
import { users } from './schema/users';

export interface OnboardingState {
  /** First incomplete step, or null if all steps complete. */
  nextStep: OnboardingStep | null;
  completed: Record<OnboardingStep, boolean>;
}

/**
 * Resolve a user's onboarding progress in one trip.
 *
 * Polish-25.1 Commit 10a: chain trimmed to tos → risk → keys. Meta +
 * Telegram no longer gate signup; they're prompted at point-of-use
 * from /settings/connections and the launch flow.
 *
 * Polish-25.2 Commit 11: MakeUGC (rebranded "Instant UGC" in the UI)
 * is platform-managed. `keys` is complete when the user has the TWO
 * remaining BYOK keys active + verified: Claude (tool_connections)
 * + Gemini (tool_connections). The MakeUGC key comes from the
 * MAKEUGC_MANAGED_KEY env var at worker submit time (see
 * packages/jobs/src/lib/resolve-makeugc-key.ts).
 *
 * Read-only. Safe to call from any server component / server action.
 * Bypasses RLS (uses service-role connection) — caller must already
 * have verified the user is authenticated and authorized to read
 * this user_id.
 *
 * Bumping TOS_VERSION (in @mbb/shared) automatically demotes "tos"
 * to incomplete for users on a stale version, forcing re-acceptance.
 */
export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  const db = getDb();

  const [user, riskAck, toolRows] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { tosAcceptedAt: true, tosVersion: true },
    }),
    db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.eventType, 'risk_education_acknowledged'),
      ),
      columns: { id: true },
    }),
    db.query.toolConnections.findMany({
      where: and(
        eq(toolConnections.userId, userId),
        eq(toolConnections.status, 'active'),
        isNull(toolConnections.deletedAt),
        inArray(toolConnections.provider, ['claude', 'gemini']),
      ),
      columns: { provider: true },
    }),
  ]);

  const tosDone = !!user?.tosAcceptedAt && user.tosVersion === TOS_VERSION;
  const riskDone = !!riskAck;
  const toolProviders = new Set(toolRows.map((r) => r.provider));
  const keysDone = toolProviders.has('claude') && toolProviders.has('gemini');

  const completed: Record<OnboardingStep, boolean> = {
    tos: tosDone,
    risk: riskDone,
    keys: keysDone,
  };

  let nextStep: OnboardingStep | null = null;
  if (!tosDone) nextStep = 'tos';
  else if (!riskDone) nextStep = 'risk';
  else if (!keysDone) nextStep = 'keys';

  return { nextStep, completed };
}
