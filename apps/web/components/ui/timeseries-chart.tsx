'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Polish-25.5 Commit 27: standardized timeseries chart wrapper.
 * Polish-25.5 Commit 29: client-only render (SSR crash fix).
 *
 * TradingView / Datadog treatment — dashed low-contrast gridlines,
 * inline legend swatch, tabular-num labels, tooltip on hover.
 * Recharts under the hood (previously hand-rolled SVG). Dual-series
 * out of the box: primary (spend) + secondary (conversions).
 *
 * Empty / one-point series renders a hint block instead of an
 * unusable chart — matches EmptyState treatment.
 *
 * WHY THE MOUNT GATE (Commit 29 fix):
 * `ResponsiveContainer` uses `ResizeObserver`, which doesn't exist
 * server-side under Next.js SSR — the operator hit digest
 * 2795558093 the moment Commit 28's predicate fix started routing
 * the paused-launch flow through this component. Server render
 * emits an equal-height empty panel; on hydration, the effect fires
 * and the real chart mounts. Zero layout shift.
 */
export interface TimeseriesPoint {
  date: string;
  primary: number;
  secondary: number;
}

interface Props {
  data: TimeseriesPoint[];
  primaryLabel: string;
  secondaryLabel: string;
  /** Format each primary value for the tooltip (e.g. usd, k, plain). */
  primaryFormat?: (v: number) => string;
  /** Format each secondary value for the tooltip. */
  secondaryFormat?: (v: number) => string;
  height?: number;
}

const defaultFmt = (v: number) => v.toLocaleString();

export function TimeseriesChart({
  data,
  primaryLabel,
  secondaryLabel,
  primaryFormat = defaultFmt,
  secondaryFormat = defaultFmt,
  height = 220,
}: Props) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!data || data.length < 2) {
    return (
      <div
        className="bg-bg-surface text-fg-muted flex items-center justify-center rounded-sm border p-6 text-xs"
        style={{ height }}
      >
        Not enough data to draw a trend yet.
      </div>
    );
  }

  if (!mounted) {
    // SSR-safe placeholder — same height as the real chart so hydration
    // doesn't reflow the surrounding grid. Border matches the real
    // rendered panel so no visual pop when the chart mounts.
    return (
      <div
        className="bg-bg-surface rounded-sm border"
        style={{ height: height + 40 }}
        aria-hidden
      />
    );
  }

  return (
    <div className="bg-bg-surface flex flex-col rounded-sm border p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="text-fg-muted flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="bg-fg inline-block h-2 w-2 rounded-full" />
            {primaryLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: 'var(--accent-positive)' }}
            />
            {secondaryLabel}
          </span>
        </div>
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="ts-primary" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--fg)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--fg)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="ts-secondary" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-positive)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--accent-positive)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border-strong)"
              vertical={false}
              opacity={0.4}
            />
            <XAxis
              dataKey="date"
              stroke="var(--fg-subtle)"
              tick={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              yAxisId="primary"
              stroke="var(--fg-subtle)"
              tick={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={(v: number) => primaryFormat(v)}
            />
            <YAxis
              yAxisId="secondary"
              orientation="right"
              stroke="var(--fg-subtle)"
              tick={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)' }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border-strong)' }}
              wrapperStyle={{ outline: 'none' }}
              contentStyle={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
                borderRadius: 2,
                fontSize: 11,
                fontFamily: 'var(--font-geist-mono)',
              }}
              labelStyle={{ color: 'var(--fg-muted)' }}
              formatter={(v: number, name: string) => {
                if (name === 'primary') return [primaryFormat(v), primaryLabel];
                return [secondaryFormat(v), secondaryLabel];
              }}
            />
            <Area
              yAxisId="primary"
              type="monotone"
              dataKey="primary"
              stroke="var(--fg)"
              strokeWidth={1.5}
              fill="url(#ts-primary)"
              isAnimationActive={false}
            />
            <Area
              yAxisId="secondary"
              type="monotone"
              dataKey="secondary"
              stroke="var(--accent-positive)"
              strokeWidth={1.5}
              fill="url(#ts-secondary)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
