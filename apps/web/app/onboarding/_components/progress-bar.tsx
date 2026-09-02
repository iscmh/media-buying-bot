'use client';

import { usePathname } from 'next/navigation';
import { ONBOARDING_STEPS, ONBOARDING_STEP_LABELS, type OnboardingStep } from '@mbb/shared';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.1 progress bar rewritten as a Client Component in
 * Polish-25.6 Commit 34.
 *
 * WHY: the Server Component version depended on middleware setting
 * `x-pathname` on the request headers, and reading it via `headers()`
 * in the onboarding layout to derive the current step. That header
 * WAS being set (middleware.ts:32), but the derived `currentStep`
 * still resolved to `undefined` intermittently — audit surfaced the
 * progress bar silently missing. Rather than keep chasing an
 * SSR/edge-runtime race, the client `usePathname()` hook is 100%
 * reliable and removes the middleware coupling. Layout now
 * unconditionally renders this component; if the current pathname
 * isn't in the step map, this returns null (safe no-op for
 * `/onboarding/agency-bm` etc.).
 */

interface Props {
  /** Which steps are already complete for this user. Server-fetched, passed as data (no functions). */
  completed: Record<OnboardingStep, boolean>;
}

const PATH_TO_STEP: Record<string, OnboardingStep> = {
  '/onboarding/tos': 'tos',
  '/onboarding/risk': 'risk',
  // Polish-29.0.8 Commit 117: /onboarding/keys is now a legacy
  // redirect (it redirects to /settings/connections). Intentionally
  // omitted from PATH_TO_STEP — if a user somehow lands there mid-
  // redirect the progress bar just returns null (unknown pathname).
};

export function OnboardingProgress({ completed }: Props) {
  const pathname = usePathname();
  const current = PATH_TO_STEP[pathname] as OnboardingStep | undefined;
  if (!current) return null;

  return (
    <ol className="mx-auto flex w-full max-w-2xl items-center" aria-label="Onboarding progress">
      {ONBOARDING_STEPS.map((step, idx) => {
        const isCurrent = step === current;
        const isComplete = completed[step];
        const isLast = idx === ONBOARDING_STEPS.length - 1;

        return (
          <li key={step} className={cn('flex flex-1 items-center', isLast && 'flex-none')}>
            <div className="flex flex-col items-center gap-2">
              <div
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold',
                  isComplete
                    ? 'bg-[color:var(--accent-positive)]/10 border-[color:var(--accent-positive)] text-[color:var(--accent-positive)]'
                    : isCurrent
                      ? 'bg-bg-surface border-[color:var(--accent-amber)] text-[color:var(--accent-amber)]'
                      : 'border-border bg-bg-inset text-fg-muted',
                )}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {isComplete ? <Check className="h-4 w-4" /> : idx + 1}
              </div>
              <span className={cn('text-xs font-medium', isCurrent ? 'text-fg' : 'text-fg-muted')}>
                {ONBOARDING_STEP_LABELS[step]}
              </span>
            </div>
            {!isLast && (
              <div
                className={cn(
                  'mx-2 h-0.5 flex-1 -translate-y-3',
                  isComplete ? 'bg-[color:var(--accent-positive)]' : 'bg-border',
                )}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
