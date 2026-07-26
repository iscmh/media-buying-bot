'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Polish-25.5 Commit 30: client-only wrapper around the recharts
 * TimeseriesChart.
 *
 * Polish-25.5 Commit 31: fix the ACTUAL crash behind digest 2795558093.
 *
 * Commits 29 + 30 chased a recharts SSR theory that never applied.
 * The real bug: this wrapper's Props previously accepted
 * `primaryFormat?: (v: number) => string`. The dashboard is a Server
 * Component and rendered `<TimeseriesChart primaryFormat={(v) =>
 * `$${v.toFixed(0)}`} … />`. Next.js 14 App Router prohibits arbitrary
 * function values across the Server → Client Component prop boundary
 * (only serializable JSON + Server Actions + component references are
 * allowed). That inline arrow blew up at serialization time, taking
 * the whole page render with it. Only the dashboard rendered a
 * function prop, which is why only the dashboard crashed. Only
 * Commit 28 unhid the metrics-grid branch that renders this chart,
 * which is why the crash didn't surface before 25.5.1.
 *
 * Fix: format props are a string enum now. The inner component maps
 * the enum to the actual tick-formatter internally. Callers can no
 * longer pass a function → the serialization boundary is safe by
 * construction. Adding a new format = adding a new enum value + one
 * switch case, cheap.
 *
 * `next/dynamic({ ssr: false })` is kept from Commit 30 for defense-
 * in-depth: recharts genuinely does have client-only deps and
 * skipping it on the server is still correct even though it wasn't
 * the crash trigger.
 */
export type { TimeseriesPoint } from './timeseries-chart-inner';

/**
 * Enum of numeric formatters the chart understands. Server-safe by
 * design — string values serialize trivially across the RSC boundary.
 */
export type TimeseriesNumberFormat = 'plain' | 'usd' | 'k' | 'pct';

interface Props {
  data: Array<{ date: string; primary: number; secondary: number }>;
  primaryLabel: string;
  secondaryLabel: string;
  /** How to format Y-axis + tooltip values for the primary series. */
  primaryFormat?: TimeseriesNumberFormat;
  /** How to format Y-axis + tooltip values for the secondary series. */
  secondaryFormat?: TimeseriesNumberFormat;
  height?: number;
}

function Placeholder() {
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
