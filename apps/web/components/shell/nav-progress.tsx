'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Thin top-bar progress indicator for client-side navigations. No
 * external dep (skipping nprogress because of its CSS overhead) —
 * just a fixed-position bar that:
 *
 *   1. Listens for clicks on internal <a href="/..."> links and same-
 *      origin Link clicks at the document level. Shows + ramps the
 *      bar from 0% → ~80% (asymptotic so a slow navigation never
 *      reaches 100% before the page swap).
 *   2. Resets to 100% + fades out when the pathname or query string
 *      changes (= navigation completed).
 *
 * Mounts once in the root layout. Pointer-events:none so it never
 * intercepts user input.
 */
export function NavProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [progress, setProgress] = React.useState(0);
  const [visible, setVisible] = React.useState(false);
  const rampRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // When pathname OR query changes, the navigation completed — snap
  // to 100% and fade out.
  React.useEffect(() => {
    if (rampRef.current) {
      clearInterval(rampRef.current);
      rampRef.current = null;
    }
    if (!visible) return;
    setProgress(100);
    const id = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 200);
    return () => clearTimeout(id);
    // We deliberately depend on pathname + searchParams to detect
    // navigation completion. `visible` would cause a render loop.
  }, [pathname, searchParams]);

  // Document-level click handler: catches same-origin link clicks
  // anywhere in the tree without needing per-Link instrumentation.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      // Skip modifier-clicked links (open in new tab, etc.).
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      // Internal navigation only — skip mailto:, tel:, external, hash-only.
      if (/^(https?:)?\/\//.test(href) && !href.startsWith(window.location.origin)) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
      if (href.startsWith('#')) return;
      if (anchor.target === '_blank') return;

      start();
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  function start() {
    if (rampRef.current) clearInterval(rampRef.current);
    setVisible(true);
    setProgress(10);
    // Asymptotic ramp: each tick adds a fraction of the remaining gap
    // to 80%, so it slows the closer it gets without ever finishing.
    rampRef.current = setInterval(() => {
      setProgress((p) => (p < 80 ? p + (80 - p) * 0.15 : p));
    }, 200);
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 150ms ease-out' }}
    >
      <div
        className="bg-fg h-full"
        style={{ width: `${progress}%`, transition: 'width 180ms ease-out' }}
      />
    </div>
  );
}
