import 'server-only';
import { redirect } from 'next/navigation';
import { checkActiveSubscription, getOnboardingState } from '@mbb/db';
import { ONBOARDING_STEPS, ONBOARDING_STEP_PATHS, type OnboardingStep } from '@mbb/shared';
import { setSentryUser } from '@/lib/sentry-user';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Page-level onboarding guard. Each /onboarding/<step> page calls this at
 * the top of its server component.
 *
 * Resolves the authed user, fetches onboarding state, then enforces:
 *  - if an EARLIER step is incomplete → redirect there
 *  - if THIS step is already complete and a LATER step is pending →
 *    redirect there (skip back to where they left off)
 *  - if all four steps complete → /dashboard
 *  - otherwise → return { userId, state } to render the page
 *
 * `meta` step has a small exception: it's "complete" once a meta_connection
 * row exists with status='active' (BM picked). The page renders sub-state
 * (c) "you're connected" in that case rather than redirecting away — this
 * lets users revisit /onboarding/meta to review what they connected. The
 * `allowComplete` flag controls that behavior.
 */
export async function requireOnboardingStep(
  step: OnboardingStep,
  options: { allowComplete?: boolean } = {},
): Promise<{ userId: string; state: Awaited<ReturnType<typeof getOnboardingState>> }> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const state = await getOnboardingState(user.id);

  // 1. Earlier-step incomplete → bounce backward.
  const stepIdx = ONBOARDING_STEPS.indexOf(step);
  for (let i = 0; i < stepIdx; i++) {
    const earlier = ONBOARDING_STEPS[i]!;
    if (!state.completed[earlier]) {
      redirect(ONBOARDING_STEP_PATHS[earlier]);
    }
  }

  // 2. Current step complete and a later step is pending → bounce forward.
  if (state.completed[step] && !options.allowComplete) {
    if (state.nextStep) {
      redirect(ONBOARDING_STEP_PATHS[state.nextStep]);
    } else {
      redirect('/dashboard');
    }
  }

  return { userId: user.id, state };
}

/**
 * Dashboard / protected-page guard: ensures every onboarding step is
 * complete. If any step is pending, redirects to that step. Returns the
 * authed user so callers don't need to re-fetch.
 */
export async function requireOnboardingComplete(): Promise<{
  userId: string;
  email: string;
}> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const state = await getOnboardingState(user.id);
  if (state.nextStep) {
    redirect(ONBOARDING_STEP_PATHS[state.nextStep]);
  }

  // Phase 8: subscription paywall. Founding members bypass (they got
  // perpetual access pre-monetization). Everyone else needs an
  // `active` subscription. /billing-required is the soft paywall that
  // explains the state + sends them to /apply or the Whop portal.
  const sub = await checkActiveSubscription(user.id);
  if (!sub.hasAccess) {
    redirect(`/billing-required?reason=${encodeURIComponent(sub.reason)}`);
  }
  // Polish-25.7 Commit 44: tag the current Sentry scope with the
  // authed user so any error captured while rendering downstream is
  // attributable in triage.
  setSentryUser({ userId: user.id, email: user.email ?? '' });
  return { userId: user.id, email: user.email ?? '' };
}
