import * as React from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Optional CTA — usually a <Button asChild><Link/></Button>. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Empty-state card. Used wherever a list, table, or section has no
 * content yet. Pairs a muted lucide icon with a single sentence of
 * direct copy and an optional CTA.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: Props) {
  return (
    <div
      className={cn(
        'border-border bg-bg-elevated/40 flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="bg-bg-active text-fg-muted flex h-10 w-10 items-center justify-center rounded-md">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-fg text-sm font-medium">{title}</p>
        {description && (
          <p className="text-fg-muted max-w-md text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
