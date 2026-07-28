import { redirect } from 'next/navigation';
import { getOnboardingState } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { OnboardingProgress } from './_components/progress-bar';

export const dynamic = 'force-dynamic';

/**
 * Onboarding wizard layout.
 *
 * Polish-25.6 Commit 34: rewritten to remove the fragile
 * `x-pathname` middleware header dependency. The progress bar is now
 * a Client Component that derives the current step from
 * `usePathname()`. The layout unconditionally fetches onboarding
 * completion state and renders the progress bar — the client
 * component itself decides whether to render (returns null for non-
 * wizard paths under /onboarding).
 *
 * Each child page is still responsible for its own step-guard
 * redirect via `requireOnboardingStep`.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const state = await getOnboardingState(user.id);

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <div className="mb-10">
        <OnboardingProgress completed={state.completed} />
      </div>
      {children}
    </main>
  );
}
