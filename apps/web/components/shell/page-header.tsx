import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Polish-17 Phase 2: consistent page header.
 *
 * Every page lands in the same horizontal rhythm — title in text-xl
 * Geist (sentence case), optional subtitle in text-sm muted, optional
 * right-aligned actions slot. Hairline bottom border separates the
 * header from page content.
 *
 * Replaces the ad-hoc <header className="mb-6"> + <h1 className="text-2xl
 * font-semibold"> pattern that every page currently re-implements.
 * Pages still own their crumbs (rendered by AppShell above the header).
 *
 * Usage:
 *   <PageHeader
 *     title="Generate variants"
 *     subtitle={'From: "Morning routine ad"'}
 *     actions={<Button variant="primary">Generate</Button>}
 *   />
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned actions (buttons, link icons, etc.). Optional. */
  actions?: React.ReactNode;
  /** Polish-17: optional extra row of meta info under title (e.g. status dot + cost). */
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn('border-border mb-6 border-b pb-4', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-fg truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-fg-muted mt-1 truncate text-sm">{subtitle}</p>}
          {meta && (
            <div className="text-fg-muted mt-1.5 flex items-center gap-2 text-xs">{meta}</div>
          )}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
