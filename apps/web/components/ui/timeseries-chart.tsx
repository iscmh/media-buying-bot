'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Polish-25.5 Commit 30: client-only wrapper around the recharts
 * TimeseriesChart. Uses `next/dynamic({ ssr: false })` so recharts
 * (and its transitive DOM-touching deps like react-resize-detector)
 * NEVER loads on the server.
 *
 * WHY THE DYNAMIC WRAPPER (Commit 30 fix):
 *
 * Commit 29 tried to fix digest 2795558093 with a mount-flag inside
 * the component. That prevented render-time crashes but NOT
 * import-time ones — recharts 2.15's transitive deps touch DOM APIs
 * at module load. Even though the render was gated, the module was
 * still imported into the server bundle, and importing it crashed
 * SSR. `next/dynamic({ ssr: false })` is the only way to keep those
 * modules out of the server bundle entirely.
 *
 * The `loading` fallback matches the real component's final height
 * so there is no layout shift between initial paint and hydration.
 *
 * `TimeseriesPoint` is re-exported from the inner module so
 * consumers can import the type alongside the component without
 * loading the recharts module themselves (type-only re-export
 * elides at compile time).
 */
export type { TimeseriesPoint } from './timeseries-chart-inner';

interface Props {
  data: Array<{ date: string; primary: number; secondary: number }>;
  primaryLabel: string;
  secondaryLabel: string;
  primaryFormat?: (v: number) => string;
  secondaryFormat?: (v: number) => string;
  height?: number;
}

function Placeholder() {
  // Default height (220) + wrapper padding (16) + legend row (~24) ≈ 260
  // so the initial paint's outer grid slot matches the real chart. On
  // hydration the dynamic import resolves and the real component swaps
  // in without reflow.
  return <div className="bg-bg-surface rounded-sm border" style={{ height: 260 }} aria-hidden />;
}

const TimeseriesChartDynamic = dynamic(
  () => import('./timeseries-chart-inner').then((m) => m.TimeseriesChart),
  {
    ssr: false,
    loading: () => <Placeholder />,
  },
);

export function TimeseriesChart(props: Props) {
  return <TimeseriesChartDynamic {...props} />;
}
