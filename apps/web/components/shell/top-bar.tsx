import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface Props {
  /** Breadcrumb chain — last item is the current page (no link). */
  crumbs: Breadcrumb[];
  /** Optional right-aligned action (e.g. primary button on a list page). */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Thin (~48px) top bar above the page content. Breadcrumb on the left,
 * optional page-specific action on the right. Bottom-bordered so it
 * reads as separate from the page content even on dense routes.
 */
export function TopBar({ crumbs, action, className }: Props) {
  return (
    <header
      className={cn(
        'bg-bg sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b px-6',
        className,
      )}
    >
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="text-fg-subtle h-3.5 w-3.5 shrink-0" />}
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="text-fg-muted hover:text-fg truncate transition-colors"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className={cn('truncate', isLast ? 'text-fg' : 'text-fg-muted')}>
                  {crumb.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );
}
