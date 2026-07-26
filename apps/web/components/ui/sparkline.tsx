'use client';

import * as React from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

/**
 * Polish-25.5 Commit 27: inline sparkline for KPI tiles.
 * Polish-25.5 Commit 29: client-only render (SSR crash fix).
 *
 * Bloomberg / TradingView pattern — a small trend line inside the
 * same cell as the big number. Zero axes, zero legend, zero tooltip.
 * A single monochrome area path that reads as movement, not detail.
 *
 * Height fixed at 28px so it slots under a big KPI value without
 * changing tile height. Width fills the parent (ResponsiveContainer).
 *
 * WHY THE MOUNT GATE (Commit 29 fix):
 * `ResponsiveContainer` from recharts measures its parent via
 * `ResizeObserver`, which doesn't exist under Next.js SSR. The
 * initial server render either returns an empty chart or throws
 * during hydration — the operator hit digest 2795558093 on
 * POLISH_VERSION=25.5.1 the moment Commit 28's predicate fix
 * started routing the paused-launch flow through the KpiTile
 * branch. (Commit 27 shipped this component but the buggy
 * predicate hid it from that flow, so the crash didn't surface.)
 *
 * Fix: render the same-size dashed placeholder on the server, then
 * mount the real recharts tree on the client after the first
 * effect. Zero layout shift because the placeholder occupies the
 * exact same `height` value.
 *
 * Empty / short series (< 2 points) still renders the placeholder
 * without waiting for mount — cheap out early.
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
// `var--fg` — legal id characters, and each caller gets a distinct gradient
// so multiple sparklines on one page don't collide.
function safeGradientId(color: string): string {
  return `spark-${color.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function Sparkline({ data, color = 'var(--fg)', height = 28 }: Props) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !data || data.length < 2) {
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
