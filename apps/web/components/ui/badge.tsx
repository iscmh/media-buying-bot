import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ads Bot badge — status pills only. No emoji prefixes, no playful
 * variants. Use outline + state color for status pills; solid only for
 * the rare destructive-emphasis case.
 *
 * Variants:
 *   default     — neutral filled (primary bg, dark text). Sparingly.
 *   secondary   — neutral filled grey.
 *   outline     — neutral border-only.
 *   destructive — red border + text for negative states (rejected, errored).
 *   success     — desaturated green border + text for "active" pills.
 *   warning     — desaturated amber for "needs review" / "kill recommended".
 */
export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive'
  | 'success'
  | 'warning';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClass: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground border-transparent',
  secondary: 'bg-secondary text-secondary-foreground border-transparent',
  outline: 'text-fg border-border',
  destructive: 'text-[color:var(--destructive-color)] border-[color:var(--destructive-color)]/40',
  success: 'text-[color:var(--success)] border-[color:var(--success)]/40',
  warning: 'text-[color:var(--warning)] border-[color:var(--warning)]/40',
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  );
}
