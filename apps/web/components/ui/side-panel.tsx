'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: reusable right slide-out SidePanel.
 *
 * Datadog SidePanel pattern: any list row can open a right-anchored
 * detail panel without navigating away. Built on Radix Dialog (Sheet
 * primitive is scoped to the account menu; this one is data-detail).
 *
 * Three width sizes:
 *   sm  = 24rem  (384px)  narrow — quick edit
 *   md  = 32rem  (512px)  default — detail with tabs
 *   lg  = 42rem  (672px)  wide — variant preview + metadata
 *
 * Overlay is optional: dashboards that want the panel to co-exist
 * with page interaction (Datadog-style non-modal) pass `overlay={false}`.
 * Default is overlay=true for the common "open, read, close" flow.
 */
export type SidePanelSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<SidePanelSize, string> = {
  sm: 'w-full sm:max-w-sm',
  md: 'w-full sm:max-w-lg',
  lg: 'w-full sm:max-w-2xl',
};

interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: SidePanelSize;
  overlay?: boolean;
  children: React.ReactNode;
}

export function SidePanel({
  open,
  onOpenChange,
  size = 'md',
  overlay = true,
  children,
}: SidePanelProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {overlay && (
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50 bg-black/60',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            )}
          />
        )}
        <DialogPrimitive.Content
          className={cn(
            'bg-bg-surface fixed inset-y-0 right-0 z-50 flex flex-col border-l',
            'transition ease-in-out',
            'data-[state=closed]:duration-200 data-[state=open]:duration-300',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
            sizeClass[size],
          )}
        >
          {children}
          <DialogPrimitive.Close
            className={cn(
              'text-fg-muted hover:text-fg focus-visible:ring-border-focus absolute right-3 top-3',
              'rounded-sm p-1 opacity-80 transition-opacity hover:opacity-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
            )}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function SidePanelHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b px-5 py-4', className)}>
      <div className="min-w-0 flex-1 pr-8">
        <DialogPrimitive.Title className="text-fg truncate text-sm font-semibold tracking-tight">
          {title}
        </DialogPrimitive.Title>
        {subtitle && (
          <DialogPrimitive.Description className="text-fg-muted mt-0.5 truncate text-xs">
            {subtitle}
          </DialogPrimitive.Description>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SidePanelBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)}>{children}</div>;
}

export function SidePanelFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-end gap-2 border-t px-5 py-3', className)}>
      {children}
    </div>
  );
}
