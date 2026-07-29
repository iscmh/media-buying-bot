import Link from 'next/link';
import { and, desc, eq, inArray, not } from 'drizzle-orm';
import { ArrowDown, ArrowUp, Rocket } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
import { ASSUMED_CONVERSION_VALUE_USD } from '@mbb/shared';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AppShell } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';
import { roiTone, roiRowClass, roiTextClass } from '@/components/ui/roi-tone';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { cn } from '@/lib/utils';
import { ApprovalButtons } from './_components/approval-buttons';
import { MetaRejectionGuidance } from './_components/meta-rejection-guidance';

export const metadata = { title: 'Launched ads' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// Polish-25.7 Commit 42: `archived` is a user-initiated hide action
// (operator explicitly killed the row from the UI), so it stays out of
// the default view. Everything else — dry_run, rejected_by_meta,
// launch_failed, active, paused, killed — surfaces by default. No
// user-facing toggle: the "Show test ads" flow was UI noise with zero
// value for beta operators.
const HIDDEN_STATUSES = ['archived'] satisfies Array<
  'dry_run' | 'rejected_by_meta' | 'launch_failed' | 'archived' | 'active' | 'killed' | 'paused'
>;

type SortKey = 'launched' | 'spend' | 'roas' | 'conv';
type SortDir = 'asc' | 'desc';
type StatusFilter =
  | 'all'
  | 'active'
  | 'paused'
  | 'killed'
  | 'kill_recommended'
  | 'scale_recommended';

const VALID_SORTS: readonly SortKey[] = ['launched', 'spend', 'roas', 'conv'];
const VALID_STATUS: readonly StatusFilter[] = [
  'all',
  'active',
  'paused',
  'killed',
  'kill_recommended',
  'scale_recommended',
];

interface Props {
  searchParams: Promise<{
    page?: string;
    sort?: string;
    dir?: string;
    status?: string;
  }>;
}

/**
 * Polish-25.6 Commit 34: launched ads table upgrade.
 *
 * Additions from the launch-blocker audit (Commit 33 §7 item 4):
 *
 *   - ROAS column: (conversions × ASSUMED_CONVERSION_VALUE_USD) / spend.
 *     Dashboard already had it; parity here so the buyer's #1 question
 *     ("which ads are winning") is answerable from this page.
 *   - Sortable column headers via ?sort=&dir= (URL-driven so the state
 *     is bookmarkable + shareable).
 *   - Status filter dropdown via ?status=. Adds "kill_recommended" and
 *     "scale_recommended" as first-class filters so pending-review rows
 *     surface quickly.
 *   - Row-level ROI shading via `roiRowClass` — same primitive dashboard
 *     uses.
 *   - Inline Approve/Skip buttons on rows with kill_recommended_at or
 *     scale_recommended_at (client component `ApprovalButtons`). This
 *     is the MVP replacement for the Telegram approval flow deprecated
 *     in this same commit — buyers can now approve kill/scale
 *     recommendations without the Telegram bot.
 *
 * Sort is in-memory over the fetched window (up to PAGE_SIZE+1). For
 * a $500/day operator with a few hundred launched ads this is fine;
 * scaling past a thousand rows will want SQL-side sort.
 */
export default async function LaunchedAdsPage({ searchParams }: Props) {
  const { userId } = await requireOnboardingComplete();
  const { page: pageParam, sort, dir, status } = await searchParams;
  const pageNum = Math.max(1, Number(pageParam ?? '1') || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;
  const sortKey: SortKey = VALID_SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'launched';
  const sortDir: SortDir = dir === 'asc' ? 'asc' : 'desc';
  const statusFilter: StatusFilter = VALID_STATUS.includes(status as StatusFilter)
    ? (status as StatusFilter)
    : 'all';

  const db = getDb();

  // Polish-25.7 Commit 39: fetch the user's per-conversion assumed
  // value so the ROAS fallback uses their configured $/conv rather
  // than the hardcoded default. Real conversion_value_usd from Meta
  // insights is preferred when present (see computeRoas below).
  const settingsRow = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, userId),
    columns: { assumedConversionValueUsd: true },
  });
  const assumedValue = settingsRow?.assumedConversionValueUsd
    ? Number(settingsRow.assumedConversionValueUsd)
    : ASSUMED_CONVERSION_VALUE_USD;

  // Base where: user's own ads, minus silently-hidden statuses
  // (archived rows the operator killed from the UI).
  const baseWhere = and(
    eq(schema.launchedAds.userId, userId),
    not(inArray(schema.launchedAds.status, HIDDEN_STATUSES)),
  );

  const rowsUnfiltered = await db.query.launchedAds.findMany({
    where: baseWhere,
    orderBy: desc(schema.launchedAds.launchedAt),
    limit: 500, // pull a bigger window when we're sorting/filtering client-side
  });

  // Apply recommendation-status filter (kill_recommended /
  // scale_recommended are computed from the timestamp columns, not
  // stored as launched_ads.status values).
  const rowsFiltered = rowsUnfiltered.filter((r) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'kill_recommended')
      return r.killRecommendedAt != null && r.status !== 'killed';
    if (statusFilter === 'scale_recommended') return r.scaleRecommendedAt != null;
    return r.status === statusFilter;
  });

  // In-memory sort.
  const sortMultiplier = sortDir === 'asc' ? 1 : -1;
  const rowsSorted = [...rowsFiltered].sort((a, b) => {
    switch (sortKey) {
      case 'spend':
        return sortMultiplier * (Number(a.metaSpendUsd ?? 0) - Number(b.metaSpendUsd ?? 0));
      case 'roas': {
        const roasA = computeRoas(a, assumedValue).value;
        const roasB = computeRoas(b, assumedValue).value;
        return sortMultiplier * (roasA - roasB);
      }
      case 'conv':
        return sortMultiplier * ((a.metaConversions ?? 0) - (b.metaConversions ?? 0));
      case 'launched':
      default: {
        const ta = a.launchedAt?.getTime() ?? 0;
        const tb = b.launchedAt?.getTime() ?? 0;
        return sortMultiplier * (ta - tb);
      }
    }
  });

  const pageSlice = rowsSorted.slice(offset, offset + PAGE_SIZE + 1);
  const hasNextPage = pageSlice.length > PAGE_SIZE;
  const visible = hasNextPage ? pageSlice.slice(0, PAGE_SIZE) : pageSlice;

  // Fetch variant copy + thumbnail for each visible row.
  const creativeIds = visible.map((r) => r.generatedCreativeId);
  const creatives =
    creativeIds.length > 0
      ? await db.query.generatedCreatives.findMany({
          where: (tbl, { inArray }) => inArray(tbl.id, creativeIds),
          columns: { id: true, fileUrl: true, headline: true, primaryText: true },
        })
      : [];
  const creativeById = new Map(creatives.map((c) => [c.id, c]));

  return (
    <AppShell crumbs={[{ label: 'Launched ads' }]}>
      <PageHeader title="Launched ads" subtitle="Every ad the bot has pushed to Meta." />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-subtle font-mono uppercase tracking-wider">Status</span>
          <StatusFilterDropdown current={statusFilter} sortKey={sortKey} sortDir={sortDir} />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title={
            statusFilter === 'all'
              ? 'No launches yet.'
              : `No ads matching "${statusFilter.replace(/_/g, ' ')}".`
          }
          description={
            statusFilter === 'all'
              ? 'Approve variants on a generation job, then launch them to see rows here.'
              : 'Try clearing the status filter above.'
          }
        />
      ) : (
        <div className="border-border overflow-x-auto rounded-sm border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>Meta IDs</TableHead>
                <TableHead>Budget</TableHead>
                <TableHead>Status</TableHead>
                <SortableHead
                  label="Spend"
                  columnKey="spend"
                  currentSort={sortKey}
                  currentDir={sortDir}
                  statusFilter={statusFilter}
                />
                <TableHead>Impr / CTR</TableHead>
                <TableHead>Clicks / CPC</TableHead>
                <SortableHead
                  label="Conv"
                  columnKey="conv"
                  currentSort={sortKey}
                  currentDir={sortDir}
                  statusFilter={statusFilter}
                />
                <SortableHead
                  label="ROAS"
                  columnKey="roas"
                  currentSort={sortKey}
                  currentDir={sortDir}
                  statusFilter={statusFilter}
                />
                <SortableHead
                  label="Launched"
                  columnKey="launched"
                  currentSort={sortKey}
                  currentDir={sortDir}
                  statusFilter={statusFilter}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const creative = creativeById.get(row.generatedCreativeId);
                const spend = row.metaSpendUsd != null ? Number(row.metaSpendUsd) : null;
                const impressions = row.metaImpressions ?? null;
                const clicks = row.metaClicks ?? null;
                const conversions = row.metaConversions ?? null;
                const ctrPct =
                  impressions && impressions > 0 && clicks != null
                    ? (clicks / impressions) * 100
                    : null;
                const cpc = clicks && clicks > 0 && spend != null ? spend / clicks : null;
                const roasResult = computeRoas(row, assumedValue);
                const roas = roasResult.value;
                const roasIsEstimate = roasResult.isEstimate;
                const tone = roiTone({ spendUsd: spend ?? 0, roas });
                const displayStatus = computeDisplayStatus(row);
                const isKillReco = row.killRecommendedAt != null && row.status !== 'killed';
                const isScaleReco = row.scaleRecommendedAt != null;

                return (
                  <TableRow key={row.id} className={cn(roiRowClass(tone))}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        {creative?.fileUrl ? (
                          <Link href={`/runs/${row.generationJobId ?? ''}`}>
                            <img
                              src={creative.fileUrl}
                              alt={creative.headline ?? 'variant'}
                              className="bg-bg-active h-14 w-14 rounded object-cover"
                            />
                          </Link>
                        ) : (
                          <div className="bg-bg-active h-14 w-14 rounded" />
                        )}
                        <div className="min-w-0">
                          <p className="text-fg truncate text-sm font-medium">
                            {creative?.headline ?? '(no headline)'}
                          </p>
                          <p className="text-fg-muted line-clamp-2 text-xs">
                            {creative?.primaryText ?? ''}
                          </p>
                          {row.scaleCount > 0 && (
                            <p className="text-fg-muted text-xs">Scaled {row.scaleCount}×</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="space-y-0.5">
                        <p>
                          <span className="text-fg-subtle">camp:</span>{' '}
                          <span className="text-fg-muted">
                            {truncateMiddle(row.metaCampaignId ?? '—', 14)}
                          </span>
                        </p>
                        <p>
                          <span className="text-fg-subtle">ad:</span>{' '}
                          <span className="text-fg-muted">
                            {truncateMiddle(row.metaAdId ?? '—', 14)}
                          </span>
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${Number(row.dailyBudgetUsd).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant={statusVariant(displayStatus)}>
                          {displayStatus.replace(/_/g, ' ')}
                        </Badge>
                        {(displayStatus === 'rejected_by_meta' ||
                          displayStatus === 'launch_failed') &&
                          row.errorMessage && (
                            <>
                              <p className="text-fg-muted mt-1 font-mono text-xs leading-snug">
                                {row.errorMessage}
                              </p>
                              {/* Polish-25.6 Commit 38: pattern-match the raw Meta
                                  error and render actionable guidance. Turns
                                  cryptic Special Ad Category messages ("add a
                                  higher minimum age") into a real fix list +
                                  Meta docs link. */}
                              <MetaRejectionGuidance errorMessage={row.errorMessage} />
                            </>
                          )}
                        {(isKillReco || isScaleReco) && (
                          <ApprovalButtons
                            launchedAdId={row.id}
                            kind={isKillReco ? 'kill' : 'scale'}
                            scaleFrom={isScaleReco ? Number(row.dailyBudgetUsd) : null}
                            scaleTo={
                              isScaleReco && row.scaleRecommendedToUsd != null
                                ? Number(row.scaleRecommendedToUsd)
                                : null
                            }
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {spend != null ? `$${spend.toFixed(2)}` : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {impressions != null
                        ? `${impressions.toLocaleString()} / ${ctrPct != null ? `${ctrPct.toFixed(2)}%` : '—'}`
                        : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {clicks != null
                        ? `${clicks.toLocaleString()} / ${cpc != null ? `$${cpc.toFixed(2)}` : '—'}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {conversions ?? '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono text-xs',
                        roiTextClass(tone),
                        roasIsEstimate && 'italic',
                      )}
                      title={
                        spend != null && spend > 0
                          ? roasIsEstimate
                            ? `Estimated at $${assumedValue.toFixed(0)}/conv. Meta pixel not sending purchase values.`
                            : 'From Meta insights (real purchase values).'
                          : undefined
                      }
                    >
                      {spend != null && spend > 0 ? `${roas.toFixed(2)}x` : '—'}
                      {spend != null && spend > 0 && roasIsEstimate && (
                        <span className="text-fg-subtle ml-0.5" aria-hidden>
                          *
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-fg-muted font-mono text-xs">
                      {formatDateTime(row.launchedAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {(pageNum > 1 || hasNextPage) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {pageNum > 1 ? (
            <Link
              href={buildHref({
                status: statusFilter,
                sort: sortKey,
                dir: sortDir,
                page: pageNum - 1,
              })}
              className="text-fg-muted hover:text-fg underline-offset-4 transition-colors hover:underline"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-fg-subtle font-mono text-xs">Page {pageNum}</span>
          {hasNextPage ? (
            <Link
              href={buildHref({
                status: statusFilter,
                sort: sortKey,
                dir: sortDir,
                page: pageNum + 1,
              })}
              className="text-fg-muted hover:text-fg underline-offset-4 transition-colors hover:underline"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      <p className="text-fg-subtle mt-6 text-xs">
        ROAS marked with <span aria-hidden>*</span> (italic) is estimated at $
        {assumedValue.toFixed(0)}
        /conversion — Meta pixel isn&apos;t sending purchase values for those ads. Non-italic ROAS
        comes from Meta&apos;s real action_values. Change your assumed value in{' '}
        <a
          href="/settings"
          className="text-fg-muted hover:text-fg underline-offset-4 hover:underline"
        >
          Settings
        </a>
        .
      </p>
    </AppShell>
  );
}

/**
 * Polish-25.7 Commit 39: prefer real conversion_value_usd from Meta
 * insights (populated by poll-ad-performance from action_values).
 * Fall back to `conversions × assumedValue` when Meta returned zero
 * value data (pixel not configured to send purchase values yet).
 * `isEstimate` flag lets the row renderer italicize + tooltip-flag
 * the fallback variant so buyers know it's a heuristic, not
 * Meta-reported revenue.
 */
function computeRoas(
  row: {
    metaSpendUsd: string | null;
    metaConversions: number | null;
    conversionValueUsd: string | null;
  },
  assumedValue: number,
): { value: number; isEstimate: boolean } {
  const spend = row.metaSpendUsd != null ? Number(row.metaSpendUsd) : 0;
  const conv = row.metaConversions ?? 0;
  const value = row.conversionValueUsd != null ? Number(row.conversionValueUsd) : 0;
  if (spend <= 0) return { value: 0, isEstimate: false };
  if (value > 0) return { value: value / spend, isEstimate: false };
  if (conv > 0) return { value: (conv * assumedValue) / spend, isEstimate: true };
  return { value: 0, isEstimate: false };
}

function computeDisplayStatus(row: {
  status: string;
  killRecommendedAt: Date | null;
  scaleRecommendedAt: Date | null;
}): string {
  if (row.status === 'killed') return 'killed';
  if (row.killRecommendedAt) return 'kill_recommended';
  if (row.scaleRecommendedAt) return 'scale_recommended';
  return row.status;
}

function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
    case 'scaled':
      return 'success';
    case 'killed':
    case 'rejected_by_meta':
    case 'launch_failed':
      return 'destructive';
    case 'kill_recommended':
    case 'paused':
    case 'awaiting_approval':
      return 'warning';
    case 'scale_recommended':
      return 'outline';
    default:
      return 'outline';
  }
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max / 2) - 1;
  const tail = Math.floor(max / 2) - 2;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function buildHref(input: {
  status: StatusFilter;
  sort: SortKey;
  dir: SortDir;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (input.status !== 'all') params.set('status', input.status);
  if (input.sort !== 'launched') params.set('sort', input.sort);
  if (input.dir !== 'desc') params.set('dir', input.dir);
  if (input.page && input.page > 1) params.set('page', String(input.page));
  const qs = params.toString();
  return qs ? `/launched?${qs}` : '/launched';
}

function StatusFilterDropdown({
  current,
  sortKey,
  sortDir,
}: {
  current: StatusFilter;
  sortKey: SortKey;
  sortDir: SortDir;
}) {
  const options: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'paused', label: 'Paused' },
    { value: 'killed', label: 'Killed' },
    { value: 'kill_recommended', label: 'Kill recommended' },
    { value: 'scale_recommended', label: 'Scale recommended' },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const isActive = current === o.value;
        return (
          <Link
            key={o.value}
            href={buildHref({ status: o.value, sort: sortKey, dir: sortDir })}
            className={cn(
              'inline-flex h-7 items-center rounded-sm border px-2 text-xs transition-colors',
              isActive
                ? 'border-fg bg-bg-surface text-fg'
                : 'border-border text-fg-muted hover:bg-bg-surfaceHover hover:text-fg',
            )}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

function SortableHead({
  label,
  columnKey,
  currentSort,
  currentDir,
  statusFilter,
}: {
  label: string;
  columnKey: SortKey;
  currentSort: SortKey;
  currentDir: SortDir;
  statusFilter: StatusFilter;
}) {
  const isActive = currentSort === columnKey;
  const nextDir: SortDir = isActive && currentDir === 'desc' ? 'asc' : 'desc';
  const href = buildHref({ status: statusFilter, sort: columnKey, dir: nextDir });
  return (
    <TableHead className="text-right">
      <Link
        href={href}
        className={cn('hover:text-fg inline-flex items-center gap-1', isActive && 'text-fg')}
      >
        {label}
        {isActive &&
          (currentDir === 'desc' ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          ))}
      </Link>
    </TableHead>
  );
}
