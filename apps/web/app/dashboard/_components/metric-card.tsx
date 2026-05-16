import { type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface Props {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'neutral' | 'good' | 'bad';
}

/**
 * Ads Bot metric card. Numbers in mono, lucide icon top-right (no
 * emoji prefix), tone tints the value color sparingly — only when the
 * caller passes good/bad.
 */
export function MetricCard({ label, value, hint, icon: Icon, tone = 'neutral' }: Props) {
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
        {value}
      </p>
      {hint && <p className="text-fg-muted mt-1 text-xs">{hint}</p>}
    </Card>
  );
}
