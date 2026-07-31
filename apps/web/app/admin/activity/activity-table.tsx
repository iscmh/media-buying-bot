'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Polish-25.7 Commit 44: admin activity table + filter chips.
 *
 * Client component because the filter chips and column sort are URL-
 * less local state — admins toggle them exploratorily, no need for
 * shareable state. If we later want bookmarkable filter/sort URLs,
 * push to searchParams.
 */

export interface SerializedActivityRow {
  userId: string;
  email: string;
  role: 'user' | 'admin';
  signupAt: string;
  isPaused: boolean;
  pauseReason: string | null;
  pauseCount: number;
  metaConnected: boolean;
  toolClaudeConnected: boolean;
  toolGeminiConnected: boolean;
  conceptsTotal: number;
  generationsTotal: number;
  generationsFailed7d: number;
  generationsSucceeded7d: number;
  launchedTotal: number;
  launchedActive: number;
  launchedRejected7d: number;
  lastActivityAt: string | null;
}

type Filter = 'all' | 'active_7d' | 'has_failed_gens' | 'is_paused' | 'connection_issue';
type SortKey = 'email' | 'signup' | 'concepts' | 'generations' | 'launched' | 'last_activity';
type SortDir = 'asc' | 'desc';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active_7d', label: 'Active in last 7d' },
  { value: 'has_failed_gens', label: 'Has failed generations' },
  { value: 'is_paused', label: 'Is paused' },
  { value: 'connection_issue', label: 'Connection issue' },
];

function withinSevenDays(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Date.now() - t < 7 * 24 * 60 * 60 * 1000;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const now = Date.now();
  const delta = now - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (delta < day) return `${Math.floor(delta / (60 * 60 * 1000))}h ago`;
  if (delta < 30 * day) return `${Math.floor(delta / day)}d ago`;
  return d.toISOString().slice(0, 10);
}

interface Props {
  rows: SerializedActivityRow[];
}

export function ActivityTable({ rows }: Props) {
  const [filter, setFilter] = React.useState<Filter>('all');
  const [sortKey, setSortKey] = React.useState<SortKey>('last_activity');
  const [sortDir, setSortDir] = React.useState<SortDir>('desc');

  const filtered = React.useMemo(() => {
    switch (filter) {
      case 'active_7d':
        return rows.filter((r) => withinSevenDays(r.lastActivityAt));
      case 'has_failed_gens':
        return rows.filter((r) => r.generationsFailed7d > 0);
      case 'is_paused':
        return rows.filter((r) => r.isPaused);
      case 'connection_issue':
        return rows.filter(
          (r) => !r.metaConnected || !r.toolClaudeConnected || !r.toolGeminiConnected,
        );
      default:
        return rows;
    }
  }, [rows, filter]);

  const sorted = React.useMemo(() => {
    const mult = sortDir === 'asc' ? 1 : -1;
    const sortValue = (r: SerializedActivityRow): number | string => {
      switch (sortKey) {
        case 'email':
          return r.email;
        case 'signup':
          return new Date(r.signupAt).getTime();
        case 'concepts':
          return r.conceptsTotal;
        case 'generations':
          return r.generationsTotal;
        case 'launched':
          return r.launchedTotal;
        case 'last_activity':
        default:
          return r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : 0;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = sortValue(a);
      const vb = sortValue(b);
      if (typeof va === 'string' && typeof vb === 'string') return mult * va.localeCompare(vb);
      return mult * ((va as number) - (vb as number));
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'inline-flex h-7 items-center rounded-sm border px-2 text-xs transition-colors',
              filter === f.value
                ? 'border-fg bg-bg-surface text-fg'
                : 'border-border text-fg-muted hover:bg-bg-surfaceHover hover:text-fg',
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="text-fg-subtle ml-auto flex items-center px-2 text-xs">
          {sorted.length} of {rows.length}
        </span>
      </div>

      <div className="border-border overflow-x-auto rounded-sm border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead
                label="Email"
                k="email"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHead
                label="Signed up"
                k="signup"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
              <TableHead>BYOK</TableHead>
              <TableHead>Meta</TableHead>
              <TableHead>Bot</TableHead>
              <SortHead
                label="Concepts"
                k="concepts"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHead
                label="Generations"
                k="generations"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHead
                label="Launched"
                k="launched"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
              <SortHead
                label="Last activity"
                k="last_activity"
                sortKey={sortKey}
                dir={sortDir}
                onClick={toggleSort}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-fg-muted py-6 text-center text-sm">
                  No users match this filter.
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell className="text-fg font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{r.email}</span>
                      {r.role === 'admin' && (
                        <Badge variant="outline" className="text-[10px]">
                          admin
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {fmtDate(r.signupAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <ChipYN yes={r.toolClaudeConnected} label="Claude" />
                      <ChipYN yes={r.toolGeminiConnected} label="Gemini" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={r.metaConnected ? 'success' : 'destructive'}
                      className="text-[10px]"
                    >
                      {r.metaConnected ? 'connected' : 'disconnected'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {r.isPaused ? (
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="destructive" className="text-[10px]">
                          paused
                        </Badge>
                        {r.pauseReason && (
                          <span className="text-fg-subtle font-mono text-[10px]">
                            {r.pauseReason}
                          </span>
                        )}
                      </div>
                    ) : (
                      <Badge variant="success" className="text-[10px]">
                        running
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-fg font-mono text-xs">
                    {r.conceptsTotal.toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-col leading-tight">
                      <span className="text-fg">{r.generationsTotal.toLocaleString()}</span>
                      <span className="text-fg-subtle text-[10px]">
                        7d ✓ {r.generationsSucceeded7d} · ✕{' '}
                        <span
                          className={cn(
                            r.generationsFailed7d > 0 && 'text-[color:var(--accent-negative)]',
                          )}
                        >
                          {r.generationsFailed7d}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-col leading-tight">
                      <span className="text-fg">{r.launchedTotal.toLocaleString()}</span>
                      <span className="text-fg-subtle text-[10px]">
                        active {r.launchedActive} · rej-7d{' '}
                        <span
                          className={cn(
                            r.launchedRejected7d > 0 && 'text-[color:var(--accent-negative)]',
                          )}
                        >
                          {r.launchedRejected7d}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {fmtDate(r.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SortHead({
  label,
  k,
  sortKey,
  dir,
  onClick,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={cn('hover:text-fg inline-flex items-center gap-1', active && 'text-fg')}
      >
        {label}
        {active && <span aria-hidden>{dir === 'desc' ? '↓' : '↑'}</span>}
      </button>
    </TableHead>
  );
}

function ChipYN({ yes, label }: { yes: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[10px]',
        yes
          ? 'border-[color:var(--accent-positive)]/40 text-[color:var(--accent-positive)]'
          : 'border-border text-fg-subtle',
      )}
    >
      {yes ? '✓' : '·'} {label}
    </span>
  );
}
