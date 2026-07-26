'use client';

import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

/**
 * Polish-25.5 Commit 30: recharts render only. This file is NEVER
 * imported into the server bundle — the sibling `sparkline.tsx`
 * wraps it in `next/dynamic({ ssr: false })` so the recharts module
 * graph (including transitive DOM-touching deps like
 * react-resize-detector) is client-only. Consumers import from
 * `./sparkline`, not from here.
 *
 * Bloomberg / TradingView pattern — a small trend line inside the
 * same cell as the big number. Zero axes, zero legend, zero tooltip.
 * A single monochrome area path that reads as movement, not detail.
 *
 * Empty / short series (< 2 points) renders the same dashed
 * placeholder the wrapper uses during load — so the pop-in is
 * invisible when there's no data.
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

// A safe DOM id derived from an arbitrary color value. `var(--fg)` becomes
// `spark-var--fg` — legal id characters, and each caller gets a distinct
// gradient so multiple sparklines on one page don't collide.
function safeGradientId(color: string): string {
  return `spark-${color.replace(/[^a-zA-Z0-9_-]/g, '')}`;
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

  const gradientId = safeGradientId(color);
  return (
    <div className="w-full" style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.25}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
