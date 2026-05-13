interface Point {
  date: string;
  spendUsd: number;
  conversions: number;
}

interface Props {
  data: Point[];
}

/**
 * Phase 6: dual-series sparkline (spend area + conversions dots). Hand-
 * rolled SVG so we don't pull a chart library for what's effectively a
 * 200-line visual. Replace with recharts/d3 when polish matters more
 * than ship-speed.
 */
export function SpendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="bg-card text-muted-foreground flex h-48 items-center justify-center rounded-lg border text-sm">
        No daily summary history yet — the recap cron writes one row per day per user.
      </div>
    );
  }

  const W = 800;
  const H = 200;
  const PAD = 24;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;

  const maxSpend = Math.max(...data.map((p) => p.spendUsd), 1);
  const maxConv = Math.max(...data.map((p) => p.conversions), 1);
  const xFor = (i: number) =>
    data.length === 1 ? PAD + innerW / 2 : PAD + (i / (data.length - 1)) * innerW;
  const yForSpend = (v: number) => PAD + innerH - (v / maxSpend) * innerH;
  const yForConv = (v: number) => PAD + innerH - (v / maxConv) * innerH;

  // Spend area + line.
  const linePath = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yForSpend(p.spendUsd)}`)
    .join(' ');
  const areaPath =
    `M ${xFor(0)} ${PAD + innerH} ` +
    data.map((p, i) => `L ${xFor(i)} ${yForSpend(p.spendUsd)}`).join(' ') +
    ` L ${xFor(data.length - 1)} ${PAD + innerH} Z`;

  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Spend &amp; conversions ·{' '}
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500/70" /> spend ·{' '}
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" /> conv
        </span>
        <span className="text-muted-foreground">Max spend ${maxSpend.toFixed(2)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full">
        {/* axes */}
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-muted-foreground/30" />
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          className="stroke-muted-foreground/30"
        />

        {/* spend area */}
        <path d={areaPath} className="fill-blue-500/10" />
        <path d={linePath} className="fill-none stroke-blue-500 stroke-2" />

        {/* conversion dots */}
        {data.map((p, i) => (
          <circle
            key={p.date}
            cx={xFor(i)}
            cy={yForConv(p.conversions)}
            r={3}
            className="fill-green-500"
          >
            <title>
              {p.date}: ${p.spendUsd.toFixed(2)} · {p.conversions} conv
            </title>
          </circle>
        ))}

        {/* x labels — first / last only to keep readable */}
        <text x={PAD} y={H - 6} className="fill-muted-foreground text-[10px]">
          {data[0]!.date}
        </text>
        <text x={W - PAD} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[10px]">
          {data[data.length - 1]!.date}
        </text>
      </svg>
    </div>
  );
}
