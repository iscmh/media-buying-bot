import { LineChart } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';

interface Point {
  date: string;
  spendUsd: number;
  conversions: number;
}

interface Props {
  data: Point[];
}

/**
 * Daily spend + conversions sparkline. Hand-rolled SVG (no chart-library
 * dep). Palette is monochrome: spend traces use --fg, conversion dots
 * use --success (the only accent allowed — conversion-is-success
 * semantic), grid lines + axes use --border. Tooltip is the SVG
 * `<title>` element so it reads the same on touch + hover.
 */
export function SpendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title="No daily summary history yet."
        description="Your first chart shows up after 24h of bot activity. The recap cron writes one row per day per user."
      />
    );
  }

  const W = 800;
  const H = 200;
  const PAD = 28;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;

  const maxSpend = Math.max(...data.map((p) => p.spendUsd), 1);
  const maxConv = Math.max(...data.map((p) => p.conversions), 1);
  const xFor = (i: number) =>
    data.length === 1 ? PAD + innerW / 2 : PAD + (i / (data.length - 1)) * innerW;
  const yForSpend = (v: number) => PAD + innerH - (v / maxSpend) * innerH;
  const yForConv = (v: number) => PAD + innerH - (v / maxConv) * innerH;

  const linePath = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yForSpend(p.spendUsd)}`)
    .join(' ');
  const areaPath =
    `M ${xFor(0)} ${PAD + innerH} ` +
    data.map((p, i) => `L ${xFor(i)} ${yForSpend(p.spendUsd)}`).join(' ') +
    ` L ${xFor(data.length - 1)} ${PAD + innerH} Z`;

  // Three horizontal gridlines at 25 / 50 / 75 % to give the eye a
  // sense of scale without dominating the chart.
  const gridYs = [0.25, 0.5, 0.75].map((p) => PAD + innerH - p * innerH);

  return (
    <div className="bg-bg-elevated rounded-md border p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <div className="text-fg-muted flex items-center gap-3">
          <span className="text-fg-muted flex items-center gap-1.5">
            <span className="bg-fg inline-block h-2 w-2 rounded-full" />
            Spend
          </span>
          <span className="text-fg-muted flex items-center gap-1.5">
            <span className="bg-success inline-block h-2 w-2 rounded-full" />
            Conversions
          </span>
        </div>
        <span className="text-fg-subtle font-mono">Max ${maxSpend.toFixed(2)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full">
        {/* Gridlines (--border). */}
        {gridYs.map((y) => (
          <line
            key={y}
            x1={PAD}
            y1={y}
            x2={W - PAD}
            y2={y}
            stroke="hsl(var(--border))"
            strokeDasharray="3 3"
          />
        ))}

        {/* Axes (--border-strong). */}
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="var(--border-strong)" />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border-strong)" />

        {/* Spend area + line — single neutral fg color. */}
        <path d={areaPath} fill="var(--fg)" fillOpacity={0.08} />
        <path d={linePath} fill="none" stroke="var(--fg)" strokeWidth={1.5} />

        {/* Conversion dots — sparingly use success-green for the
            "conversions happened" semantic. */}
        {data.map((p, i) => (
          <circle
            key={p.date}
            cx={xFor(i)}
            cy={yForConv(p.conversions)}
            r={3}
            fill="var(--success)"
          >
            <title>
              {p.date}: ${p.spendUsd.toFixed(2)} · {p.conversions} conv
            </title>
          </circle>
        ))}

        {/* x-axis date labels — first / last only to stay readable. */}
        <text
          x={PAD}
          y={H - 8}
          fill="var(--fg-subtle)"
          fontFamily="var(--font-geist-mono)"
          fontSize={10}
        >
          {data[0]!.date}
        </text>
        <text
          x={W - PAD}
          y={H - 8}
          textAnchor="end"
          fill="var(--fg-subtle)"
          fontFamily="var(--font-geist-mono)"
          fontSize={10}
        >
          {data[data.length - 1]!.date}
        </text>
      </svg>
    </div>
  );
}
