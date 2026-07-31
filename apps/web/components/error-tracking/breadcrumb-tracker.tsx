'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { logBreadcrumb } from '@/lib/client-error-logger';

/**
 * Polish-25.7 Commit 46: passive tracker mounted once in the root
 * layout. Emits breadcrumbs for:
 *   - route navigation (pathname change)
 *   - global click (event delegation on document; captures the
 *     nearest [data-track] / role=button / <button> / <a> label)
 *
 * Fetch / form breadcrumbs are NOT auto-tracked here — too much
 * noise vs. signal at beta scale. Add them explicitly via
 * logBreadcrumb() at call sites that matter.
 *
 * No visible UI. Returns null.
 */
export function BreadcrumbTracker(): React.ReactElement | null {
  const pathname = usePathname();

  // Route breadcrumb.
  React.useEffect(() => {
    logBreadcrumb({ category: 'navigation', message: pathname });
  }, [pathname]);

  // Click breadcrumb via event delegation.
  React.useEffect(() => {
    function onClick(evt: MouseEvent) {
      const target = evt.target as HTMLElement | null;
      if (!target) return;
      const el = target.closest<HTMLElement>('[data-track], button, a, [role="button"]');
      if (!el) return;
      const label =
        el.getAttribute('data-track') ??
        el.getAttribute('aria-label') ??
        el.textContent?.trim().slice(0, 80) ??
        el.tagName.toLowerCase();
      logBreadcrumb({
        category: 'click',
        message: label,
        data: { tag: el.tagName.toLowerCase() },
      });
    }
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  return null;
}
