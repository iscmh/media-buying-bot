'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Polish-25.5 Commit 30: client-only wrapper around the recharts
 * Sparkline. Uses `next/dynamic({ ssr: false })` so the underlying
 * recharts module (and its transitive DOM-touching deps like
 * react-resize-detector) NEVER loads on the server.
 *
 * WHY THE DYNAMIC WRAPPER (Commit 30 fix):
 *
 * Commit 29 tried to fix digest 2795558093 with a mount-flag inside
 * the component. That prevented render-time crashes but NOT
 * import-time ones — recharts 2.15's transitive dep
 * `react-resize-detector` (and a few others) touches DOM APIs at
 * module load. `next/dynamic({ ssr: false })` is the only way to
 * keep those modules out of the server bundle entirely.
 *
 * The `loading` fallback is a same-height dashed placeholder so
 * there is no layout shift between initial paint and hydration.
 *
 * The `SparklinePoint` type is re-exported from the inner module so
 * consumers can import it alongside the component without loading
 * the recharts module themselves (type-only re-export elides at
 * compile time).
 */
export type { SparklinePoint } from './sparkline-inner';

interface Props {
  data: Array<{ v: number }>;
  color?: string;
  height?: number;
}

/**
 * Same-height dashed placeholder used during dynamic-load AND on
 * empty / short-series data inside the real component. Kept in sync
 * so the pop-in is invisible in the common case.
 */
function Placeholder({ height = 28 }: { height?: number }) {
  return (
    <div
      aria-hidden
      className="w-full"
      style={{ height, borderBottom: '1px dashed var(--border-subtle)' }}
    />
  );
}

const SparklineDynamic = dynamic(() => import('./sparkline-inner').then((m) => m.Sparkline), {
  ssr: false,
  loading: () => <Placeholder />,
});

export function Sparkline(props: Props) {
  return <SparklineDynamic {...props} />;
}
