import { ONBOARDING_STEPS, ONBOARDING_STEP_LABELS, type OnboardingStep } from '@mbb/shared';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProgressBarProps {
  current: OnboardingStep;
  completed: Record<OnboardingStep, boolean>;
}

/**
 * Horizontal four-step progress: connecting line + numbered/checked nodes.
 * Server component — pure render, no client state.
 */
export function OnboardingProgress({ current, completed }: ProgressBarProps) {
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
                    ? 'border-primary bg-primary text-primary-foreground'
                    : isCurrent
                      ? 'border-primary bg-background text-primary'
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
                  isComplete ? 'bg-primary' : 'bg-muted',
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
