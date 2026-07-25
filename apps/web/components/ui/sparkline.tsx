'use client';

import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

/**
 * Polish-25.5 Commit 27: inline sparkline for KPI tiles.
 *
 * Bloomberg / TradingView pattern — a small trend line inside the
 * same cell as the big number. Zero axes, zero legend, zero tooltip.
 * A single monochrome area path that reads as movement, not detail.
 *
 * Height fixed at 28px so it slots under a big KPI value without
 * changing tile height. Width fills the parent (ResponsiveContainer).
 *
 * Empty / short series (< 2 points) renders a flat baseline instead
 * of erroring — never a broken chart on empty data.
 */
export interface SparklinePoint {
  v: number;
}

interface Props {
  data: SparklinePoint[];
  /** Line + fill color. Defaults to --fg. Pass a --pos / --neg for tone. */
  color?: string;
  /** Fixed pixel height. Defaults to 28. */
  height?: number;
}

export function Sparkline({ data, color = 'var(--fg)', height = 28 }: Props) {
  if (!data || data.length < 2) {
    return (
      <div
        aria-hidden
        className="w-full"
        style={{ height, borderBottom: '1px dashed var(--border-subtle)' }}
      />
    );
  }
  return (
    <div className="w-full" style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <defs>
            <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.25}
            fill={`url(#spark-${color})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
