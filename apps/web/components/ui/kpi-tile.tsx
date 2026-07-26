import * as React from 'react';
import { type LucideIcon } from 'lucide-react';
import { CellFlash } from '@/components/ui/cell-flash';
import { Sparkline, type SparklinePoint } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: KPI tile with inline sparkline.
 * Polish-25.5 Commit 32: DEMOTED to Server Component (removed
 * 'use client'). Root cause of digest 2795558093, take 3.
 *
 * WHY THIS IS A SERVER COMPONENT NOW (Commit 32 post-mortem)
 *
 * Commit 27 originally marked this 'use client'. That was a reflex —
 * KpiTile doesn't use any client-only hooks or event handlers.
 * The reflex introduced a Server → Client boundary between the
 * dashboard page (Server) and this component, and one of its props
 * was an `icon: LucideIcon`. Lucide icons are `React.forwardRef`
 * wrappers with the shape `{ $$typeof, render: function, displayName }`.
 * Next.js 14 App Router's RSC serializer sees the raw
 * `render: function` field and throws:
 *
 *   Error: Functions cannot be passed directly to Client Components
 *   unless you explicitly expose it by marking it with "use server".
 *     {$$typeof: ..., render: function, displayName: ...}
 *                             ^^^^^^^^
 *
 * This blew up ONLY on the dashboard because no other page passes a
 * Lucide icon prop to a client component. The pre-Commit-27
 * `MetricCard` never had `'use client'`, so `icon={Wallet}` there
 * was server → server — no serialization boundary, no crash.
 *
 * FIX: remove 'use client'. KpiTile is now a Server Component. The
 * icon prop is consumed inside the server tree and never serialized.
 * `<CellFlash>` and `<Sparkline>` embedded inside are still client
 * components and cross their own boundaries — but their props are
 * plain data (numbers, arrays, strings) which serialize fine.
 *
 * (This is Commit 32 fixing what Commits 29 / 30 / 31 all
 * misdiagnosed — 29/30 chased recharts SSR, 31 caught the
 * inline-arrow prop but missed the forwardRef prop hiding right
 * next to it.)
 *
 * Bloomberg pattern — big tabular-num value + optional inline
 * sparkline + label above + delta chip. Design rules:
 *   - Value uses font-mono tabular-nums, ~24px, semibold.
 *   - Label sits above at 10px uppercase tracked-wide.
 *   - Sparkline is 28px tall, monochrome by default, colored to
 *     accent-positive / accent-negative when tone hints direction.
 *   - Delta chip sits inline to the right of the value.
 *   - CellFlash wraps the numeric value — on re-render if
 *     numericValue moves, the tile flashes green/red for 300ms.
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
   */
  delta?: {
    label: string;
    direction: 'up' | 'down' | 'flat';
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
