'use client';

import * as React from 'react';
import { type LucideIcon } from 'lucide-react';
import { CellFlash } from '@/components/ui/cell-flash';
import { Sparkline, type SparklinePoint } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: KPI tile with inline sparkline.
 *
 * Bloomberg pattern — big tabular-num value + tiny trend line in the
 * same cell + label above + delta chip if a comparison is available.
 * Absorbs the old dashboard/_components/metric-card.tsx role and
 * extends it with the sparkline visualization and delta chip.
 *
 * Design rules:
 *   - Value uses font-mono tabular-nums, ~24px, semibold.
 *   - Label sits above at 10px uppercase tracked-wide — same eyebrow
 *     as the Trader Terminal section-header treatment.
 *   - Sparkline is 28px tall, monochrome by default, colored to
 *     accent-positive / accent-negative when tone hints direction.
 *   - Delta chip sits inline to the right of the value; +/- prefix,
 *     tinted by direction.
 *   - CellFlash still wraps the numeric value — on re-render if
 *     numericValue moves, the tile flashes green/red for 300ms.
 *
 * All parts are optional except label + value. A minimal KPI is
 * just label + value; a full one is label + value + delta + sparkline.
 */
export type KpiTone = 'neutral' | 'positive' | 'negative';

interface Props {
  label: string;
  value: string;
  numericValue?: number | null;
  /** Optional icon shown top-right in muted color. */
  icon?: LucideIcon;
  /** Manual tone override for the value color. */
  tone?: KpiTone;
  /**
   * Delta from a comparison period. Number is displayed with sign;
   * the tone is inferred from sign unless explicitly overridden.
   * Pass null / undefined to hide the delta chip.
   */
  delta?: {
    /** Formatted delta string (e.g. "+12.4%", "-$120"). Sign included. */
    label: string;
    direction: 'up' | 'down' | 'flat';
    /**
     * Force the color mapping. Sometimes "down" is good (kills, cost).
     * Defaults to up=positive, down=negative, flat=neutral.
     */
    tone?: KpiTone;
  };
  /** Optional trend series for the sparkline. < 2 points = hidden. */
  spark?: SparklinePoint[];
  /** Hint text under the value + sparkline row. */
  hint?: string;
}

export function KpiTile({
  label,
  value,
  numericValue,
  icon: Icon,
  tone = 'neutral',
  delta,
  spark,
  hint,
}: Props) {
  const valueColor =
    tone === 'positive'
      ? 'text-[color:var(--accent-positive)]'
      : tone === 'negative'
        ? 'text-[color:var(--accent-negative)]'
        : 'text-fg';

  const deltaTone =
    delta?.tone ??
    (delta?.direction === 'up' ? 'positive' : delta?.direction === 'down' ? 'negative' : 'neutral');
  const deltaColor =
    deltaTone === 'positive'
      ? 'text-[color:var(--accent-positive)]'
      : deltaTone === 'negative'
        ? 'text-[color:var(--accent-negative)]'
        : 'text-fg-muted';

  const sparkColor =
    tone === 'positive'
      ? 'var(--accent-positive)'
      : tone === 'negative'
        ? 'var(--accent-negative)'
        : 'var(--fg)';

  return (
    <div className="bg-bg-surface flex flex-col gap-2 rounded-sm border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-fg-subtle text-[10px] font-semibold uppercase tracking-[0.12em]">
          {label}
        </p>
        {Icon && <Icon className="text-fg-subtle h-3.5 w-3.5" aria-hidden />}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <p className={cn('font-mono text-2xl font-semibold tracking-tight', valueColor)}>
          <CellFlash value={numericValue}>{value}</CellFlash>
        </p>
        {delta && (
          <span className={cn('font-mono text-xs', deltaColor)} title="vs previous period">
            {delta.label}
          </span>
        )}
      </div>
      {spark && spark.length >= 2 && <Sparkline data={spark} color={sparkColor} height={28} />}
      {hint && <p className="text-fg-muted mt-0.5 text-xs">{hint}</p>}
    </div>
  );
}
