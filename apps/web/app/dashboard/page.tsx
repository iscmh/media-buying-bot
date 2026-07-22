import Link from 'next/link';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { BarChart3, Rocket, Skull, Target, TrendingUp, Wallet } from 'lucide-react';
import {
  getDashboardMetrics,
  getDb,
  getLatestPauseReason,
  getPerAdBreakdown,
  getUserTimezone,
  schema,
  type TimeRange,
} from '@mbb/db';
import { Badge } from '@/components/ui/badge';
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
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { GettingStartedChecklist } from './_components/getting-started-checklist';
import { MetricCard } from './_components/metric-card';
import { PauseBanner } from './_components/pause-banner';
import { SpendChart } from './_components/spend-chart';
import { TimeRangePicker } from './_components/time-range-picker';

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

const VALID_RANGES: TimeRange[] = ['24h', '7d', '30d', 'all'];

/**
 * Statuses that represent test / dead-end ads. Hidden from the
 * per-ad table by default so the dashboard reads as production-ish
 * even with mock-mode rows in the database.
 */
const TEST_STATUSES = new Set(['dry_run', 'rejected_by_meta', 'launch_failed']);

interface Props {
  searchParams: Promise<{ range?: string; show_test?: string }>;
}

export default async function DashboardPage({ searchParams }: Props) {
  const user = await requireOnboardingComplete();
  const { range: rangeParam, show_test: showTestParam } = await searchParams;
  const range: TimeRange = VALID_RANGES.includes(rangeParam as TimeRange)
    ? (rangeParam as TimeRange)
    : '7d';
  const showTest = showTestParam === '1';

  const db = getDb();
  const userRow = await db.query.users.findFirst({
    where: eq(schema.users.id, user.userId),
    columns: { isPaused: true },
  });
  const userSettingsRow = await db.query.userSettings.findFirst({
    where: eq(schema.userSettings.userId, user.userId),
    columns: { isFoundingMember: true },
  });
  const isFoundingMember = !!userSettingsRow?.isFoundingMember;

  const [pauseReason, userTimezone] = await Promise.all([
    userRow?.isPaused ? getLatestPauseReason(user.userId) : Promise.resolve(null),
    getUserTimezone(user.userId),
  ]);

  // Polish-25.1 Commit 10b: also compute the getting-started
  // checklist state so the dashboard can swap the metrics grid for
  // an empty-state task list when totalSpendUsd === 0. Cheap
  // queries — all limit(1) existence checks.
  //
  // Polish-25.2 Commit 11: dropped the MakeUGC ai_provider row
  // query. MakeUGC is now platform-managed under the "Instant UGC"
  // brand — Claude + Gemini are the only user-facing BYOK keys that
  // gate the "Connect your keys" step.
  const [metrics, perAdRaw, toolRows, conceptRow, generatedRow, launchedRow] = await Promise.all([
    getDashboardMetrics({ userId: user.userId, range, userTimezone }),
    getPerAdBreakdown({ userId: user.userId, range, userTimezone, sortBy: 'spend', limit: 50 }),
    db.query.toolConnections.findMany({
      where: and(
        eq(schema.toolConnections.userId, user.userId),
        eq(schema.toolConnections.status, 'active'),
        isNull(schema.toolConnections.deletedAt),
        inArray(schema.toolConnections.provider, ['claude', 'gemini']),
      ),
      columns: { provider: true },
    }),
    db.query.concepts.findFirst({
      where: and(eq(schema.concepts.userId, user.userId), isNull(schema.concepts.deletedAt)),
      columns: { id: true },
    }),
    db.query.generatedCreatives.findFirst({
      where: eq(schema.generatedCreatives.userId, user.userId),
      columns: { id: true },
    }),
    db.query.launchedAds.findFirst({
      where: and(
        eq(schema.launchedAds.userId, user.userId),
        ne(schema.launchedAds.status, 'launch_failed'),
      ),
      columns: { id: true },
    }),
  ]);

  const perAd = showTest ? perAdRaw : perAdRaw.filter((r) => !TEST_STATUSES.has(r.status));

  const toolProviders = new Set(toolRows.map((r) => r.provider));
  const checklistState = {
    keysConnected: toolProviders.has('claude') && toolProviders.has('gemini'),
    hasConcept: !!conceptRow,
    hasGeneratedAd: !!generatedRow,
    hasLaunchedAd: !!launchedRow,
  };
  // Empty-state mode when no launched-ad spend has landed yet. The
  // metrics grid + spend chart + per-ad table stay hidden until
  // there's real data to show. As soon as totalSpendUsd > 0 the
  // dashboard flips back to the full performance layout.
  const isFirstAdMode = metrics.totalSpendUsd === 0;

  const roasTone =
    metrics.impliedRoas == null
      ? 'neutral'
      : metrics.impliedRoas >= 2
        ? 'good'
        : metrics.impliedRoas < 1
          ? 'bad'
          : 'neutral';

  // Build show/hide test-ads link preserving the current range param.
  const toggleHref = `/dashboard?range=${range}&show_test=${showTest ? '0' : '1'}`;

  return (
    <AppShell crumbs={[{ label: 'Dashboard' }]} action={<TimeRangePicker current={range} />}>
      {pauseReason && (
        <PauseBanner
          reason={pauseReason.reason}
          pausedAt={pauseReason.pausedAt}
          openPauseCount={pauseReason.openPauseCount}
          pausedBy={pauseReason.pausedBy}
        />
      )}

      <PageHeader
        title="Dashboard"
        subtitle={`${user.email} · timezone ${userTimezone}`}
        actions={isFoundingMember ? <Badge variant="secondary">FOUNDING MEMBER</Badge> : undefined}
      />

      {/* Polish-25.1 Commit 10b: empty-state mode swaps the metrics
          grid + spend chart + per-ad table for a getting-started
          checklist. Users see actionable next steps instead of six
          $0 metric cards + an empty chart. Flips back automatically
          the moment totalSpendUsd > 0. */}
      {isFirstAdMode && <GettingStartedChecklist state={checklistState} />}

      {!isFirstAdMode && (
        <>
          {/* Metric cards — 3 columns on desktop, 2 on tablet, 1 on mobile. */}
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              label="Total spend"
              value={`$${metrics.totalSpendUsd.toFixed(2)}`}
              icon={Wallet}
              hint={`${metrics.totalImpressions.toLocaleString()} impressions · ${metrics.totalClicks.toLocaleString()} clicks`}
            />
            <MetricCard
              label="Conversions"
              value={metrics.totalConversions.toLocaleString()}
              icon={Target}
              hint={
                metrics.avgCtrPct != null
                  ? `CTR ${metrics.avgCtrPct.toFixed(2)}% · CPC $${(metrics.avgCpcUsd ?? 0).toFixed(2)}`
                  : '—'
              }
            />
            <MetricCard
              label="Implied ROAS"
              value={metrics.impliedRoas != null ? `${metrics.impliedRoas.toFixed(2)}x` : '—'}
              icon={TrendingUp}
              tone={roasTone}
              hint="Heuristic — $20 assumed per conv."
            />
            <MetricCard
              label="Active ads"
              value={metrics.adsActiveCount.toString()}
              icon={Rocket}
            />
            <MetricCard
              label="Killed (period)"
              value={metrics.adsKilledCount.toString()}
              icon={Skull}
              tone={metrics.adsKilledCount > 0 ? 'bad' : 'neutral'}
            />
            <MetricCard
              label="Scaled (period)"
              value={metrics.adsScaledCount.toString()}
              icon={TrendingUp}
              tone={metrics.adsScaledCount > 0 ? 'good' : 'neutral'}
            />
          </div>

          {/* Spend chart */}
          <div className="mb-6">
            <SpendChart data={metrics.timeSeries} />
          </div>

          {/* Per-ad breakdown */}
          <div className="mb-8">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-fg text-base font-semibold">Per-ad performance</h2>
              <div className="text-fg-muted flex items-center gap-3 text-xs">
                <Link
                  href={toggleHref}
                  className="hover:text-fg underline-offset-4 transition-colors hover:underline"
                >
                  {showTest ? 'Hide test ads' : 'Show test ads'}
                </Link>
                <Link
                  href="/launched"
                  className="hover:text-fg underline-offset-4 transition-colors hover:underline"
                >
                  View all
                </Link>
              </div>
            </div>
            {perAd.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title={showTest ? 'No ads in this window yet.' : 'No live ads in this window yet.'}
                description={
                  showTest
                    ? 'Generate variants and launch them to see performance numbers here.'
                    : 'Toggle "Show test ads" to include dry-run and rejected rows.'
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ad</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Budget</TableHead>
                      <TableHead>Spend</TableHead>
                      <TableHead>Conv</TableHead>
                      <TableHead>CTR</TableHead>
                      <TableHead>CPC</TableHead>
                      <TableHead>ROAS</TableHead>
                      <TableHead>Launched</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {perAd.map((r) => (
                      <TableRow key={r.launchedAdId}>
                        <TableCell>
                          <div className="flex items-start gap-2">
                            {r.imageUrl ? (
                              <Link href={`/runs/${r.generationJobId ?? ''}`}>
                                <img
                                  src={r.imageUrl}
                                  alt={r.headline ?? 'variant'}
                                  className="bg-bg-active h-10 w-10 rounded object-cover"
                                />
                              </Link>
                            ) : (
                              <div className="bg-bg-active h-10 w-10 rounded" />
                            )}
                            <p className="text-fg line-clamp-2 max-w-[16ch] text-xs font-medium">
                              {r.headline ?? '(no headline)'}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-fg-muted font-mono text-xs">
                          {r.status.replace(/_/g, ' ')}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          ${r.dailyBudgetUsd.toFixed(2)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          ${r.totalSpendUsd.toFixed(2)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.totalConversions}</TableCell>
                        <TableCell className="font-mono text-xs">{r.ctrPct.toFixed(2)}%</TableCell>
                        <TableCell className="font-mono text-xs">${r.cpcUsd.toFixed(2)}</TableCell>
                        <TableCell
                          className={
                            'font-mono text-xs ' +
                            (r.impliedRoas >= 2
                              ? 'text-success'
                              : r.impliedRoas < 1 && r.totalSpendUsd > 0
                                ? 'text-[color:var(--destructive-color)]'
                                : 'text-fg')
                          }
                        >
                          {r.totalSpendUsd > 0 ? `${r.impliedRoas.toFixed(2)}x` : '—'}
                        </TableCell>
                        <TableCell className="text-fg-muted font-mono text-xs">
                          {formatDateTime(new Date(r.launchedAtIso))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
