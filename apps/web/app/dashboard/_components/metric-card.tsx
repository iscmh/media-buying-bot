import { type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CellFlash } from '@/components/ui/cell-flash';

interface Props {
  label: string;
  /** Display string (e.g. "$1,234.56", "12.34%"). Rendered inside CellFlash. */
  value: string;
  /**
   * Polish-25.4 Commit 26: numeric backing value for the CellFlash
   * primitive. When provided AND the value changes between renders,
   * the display value flashes green (increase) or red (decrease) for
   * ~300ms. Silent on first render so a page load never paints every
   * KPI red/green. Omit to skip the flash (backward-compat with
   * pre-Commit-26 call sites).
   */
  numericValue?: number | null;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'neutral' | 'good' | 'bad';
}

/**
 * Ads Bot metric card. Numbers in mono, lucide icon top-right (no
 * emoji prefix), tone tints the value color sparingly — only when the
 * caller passes good/bad.
 *
 * Polish-25.4 Commit 26: value is wrapped in CellFlash. When callers
 * pass numericValue and the number changes between renders, the value
 * flashes green (up) or red (down) for ~300ms. Bloomberg / ThinkOrSwim
 * tick-update pattern. Silent on first render — page loads don't paint
 * the KPI strip red/green. Callers that only have a display string
 * (no underlying number) can omit numericValue; the wrapper renders
 * without ever flashing.
 */
export function MetricCard({
  label,
  value,
  numericValue,
  hint,
  icon: Icon,
  tone = 'neutral',
}: Props) {
  const valueColor =
    tone === 'good'
      ? 'text-success'
      : tone === 'bad'
        ? 'text-[color:var(--destructive-color)]'
        : 'text-fg';
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-fg-muted text-xs font-medium uppercase tracking-wide">{label}</p>
        {Icon && <Icon className="text-fg-subtle h-4 w-4" />}
      </div>
      <p className={`mt-2 font-mono text-2xl font-semibold tracking-tight ${valueColor}`}>
        <CellFlash value={numericValue}>{value}</CellFlash>
      </p>
      {hint && <p className="text-fg-muted mt-1 text-xs">{hint}</p>}
    </Card>
  );
}
