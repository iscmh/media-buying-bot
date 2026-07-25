'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { roiTone, roiRowClass, roiTextClass } from '@/components/ui/roi-tone';
import { formatDateTime } from '@/lib/format/date';
import { cn } from '@/lib/utils';

/**
 * Polish-25.5 Commit 27: per-ad performance table with row-level ROI
 * shading and client-side grouping.
 *
 * Row shading — a Voluum/RedTrack move. The whole row tints green
 * when the ad is profitable (ROAS ≥ 2), red when it's losing
 * (ROAS < 1 with real spend). Neutral row when spend < $1 — the
 * empty-state safety operator required (no red band on rows that
 * haven't had a chance to spend).
 *
 * Grouping — a Voluum move. A dropdown at the top of the table
 * chooses the grouping dimension (None / Status / Concept). When
 * grouped, rows fold under sub-header rows carrying totals for the
 * grouping cell. "None" is the default so power users default to
 * flat sortable view.
 */

export interface PerAdRow {
  launchedAdId: string;
  headline: string | null;
  imageUrl: string | null;
  status: string;
  dailyBudgetUsd: number;
  totalSpendUsd: number;
  totalConversions: number;
  ctrPct: number;
  cpcUsd: number;
  impliedRoas: number;
  launchedAtIso: string;
  generationJobId: string | null;
}

type GroupKey = 'none' | 'status' | 'run';

interface Props {
  rows: PerAdRow[];
}

function adStatusBadgeVariant(status: string): BadgeVariant {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  if (status === 'killed' || status === 'rejected_by_meta' || status === 'launch_failed') {
    return 'destructive';
  }
  return 'outline';
}

function groupLabelFor(row: PerAdRow, key: GroupKey): string {
  if (key === 'status') return row.status;
  if (key === 'run') return row.generationJobId ? row.generationJobId.slice(0, 8) : '(no run)';
  return '';
}

interface GroupTotals {
  count: number;
  spend: number;
  conv: number;
}

export function PerAdTable({ rows }: Props) {
  const [group, setGroup] = React.useState<GroupKey>('none');

  const grouped = React.useMemo(() => {
    if (group === 'none') return null;
    const buckets = new Map<string, PerAdRow[]>();
    for (const r of rows) {
      const k = groupLabelFor(r, group);
      const arr = buckets.get(k) ?? [];
      arr.push(r);
      buckets.set(k, arr);
    }
    return Array.from(buckets.entries()).map(([label, items]) => {
      const totals: GroupTotals = items.reduce(
        (acc, r) => ({
          count: acc.count + 1,
          spend: acc.spend + r.totalSpendUsd,
          conv: acc.conv + r.totalConversions,
        }),
        { count: 0, spend: 0, conv: 0 },
      );
      return { label, items, totals };
    });
  }, [rows, group]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-fg-muted flex items-center gap-2 text-xs">
          <span className="text-fg-subtle font-mono uppercase tracking-wider">Group by</span>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value as GroupKey)}
            className="bg-bg-inset text-fg h-7 rounded-sm border px-2 text-xs"
          >
            <option value="none">None</option>
            <option value="status">Status</option>
            <option value="run">Run</option>
          </select>
        </div>
        <span className="text-fg-subtle font-mono text-xs">
          {rows.length} {rows.length === 1 ? 'ad' : 'ads'}
        </span>
      </div>

      <div className="overflow-x-auto rounded-sm border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ad</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right">Conv</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">CPC</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
              <TableHead>Launched</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group === 'none'
              ? rows.map((r) => <AdRow key={r.launchedAdId} r={r} />)
              : grouped?.map((g) => (
                  <React.Fragment key={g.label}>
                    <tr className="bg-bg-inset/60 border-b">
                      <td
                        colSpan={3}
                        className="text-fg-muted px-3 py-1.5 text-xs uppercase tracking-wider"
                      >
                        {g.label}{' '}
                        <span className="text-fg-subtle font-mono normal-case tracking-normal">
                          ({g.totals.count})
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">
                        ${g.totals.spend.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">{g.totals.conv}</td>
                      <td colSpan={4} />
                    </tr>
                    {g.items.map((r) => (
                      <AdRow key={r.launchedAdId} r={r} />
                    ))}
                  </React.Fragment>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function AdRow({ r }: { r: PerAdRow }) {
  const tone = roiTone({ spendUsd: r.totalSpendUsd, roas: r.impliedRoas });
  return (
    <TableRow className={cn(roiRowClass(tone))}>
      <TableCell>
        <div className="flex items-start gap-2">
          {r.imageUrl ? (
            <Link href={r.generationJobId ? `/runs/${r.generationJobId}` : '#'}>
              <img
                src={r.imageUrl}
                alt={r.headline ?? 'variant'}
                className="bg-bg-active h-9 w-9 rounded object-cover"
              />
            </Link>
          ) : (
            <div className="bg-bg-active h-9 w-9 rounded" />
          )}
          <p className="text-fg line-clamp-2 max-w-[16ch] text-xs font-medium">
            {r.headline ?? '(no headline)'}
          </p>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={adStatusBadgeVariant(r.status)}>{r.status.replace(/_/g, ' ')}</Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">${r.dailyBudgetUsd.toFixed(2)}</TableCell>
      <TableCell className="text-right font-mono text-xs">${r.totalSpendUsd.toFixed(2)}</TableCell>
      <TableCell className="text-right font-mono text-xs">{r.totalConversions}</TableCell>
      <TableCell className="text-right font-mono text-xs">{r.ctrPct.toFixed(2)}%</TableCell>
      <TableCell className="text-right font-mono text-xs">${r.cpcUsd.toFixed(2)}</TableCell>
      <TableCell className={cn('text-right font-mono text-xs', roiTextClass(tone))}>
        {r.totalSpendUsd > 0 ? `${r.impliedRoas.toFixed(2)}x` : '—'}
      </TableCell>
      <TableCell className="text-fg-muted font-mono text-xs">
        {formatDateTime(new Date(r.launchedAtIso))}
      </TableCell>
    </TableRow>
  );
}
