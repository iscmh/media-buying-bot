'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileVideo, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Polish-18 Commit 2: primary sidebar holds only the three operator
 * routes. Connections / Settings / Account / Billing / Sign out moved
 * into the side-panel triggered by the avatar button in TopBar.
 */
const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/concepts', label: 'Concepts', icon: FileVideo },
  { href: '/launched', label: 'Launched ads', icon: Rocket },
];

interface Props {
  /** Initial collapse state read from cookie on the server. */
  initialCollapsed: boolean;
}

/**
 * Ads Bot sidebar. Persistent across authenticated routes. Collapsible
 * to icon-only (~64px) — collapse state persists via cookie so it
 * survives navigations and reloads.
 */
export function Sidebar({ initialCollapsed }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    // Cookie persists per-browser; no expiry needed for UI preference.
    document.cookie = `sidebar_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        'bg-bg-elevated flex h-screen shrink-0 flex-col border-r transition-[width] duration-150',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 items-center px-4">
        <Link
          href="/dashboard"
          className="text-fg flex items-center gap-2 text-base font-bold tracking-tight"
        >
          {collapsed ? <span aria-hidden>AB</span> : <span>Ads Bot</span>}
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
        ))}
      </nav>

      <div className="border-t p-2">
        <button
          type="button"
          onClick={toggleCollapse}
          className={cn(
            'text-fg-muted hover:bg-bg-hover hover:text-fg flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs transition-colors',
            collapsed && 'justify-center',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        isActive ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
        collapsed && 'justify-center',
      )}
    >
      <Icon className="h-4 w-4" />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}
