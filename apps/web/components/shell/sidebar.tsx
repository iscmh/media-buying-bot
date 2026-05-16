'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronDown,
  FileVideo,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Rocket,
  Settings,
  Shield,
  User,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { signOutAction } from './sidebar-actions';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Sub-items expand under this one when the sidebar is expanded. */
  children?: Array<{ href: string; label: string }>;
}

const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/concepts', label: 'Concepts', icon: FileVideo },
  { href: '/launched', label: 'Launched ads', icon: Rocket },
  {
    href: '/connections/meta',
    label: 'Connections',
    icon: Plug,
    children: [
      { href: '/connections/meta', label: 'Meta' },
      { href: '/connections/telegram', label: 'Telegram' },
      { href: '/connections/ai-provider', label: 'AI provider' },
      { href: '/connections/tools', label: 'Tools' },
    ],
  },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface Props {
  email: string;
  isAdmin: boolean;
  /** Initial collapse state read from cookie on the server. */
  initialCollapsed: boolean;
}

/**
 * Ads Bot sidebar. Persistent across authenticated routes. Collapsible
 * to icon-only (~64px) — collapse state persists via cookie so it
 * survives navigations and reloads.
 */
export function Sidebar({ email, isAdmin, initialCollapsed }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);

  const navItems = React.useMemo(() => {
    return isAdmin
      ? [...PRIMARY_NAV, { href: '/admin/applications', label: 'Admin', icon: Shield }]
      : PRIMARY_NAV;
  }, [isAdmin]);

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    // Cookie persists per-browser; no expiry needed for UI preference.
    document.cookie = `sidebar_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  }

  async function handleSignOut() {
    await signOutAction();
    router.refresh();
    router.push('/login');
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
        {navItems.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
        ))}
      </nav>

      <div className="space-y-1 border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'hover:bg-bg-hover flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors',
                collapsed && 'justify-center',
              )}
            >
              <Avatar className="h-7 w-7">
                <AvatarFallback>{email.slice(0, 1)}</AvatarFallback>
              </Avatar>
              {!collapsed && <span className="text-fg-muted truncate text-xs">{email}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <User className="h-4 w-4" />
                Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSignOut}>
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

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
  const hasChildren = !!item.children?.length;
  const isAnyChildActive = hasChildren
    ? item.children!.some((c) => pathname.startsWith(c.href))
    : false;
  const isActive =
    pathname === item.href || pathname.startsWith(item.href + '/') || isAnyChildActive;

  // Auto-expand the children group when collapsed=false and a child is active.
  const [open, setOpen] = React.useState(isAnyChildActive);
  React.useEffect(() => {
    if (isAnyChildActive) setOpen(true);
  }, [isAnyChildActive]);

  if (hasChildren && !collapsed) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            isActive ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="flex-1 text-left">{item.label}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <div className="ml-6 mt-0.5 space-y-0.5 border-l pl-2">
            {item.children!.map((child) => {
              const childActive = pathname === child.href || pathname.startsWith(child.href + '/');
              return (
                <Link
                  key={child.href}
                  href={child.href}
                  className={cn(
                    'block rounded-md px-2 py-1 text-xs transition-colors',
                    childActive ? 'text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg',
                  )}
                >
                  {child.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
