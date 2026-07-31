import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { BreadcrumbTracker } from '@/components/error-tracking/breadcrumb-tracker';
import { NavProgress } from '@/components/shell/nav-progress';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Ads Bot',
    template: '%s - Ads Bot',
  },
  description:
    'Auto-generate, launch, kill, and scale Meta ad creative on autopilot. For performance marketers running aggressive verticals.',
};

/**
 * Root layout — loads Geist + Geist Mono as CSS variables, forces the
 * `dark` class on <html> (no light theme), and renders children inside a
 * full-height body. The actual chrome (sidebar, top bar) lives in the
 * AppShell component which authenticated pages import directly.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`dark ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="bg-bg text-fg min-h-screen font-sans antialiased">
        {/* Top-bar navigation progress indicator. useSearchParams
            requires a Suspense boundary on SSR. */}
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        {/* Polish-25.7 Commit 46: mounts client-error-logger's
            global handlers + tracks nav/click breadcrumbs. */}
        <BreadcrumbTracker />
        {children}
      </body>
    </html>
  );
}
