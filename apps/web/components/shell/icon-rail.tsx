'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  FileVideo,
  LayoutDashboard,
  ListTodo,
  Menu,
  Plug,
  Rocket,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: 48px icon rail — primary navigation.
 *
 * Datadog-style: icon-only always (no expand/collapse), hover shows
 * the label as a floating tooltip. The old expandable sidebar was
 * quintessentially SaaS; this is quintessentially pro-tool.
 *
 * Rail items are the operator's core routes. Secondary destinations
 * (Presets, Rules, Account, Sign out) live behind the account menu
 * or the Cmd+K palette — not everything belongs in the primary rail.
 *
 * Mobile: rail collapses to a top-left hamburger button that opens
 * a drawer of the same items. Detected via viewport and rendered
 * separately in AppShell.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  matchPrefix?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // Polish-29.0.7 Commit 116: Quick Seedance — the one-prompt credit-
  // backed video generator. Sits above Concepts so first-time users
  // discover the fastest path to a first output.
  {
    href: '/generate/seedance',
    label: 'Quick video',
    icon: Sparkles,
    matchPrefix: '/generate/seedance',
  },
  { href: '/concepts', label: 'Concepts', icon: FileVideo, matchPrefix: '/concepts' },
  { href: '/runs', label: 'Runs', icon: Workflow, matchPrefix: '/runs' },
  { href: '/pending', label: 'Pending', icon: ListTodo, matchPrefix: '/pending' },
  { href: '/launched', label: 'Launched', icon: Rocket, matchPrefix: '/launched' },
];

const SECONDARY_ITEMS: NavItem[] = [
  {
    href: '/settings/connections',
    label: 'Connections',
    icon: Plug,
    matchPrefix: '/settings/connections',
  },
  { href: '/settings', label: 'Settings', icon: Settings, matchPrefix: '/settings' },
];

interface Props {
  /** Whether to show the "Launched" nav row — only when user has ≥1 launched ad. */
  showLaunched: boolean;
}

export function IconRail({ showLaunched }: Props) {
  const pathname = usePathname();

  const primary = React.useMemo(
    () => (showLaunched ? NAV_ITEMS : NAV_ITEMS.filter((n) => n.href !== '/launched')),
    [showLaunched],
  );

  return (
    <aside
      aria-label="Primary navigation"
      className="bg-bg-elevated hidden h-screen w-12 shrink-0 flex-col items-center border-r py-2 md:flex"
    >
      <Link
        href="/dashboard"
        className="text-fg mb-2 flex h-9 w-9 items-center justify-center rounded-sm text-xs font-bold tracking-tight"
        title="Ads Bot"
      >
        AB
      </Link>
      <nav className="flex flex-1 flex-col items-center gap-1">
        {primary.map((item) => (
          <RailItem key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>
      <div className="mt-auto flex w-full flex-col items-center gap-1 border-t pt-2">
        {SECONDARY_ITEMS.map((item) => (
          <RailItem key={item.href} item={item} pathname={pathname} />
        ))}
      </div>
    </aside>
  );
}

function RailItem({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const isActive =
    pathname === item.href ||
    (item.matchPrefix
      ? pathname.startsWith(item.matchPrefix + '/') || pathname === item.matchPrefix
      : false);

  return (
    <Link
      href={item.href}
      title={item.label}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'group relative flex h-9 w-9 items-center justify-center rounded-sm transition-colors',
        isActive ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
      )}
    >
      <Icon className="h-4 w-4" />
      {/* Amber left-accent bar for the active item — mirrors the row-hover
          pattern already established on TableRow. */}
      {isActive && (
        <span
          aria-hidden
          className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-r-sm"
          style={{ background: 'var(--accent-amber)' }}
        />
      )}
      {/* Hover tooltip — right of rail, appears after 500ms. */}
      <span
        role="tooltip"
        className={cn(
          'bg-bg-surface text-fg pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-sm border px-2 py-1 text-xs opacity-0 shadow-md transition-opacity',
          'group-hover:opacity-100',
        )}
        style={{ transitionDelay: '400ms' }}
      >
        {item.label}
      </span>
    </Link>
  );
}

/**
 * Mobile drawer — same items as IconRail but rendered as a slide-out
 * from the left when the hamburger button in the mobile top bar is
 * tapped. Fired by AppShell's mobile top bar; kept here so nav item
 * definitions stay colocated.
 */
export function MobileNavDrawer({
  open,
  onOpenChange,
  showLaunched,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  showLaunched: boolean;
}) {
  const pathname = usePathname();
  const primary = showLaunched ? NAV_ITEMS : NAV_ITEMS.filter((n) => n.href !== '/launched');
  const all = [...primary, ...SECONDARY_ITEMS];

  React.useEffect(() => {
    onOpenChange(false);
  }, [pathname, onOpenChange]);

  if (!open) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        onClick={() => onOpenChange(false)}
        className="fixed inset-0 z-40 bg-black/60 md:hidden"
      />
      <aside className="bg-bg-elevated fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r py-3 md:hidden">
        <div className="text-fg mb-2 flex items-center gap-2 px-3 pb-2 text-sm font-bold tracking-tight">
          Ads Bot
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {all.map((item) => {
            const Icon = item.icon;
            const isActive =
              pathname === item.href ||
              (item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-bg-active text-fg'
                    : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open menu"
      className="text-fg-muted hover:text-fg inline-flex h-8 w-8 items-center justify-center rounded-sm md:hidden"
    >
      <Menu className="h-4 w-4" />
    </button>
  );
}
