'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, Search } from 'lucide-react';
import { CommandPalette, useCommandPaletteKeys } from './command-palette';
import { MobileMenuButton, MobileNavDrawer } from './icon-rail';
import { SecondaryNavSheet } from './secondary-nav-sheet';
import { cn } from '@/lib/utils';

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface Props {
  crumbs: Breadcrumb[];
  action?: React.ReactNode;
  email: string;
  isAdmin: boolean;
  showLaunched: boolean;
  recentConcepts: Array<{ id: string; name: string | null; createdAt: Date | string }>;
  recentJobs: Array<{ id: string; status: string; createdAt: Date | string }>;
  recentLaunched: Array<{
    id: string;
    headline: string | null;
    status: string;
    launchedAt: Date | string | null;
    generationJobId?: string | null;
  }>;
}

/**
 * Polish-25.5 Commit 27: top toolbar above the page canvas.
 *
 * Left: mobile menu button (mobile only) + breadcrumbs.
 * Center-right: command-palette launcher (looks like a search box,
 *   opens the palette on click or Cmd+K).
 * Right: page-specific action + account menu (avatar).
 *
 * Height 40px — thinner than the old 48px TopBar. The center search
 * looks like a real input so users discover the palette without
 * needing to memorize the shortcut.
 */
export function TopToolbar({
  crumbs,
  action,
  email,
  isAdmin,
  showLaunched,
  recentConcepts,
  recentJobs,
  recentLaunched,
}: Props) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  useCommandPaletteKeys(setPaletteOpen, paletteOpen);

  return (
    <>
      <header className="bg-bg sticky top-0 z-30 flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <MobileMenuButton onClick={() => setMobileMenuOpen(true)} />
        <nav
          aria-label="Breadcrumb"
          className="hidden min-w-0 items-center gap-1.5 text-sm md:flex"
        >
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

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="bg-bg-surface hover:bg-bg-surfaceHover text-fg-muted mx-auto flex h-7 min-w-[8rem] max-w-md flex-1 items-center gap-2 rounded-sm border px-2 text-xs transition-colors sm:min-w-[14rem]"
          aria-label="Open command palette"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="truncate">Jump to anything…</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider">
            ⌘K
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {action}
          <SecondaryNavSheet email={email} isAdmin={isAdmin} />
        </div>
      </header>

      <MobileNavDrawer
        open={mobileMenuOpen}
        onOpenChange={setMobileMenuOpen}
        showLaunched={showLaunched}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        recentConcepts={recentConcepts}
        recentJobs={recentJobs}
        recentLaunched={recentLaunched}
      />
    </>
  );
}
