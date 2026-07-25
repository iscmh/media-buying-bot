'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.4 Commit 25: Trader Terminal cell-flash primitive.
 *
 * Wraps a numeric value that changes over time and flashes green
 * (increase) or red (decrease) for ~300ms when the value moves.
 * Bloomberg/ThinkOrSwim pattern — the flash is the strongest
 * visual signal a pro tool uses to draw the eye to a live update
 * without adding page-level motion. Silent on first render (no
 * flash) so page loads don't paint every KPI red/green.
 *
 * Usage:
 *   <CellFlash value={spendUsd}>
 *     <span className="font-mono">${spendUsd.toFixed(2)}</span>
 *   </CellFlash>
 *
 * Compares numerically. String / date / mixed-type values pass
 * through with no flash — the primitive is deliberately scoped
 * to numeric-cell updates.
 */
export interface CellFlashProps {
  /** The current numeric value. Change triggers the flash. */
  value: number | null | undefined;
  /** Content to render inside the flashing wrapper. */
  children: React.ReactNode;
  /** Flash duration in ms. Defaults to Bloomberg's ~300ms decay. */
  durationMs?: number;
  /** Optional wrapper className. Merged with the flash animation classes. */
  className?: string;
}

type FlashDirection = 'up' | 'down' | null;

export function CellFlash({ value, children, durationMs = 300, className }: CellFlashProps) {
  const previousRef = React.useRef<number | null | undefined>(value);
  const [direction, setDirection] = React.useState<FlashDirection>(null);

  React.useEffect(() => {
    const prev = previousRef.current;
    // Skip the first render — a page load should NOT paint every
    // KPI red/green. Only actual value changes flash.
    if (prev === undefined || prev === null || value === undefined || value === null) {
      previousRef.current = value;
      return;
    }
    if (typeof prev !== 'number' || typeof value !== 'number') {
      previousRef.current = value;
      return;
    }
    if (value === prev) return;
    setDirection(value > prev ? 'up' : 'down');
    previousRef.current = value;
    const timer = setTimeout(() => setDirection(null), durationMs);
    return () => clearTimeout(timer);
  }, [value, durationMs]);

  return (
    <span
      className={cn(
        'inline-block transition-colors',
        direction === 'up' && 'text-[color:var(--accent-positive)]',
        direction === 'down' && 'text-[color:var(--accent-negative)]',
        className,
      )}
      style={{
        transitionDuration: `${durationMs}ms`,
      }}
    >
      {children}
    </span>
  );
}
