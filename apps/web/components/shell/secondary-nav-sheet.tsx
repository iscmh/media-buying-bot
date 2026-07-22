'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Plug, Settings, Shield, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { signOutAction } from './sidebar-actions';

interface SectionLink {
  href: string;
  label: string;
}

interface Section {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  links: SectionLink[];
}

// Polish-25.1 Commit 10a: 4 connection surfaces consolidated into
// /settings/connections. The section now has one link that opens
// the tabbed page (Providers / Meta / Telegram).
const SECTIONS: Section[] = [
  {
    title: 'Connections',
    icon: Plug,
    links: [{ href: '/settings/connections', label: 'All connections' }],
  },
  {
    title: 'Settings',
    icon: Settings,
    links: [{ href: '/settings', label: 'All settings' }],
  },
  {
    title: 'Account',
    icon: User,
    links: [
      { href: '/settings', label: 'Account' },
      { href: '/settings', label: 'Billing' },
    ],
  },
];

interface Props {
  email: string;
  isAdmin: boolean;
}

/**
 * Polish-18 Commit 2: secondary-nav side panel. Replaces the old
 * sidebar avatar dropdown. Houses Connections / Settings / Account /
 * Billing / Sign out so the primary sidebar can stay focused on the
 * three operator routes (Dashboard / Concepts / Launched ads).
 *
 * Built on the Radix Dialog primitive for a11y (focus trap, ESC,
 * scroll lock, ARIA roles) — the local Sheet primitive wraps it with
 * side-slide animations.
 */
export function SecondaryNavSheet({ email, isAdmin }: Props) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // Close the panel after a navigation completes — Next's <Link>
  // doesn't auto-dismiss overlays since route changes don't unmount us.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    setOpen(false);
    await signOutAction();
    router.refresh();
    router.push('/login');
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className={cn(
            'hover:bg-bg-surfaceHover focus-visible:ring-border-focus inline-flex h-8 w-8 items-center justify-center',
            'rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback>{email.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>Account</SheetTitle>
          <SheetDescription className="truncate">{email}</SheetDescription>
        </SheetHeader>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <div key={section.title} className="mt-4">
                <div className="text-fg-subtle flex items-center gap-1.5 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider">
                  <Icon className="h-3 w-3" />
                  {section.title}
                </div>
                <div className="space-y-0.5">
                  {section.links.map((l) => {
                    const active = pathname === l.href || pathname.startsWith(l.href + '/');
                    return (
                      <Link
                        key={`${section.title}-${l.label}`}
                        href={l.href}
                        className={cn(
                          'block rounded-sm px-3 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-bg-inset text-fg'
                            : 'text-fg-muted hover:bg-bg-surfaceHover hover:text-fg',
                        )}
                      >
                        {l.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {isAdmin && (
            <div className="mt-4">
              <div className="text-fg-subtle flex items-center gap-1.5 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider">
                <Shield className="h-3 w-3" />
                Admin
              </div>
              <Link
                href="/admin/applications"
                className={cn(
                  'block rounded-sm px-3 py-1.5 text-sm transition-colors',
                  pathname.startsWith('/admin')
                    ? 'bg-bg-inset text-fg'
                    : 'text-fg-muted hover:bg-bg-surfaceHover hover:text-fg',
                )}
              >
                Applications
              </Link>
            </div>
          )}
        </nav>

        <SheetFooter>
          <button
            type="button"
            onClick={handleSignOut}
            className="text-fg-muted hover:bg-bg-surfaceHover hover:text-fg flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
