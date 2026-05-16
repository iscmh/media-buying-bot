import Link from 'next/link';
import { and, desc, eq, inArray, not } from 'drizzle-orm';
import { Rocket } from 'lucide-react';
import { getDb, schema } from '@mbb/db';
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
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';

export const metadata = { title: 'Launched ads' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/**
 * Statuses considered "test data" — hidden from the table by default so
 * the launched view reads as production-ish. Toggle via ?show_test=1.
 */
const TEST_STATUSES = ['dry_run', 'rejected_by_meta', 'launch_failed'] satisfies Array<
  'dry_run' | 'rejected_by_meta' | 'launch_failed' | 'active' | 'killed' | 'paused'
>;

interface Props {
  searchParams: Promise<{ page?: string; show_test?: string }>;
}

export default async function LaunchedAdsPage({ searchParams }: Props) {
  const { userId } = await requireOnboardingComplete();
  const { page: pageParam, show_test: showTestParam } = await searchParams;
  const page = Math.max(1, Number(pageParam ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const showTest = showTestParam === '1';

  const db = getDb();
  const rows = await db.query.launchedAds.findMany({
    where: showTest
      ? eq(schema.launchedAds.userId, userId)
      : and(
          eq(schema.launchedAds.userId, userId),
          not(inArray(schema.launchedAds.status, TEST_STATUSES)),
        ),
    orderBy: desc(schema.launchedAds.launchedAt),
    limit: PAGE_SIZE + 1,
    offset,
  });

  const hasNextPage = rows.length > PAGE_SIZE;
  const visible = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;

  // Fetch variant copy + thumbnail for each row in one query.
  const creativeIds = visible.map((r) => r.generatedCreativeId);
  const creatives =
    creativeIds.length > 0
      ? await db.query.generatedCreatives.findMany({
          where: (tbl, { inArray }) => inArray(tbl.id, creativeIds),
          columns: { id: true, fileUrl: true, headline: true, primaryText: true },
        })
      : [];
  const creativeById = new Map(creatives.map((c) => [c.id, c]));

  const toggleHref = `/launched?show_test=${showTest ? '0' : '1'}`;

  return (
    <AppShell crumbs={[{ label: 'Launched ads' }]}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-fg text-2xl font-semibold tracking-tight">Launched ads</h1>
          <p className="text-fg-muted mt-1 text-sm">
            Every ad the bot has pushed to Meta.{' '}
            {!showTest && (
              <span>
                Test rows (dry-run, rejected, failed) hidden by default.{' '}
                <Link href={toggleHref} className="hover:text-fg underline transition-colors">
                  Show
                </Link>
                .
              </span>
            )}
            {showTest && (
              <span>
                Showing test rows.{' '}
                <Link href={toggleHref} className="hover:text-fg underline transition-colors">
                  Hide
                </Link>
                .
              </span>
            )}
          </p>
        </div>
      </header>

      {visible.length === 0 ? (
        <EmptyState
          icon={Rocket}
          title={showTest ? 'No launches yet.' : 'No live ads launched yet.'}
          description={
            showTest
              ? 'Approve variants on a generation job, then launch them to see rows here.'
              : 'Approve and launch variants to see them here. Test rows are hidden — toggle "Show" above to include them.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead>Meta IDs</TableHead>
                <TableHead>Daily budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Impr / CTR</TableHead>
                <TableHead>Clicks / CPC</TableHead>
                <TableHead>Conv</TableHead>
                <TableHead>Launched</TableHead>
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
                const displayStatus = computeDisplayStatus(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-start gap-3">
                        {creative?.fileUrl ? (
                          <Link href={`/jobs/${row.generationJobId ?? ''}`}>
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
                      <Badge variant={statusVariant(displayStatus)}>
                        {displayStatus.replace(/_/g, ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
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
                    <TableCell className="font-mono text-xs">{conversions ?? '—'}</TableCell>
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

      {(page > 1 || hasNextPage) && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link
              href={`/launched?page=${page - 1}${showTest ? '&show_test=1' : ''}`}
              className="text-fg-muted hover:text-fg underline-offset-4 transition-colors hover:underline"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-fg-subtle font-mono text-xs">Page {page}</span>
          {hasNextPage ? (
            <Link
              href={`/launched?page=${page + 1}${showTest ? '&show_test=1' : ''}`}
              className="text-fg-muted hover:text-fg underline-offset-4 transition-colors hover:underline"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </AppShell>
  );
}

/**
 * Phase 5: collapse the raw launched_ads.status + recommendation
 * timestamps into one display label. Precedence (highest wins):
 *   killed > kill_recommended > scale_recommended > paused > active > dry_run > *
 */
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
