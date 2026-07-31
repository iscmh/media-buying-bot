'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

export interface SerializedRecentRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  source: string;
  sourceName: string | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  breadcrumbs: Array<Record<string, unknown>>;
  severity: string;
  fingerprint: string | null;
  createdAt: string;
}

export interface SerializedGroupedRow {
  fingerprint: string;
  source: string;
  sourceName: string | null;
  sampleMessage: string;
  count: number;
  affectedUsers: number;
  firstSeen: string;
  lastSeen: string;
  severity: string;
}

const SOURCES = [
  'server_action',
  'api_route',
  'worker',
  'client_render',
  'client_boundary',
  'unhandled_promise',
] as const;

const RANGES = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
  { value: 'all', label: 'All time' },
] as const;

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function sourceBadgeVariant(source: string): 'destructive' | 'warning' | 'outline' | 'success' {
  if (source === 'worker' || source === 'unhandled_promise') return 'destructive';
  if (source === 'server_action' || source === 'api_route') return 'warning';
  if (source === 'client_render' || source === 'client_boundary') return 'outline';
  return 'outline';
}

interface Props {
  view: 'recent' | 'grouped';
  range: string;
  sources: string[];
  severity: string;
  userEmail: string;
  search: string;
  page: number;
  pageSize: number;
  recent: { rows: SerializedRecentRow[]; hasMore: boolean };
  grouped: { rows: SerializedGroupedRow[]; hasMore: boolean };
}

export function ErrorsClient(props: Props) {
  const router = useRouter();
  const [emailInput, setEmailInput] = React.useState(props.userEmail);
  const [searchInput, setSearchInput] = React.useState(props.search);

  function buildHref(overrides: Partial<Props>): string {
    const merged = { ...props, ...overrides };
    const p = new URLSearchParams();
    if (merged.view !== 'recent') p.set('view', merged.view);
    if (merged.range !== '24h') p.set('range', merged.range);
    if (merged.sources.length > 0) p.set('sources', merged.sources.join(','));
    if (merged.severity) p.set('severity', merged.severity);
    if (merged.userEmail) p.set('email', merged.userEmail);
    if (merged.search) p.set('q', merged.search);
    if (merged.page && merged.page > 1) p.set('page', String(merged.page));
    const qs = p.toString();
    return qs ? `/admin/errors?${qs}` : '/admin/errors';
  }

  function toggleSource(src: string) {
    const next = props.sources.includes(src)
      ? props.sources.filter((s) => s !== src)
      : [...props.sources, src];
    router.push(buildHref({ sources: next, page: 1 }));
  }

  function applySearch(e: React.FormEvent) {
    e.preventDefault();
    router.push(buildHref({ userEmail: emailInput, search: searchInput, page: 1 }));
  }

  return (
    <div className="space-y-4">
      {/* View toggle + refresh */}
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          <Link
            href={buildHref({ view: 'recent', page: 1 })}
            className={cn(
              'inline-flex h-7 items-center rounded-sm border px-2.5 text-xs',
              props.view === 'recent'
                ? 'border-fg bg-bg-surface text-fg'
                : 'border-border text-fg-muted hover:bg-bg-surfaceHover',
            )}
          >
            Recent
          </Link>
          <Link
            href={buildHref({ view: 'grouped', page: 1 })}
            className={cn(
              'inline-flex h-7 items-center rounded-sm border px-2.5 text-xs',
              props.view === 'grouped'
                ? 'border-fg bg-bg-surface text-fg'
                : 'border-border text-fg-muted hover:bg-bg-surfaceHover',
            )}
          >
            Grouped
          </Link>
        </div>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={() => router.refresh()}
            className="border-border text-fg-muted hover:bg-bg-surfaceHover inline-flex h-7 items-center rounded-sm border px-2.5 text-xs"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <Link
              key={r.value}
              href={buildHref({ range: r.value, page: 1 })}
              className={cn(
                'inline-flex h-6 items-center rounded-sm border px-2 text-[11px]',
                props.range === r.value
                  ? 'border-fg bg-bg-surface text-fg'
                  : 'border-border text-fg-muted hover:bg-bg-surfaceHover',
              )}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => toggleSource(s)}
              className={cn(
                'inline-flex h-6 items-center rounded-sm border px-2 font-mono text-[10px]',
                props.sources.includes(s)
                  ? 'border-fg bg-bg-surface text-fg'
                  : 'border-border text-fg-muted hover:bg-bg-surfaceHover',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={applySearch}>
          <input
            type="text"
            placeholder="filter by user email…"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            className="border-border bg-bg text-fg h-7 flex-1 rounded-sm border px-2 text-xs"
          />
          <input
            type="text"
            placeholder="search message text…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="border-border bg-bg text-fg h-7 flex-1 rounded-sm border px-2 text-xs"
          />
          <button
            type="submit"
            className="border-fg/40 text-fg hover:bg-bg-surfaceHover inline-flex h-7 items-center rounded-sm border px-2.5 text-xs"
          >
            Apply
          </button>
        </form>
      </div>

      {/* Table */}
      {props.view === 'recent' ? (
        <RecentTable rows={props.recent.rows} />
      ) : (
        <GroupedTable rows={props.grouped.rows} />
      )}

      {/* Pagination */}
      {(props.page > 1 ||
        (props.view === 'recent' ? props.recent.hasMore : props.grouped.hasMore)) && (
        <nav className="flex items-center justify-between text-sm">
          {props.page > 1 ? (
            <Link
              href={buildHref({ page: props.page - 1 })}
              className="text-fg-muted hover:text-fg underline-offset-4 hover:underline"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-fg-subtle font-mono text-xs">Page {props.page}</span>
          {(props.view === 'recent' ? props.recent.hasMore : props.grouped.hasMore) ? (
            <Link
              href={buildHref({ page: props.page + 1 })}
              className="text-fg-muted hover:text-fg underline-offset-4 hover:underline"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}

function RecentTable({ rows }: { rows: SerializedRecentRow[] }) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }
  if (rows.length === 0) {
    return (
      <div className="border-border text-fg-muted rounded-sm border p-6 text-center text-sm">
        No errors match this filter.
      </div>
    );
  }
  return (
    <div className="border-border overflow-x-auto rounded-sm border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Message</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const isOpen = expanded.has(r.id);
            return (
              <React.Fragment key={r.id}>
                <TableRow>
                  <TableCell className="text-fg-muted font-mono text-xs" title={r.createdAt}>
                    {fmtRelative(r.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <Badge variant={sourceBadgeVariant(r.source)} className="text-[10px]">
                        {r.source}
                      </Badge>
                      {r.sourceName && (
                        <span className="text-fg-subtle font-mono text-[10px]">{r.sourceName}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-fg-muted font-mono text-xs">
                    {r.userEmail ?? <span className="text-fg-subtle">anonymous</span>}
                  </TableCell>
                  <TableCell className="max-w-md">
                    <p className="text-fg truncate text-xs">{r.message}</p>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      className="text-fg-muted hover:text-fg text-xs underline-offset-4 hover:underline"
                    >
                      {isOpen ? 'Hide' : 'Details'}
                    </button>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-bg-inset p-4">
                      <div className="grid gap-3 text-xs">
                        <FullMessage message={r.message} />
                        {r.stack && (
                          <details>
                            <summary className="text-fg-muted cursor-pointer">Stack</summary>
                            <pre className="text-fg-muted mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                              {r.stack}
                            </pre>
                          </details>
                        )}
                        {Object.keys(r.context ?? {}).length > 0 && (
                          <details>
                            <summary className="text-fg-muted cursor-pointer">Context</summary>
                            <pre className="text-fg-muted mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                              {JSON.stringify(r.context, null, 2)}
                            </pre>
                          </details>
                        )}
                        {r.breadcrumbs.length > 0 && (
                          <details>
                            <summary className="text-fg-muted cursor-pointer">
                              Breadcrumbs ({r.breadcrumbs.length})
                            </summary>
                            <pre className="text-fg-muted mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                              {JSON.stringify(r.breadcrumbs, null, 2)}
                            </pre>
                          </details>
                        )}
                        {r.fingerprint && (
                          <p className="text-fg-subtle font-mono text-[10px]">
                            fingerprint: {r.fingerprint}
                          </p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function GroupedTable({ rows }: { rows: SerializedGroupedRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-border text-fg-muted rounded-sm border p-6 text-center text-sm">
        No error groups match this filter.
      </div>
    );
  }
  return (
    <div className="border-border overflow-x-auto rounded-sm border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Count</TableHead>
            <TableHead>Users</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead>Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.fingerprint}>
              <TableCell className="text-fg font-mono text-xs">{r.count}</TableCell>
              <TableCell className="text-fg-muted font-mono text-xs">{r.affectedUsers}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <Badge variant={sourceBadgeVariant(r.source)} className="text-[10px]">
                    {r.source}
                  </Badge>
                  {r.sourceName && (
                    <span className="text-fg-subtle font-mono text-[10px]">{r.sourceName}</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="max-w-md">
                <p className="text-fg truncate text-xs">{r.sampleMessage}</p>
              </TableCell>
              <TableCell className="text-fg-muted font-mono text-xs" title={r.firstSeen}>
                {fmtRelative(r.firstSeen)}
              </TableCell>
              <TableCell className="text-fg-muted font-mono text-xs" title={r.lastSeen}>
                {fmtRelative(r.lastSeen)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FullMessage({ message }: { message: string }) {
  return (
    <div>
      <p className="text-fg-muted mb-1 text-[10px] uppercase tracking-wider">Message</p>
      <pre className="text-fg max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
        {message}
      </pre>
    </div>
  );
}
