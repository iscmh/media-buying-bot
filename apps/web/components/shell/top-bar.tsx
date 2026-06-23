import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SecondaryNavSheet } from './secondary-nav-sheet';

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface Props {
  /** Breadcrumb chain — last item is the current page (no link). */
  crumbs: Breadcrumb[];
  /** Optional right-aligned action (e.g. primary button on a list page). */
  action?: React.ReactNode;
  /** Authenticated user email — surfaced in the side-panel header. */
  email: string;
  /** Whether to surface the Admin section in the side panel. */
  isAdmin: boolean;
  className?: string;
}

/**
 * Thin (~48px) top bar above the page content. Breadcrumb on the left,
 * optional page-specific action then the avatar / secondary-nav trigger
 * on the right. Polish-18 Commit 2: the avatar button opens a side
 * panel housing Connections / Settings / Account / Billing / Sign out.
 */
export function TopBar({ crumbs, action, email, isAdmin, className }: Props) {
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
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <SecondaryNavSheet email={email} isAdmin={isAdmin} />
      </div>
    </header>
  );
}
