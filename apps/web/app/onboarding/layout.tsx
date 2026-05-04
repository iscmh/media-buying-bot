import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getOnboardingState } from '@mbb/db';
import type { OnboardingStep } from '@mbb/shared';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { OnboardingProgress } from './_components/progress-bar';

export const dynamic = 'force-dynamic';

const PATH_TO_STEP: Record<string, OnboardingStep> = {
  '/onboarding/tos': 'tos',
  '/onboarding/risk': 'risk',
  '/onboarding/meta': 'meta',
  '/onboarding/telegram': 'telegram',
};

/**
 * Onboarding wizard layout.
 *
 * For the four wizard steps (tos/risk/meta/telegram): renders the progress
 * indicator above {children}. For other /onboarding/* paths (e.g. the
 * Phase 7 agency-bm placeholder), skips the progress bar and just wraps
 * children in a container.
 *
 * Each child page is responsible for its own redirect logic — see
 * `requireOnboardingStep` helper.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? '';
  const currentStep = PATH_TO_STEP[pathname] as OnboardingStep | undefined;

  const state = currentStep ? await getOnboardingState(user.id) : null;

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      {currentStep && state && (
        <div className="mb-10">
          <OnboardingProgress current={currentStep} completed={state.completed} />
        </div>
      )}
      {children}
    </main>
  );
}
