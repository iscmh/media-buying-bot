import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: inline status dot.
 *
 * For tight lists (table rows, side-by-side runs) where a full Badge
 * is too much chrome. Renders a 1.5×1.5 colored circle inline with
 * the surrounding text — the operator's eye picks up the dot
 * peripherally without breaking the row's reading rhythm.
 *
 * Pair with a label or value next to it:
 *   <StatusDot tone="positive" /> active
 *   <StatusDot tone="negative" /> failed
 *
 * Use Badge when the status needs its own emphasized chip; use
 * StatusDot inside a row of mostly other data.
 */
export type StatusTone =
  | 'positive' // active, running, profitable, succeeded
  | 'negative' // paused, failed, errored
  | 'warning' // degraded, low balance, attention
  | 'info' // informational / neutral active state
  | 'subtle'; // pending, completed-but-archived, neutral idle

interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Polish-17: optional larger size for header / hero contexts (2px → 3px). */
  size?: 'sm' | 'md';
}

const toneClass: Record<StatusTone, string> = {
  positive: 'bg-[color:var(--accent-positive)]',
  negative: 'bg-[color:var(--accent-negative)]',
  warning: 'bg-[color:var(--accent-warning)]',
  info: 'bg-[color:var(--accent-info)]',
  subtle: 'bg-fg-subtle',
};

export function StatusDot({ tone, size = 'sm', className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block flex-shrink-0 rounded-full',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
