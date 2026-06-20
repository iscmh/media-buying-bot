import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Ads Bot badge — status pills only. No emoji prefixes, no playful
 * variants. Use outline + state color for status pills; solid only for
 * the rare destructive-emphasis case.
 *
 * Polish-17 Phase 2:
 *   - rounded-full → rounded-sm (square corners, "real tool" look).
 *   - font-medium → font-mono (status text reads as a code, not a
 *     label — "ACTIVE" / "PAUSED" / "FAILED" in mono is the
 *     trading-terminal aesthetic).
 *   - Accent color slots remap to the brighter Polish-17 palette
 *     (--accent-positive / --accent-negative / --accent-warning).
 *
 * Variants:
 *   default     — neutral filled (primary bg, dark text). Sparingly.
 *   secondary   — neutral filled grey.
 *   outline     — neutral border-only.
 *   destructive — red tint for negative states (rejected, errored).
 *   success     — green tint for "active" pills.
 *   warning     — amber for "needs review" / "kill recommended".
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
  destructive:
    'bg-[color:var(--accent-negative)]/10 text-[color:var(--accent-negative)] border-[color:var(--accent-negative)]/30',
  success:
    'bg-[color:var(--accent-positive)]/10 text-[color:var(--accent-positive)] border-[color:var(--accent-positive)]/30',
  warning:
    'bg-[color:var(--accent-warning)]/10 text-[color:var(--accent-warning)] border-[color:var(--accent-warning)]/30',
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-xs leading-none',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  );
}
