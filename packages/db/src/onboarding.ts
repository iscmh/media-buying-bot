import { TOS_VERSION, type OnboardingStep } from '@mbb/shared';
import { and, eq } from 'drizzle-orm';
import { getDb } from './client';
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
 * Polish-29.0.8 Commit 117: chain trimmed to tos → risk. The `keys`
 * gate is REMOVED — the default video generation path is now
 * credit-backed Seedance (useapi.net → shared platform Dreamina
 * account, see /generate/seedance). New signups get 100 free trial
 * credits at first login and can generate a video before ever
 * connecting a BYOK key.
 *
 * BYOK remains an opt-in surface at /settings/connections for users
 * who want the premium HeyGen / OpenAI / Claude / ElevenLabs
 * pipelines. Their pages independently check for the specific
 * providers they require; onboarding no longer force-gates it.
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

  const [user, riskAck] = await Promise.all([
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
  ]);

  const tosDone = !!user?.tosAcceptedAt && user.tosVersion === TOS_VERSION;
  const riskDone = !!riskAck;

  const completed: Record<OnboardingStep, boolean> = {
    tos: tosDone,
    risk: riskDone,
  };

  let nextStep: OnboardingStep | null = null;
  if (!tosDone) nextStep = 'tos';
  else if (!riskDone) nextStep = 'risk';

  return { nextStep, completed };
}
