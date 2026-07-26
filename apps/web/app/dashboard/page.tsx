import Link from 'next/link';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { Rocket, Skull, Target, TrendingUp, Wallet } from 'lucide-react';
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
import { KpiTile } from '@/components/ui/kpi-tile';
import { TimeseriesChart, type TimeseriesPoint } from '@/components/ui/timeseries-chart';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AppShell } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/shell/empty-state';
import { PageHeader } from '@/components/shell/page-header';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { GettingStartedChecklist } from './_components/getting-started-checklist';
import { PauseBanner } from './_components/pause-banner';
import { PerAdTable } from './_components/per-ad-table';
import { TimeRangePicker } from './_components/time-range-picker';
import { BarChart3 } from 'lucide-react';

export const metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

const VALID_RANGES: TimeRange[] = ['24h', '7d', '30d', 'all'];
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
    firstConceptId: conceptRow?.id ?? null,
  };
  // Polish-25.5 Commit 28: the checklist flip used to key on
  // `metrics.totalSpendUsd === 0`, which was wrong: paused ads never
  // spend, and the recommended launch flow (per TOS) launches into
  // Paused. So an operator with 68 completed jobs and 27 launched ads
  // could stay stuck on the "Getting Started" checklist forever
  // because none of those ads had accumulated spend yet.
  //
  // The right predicate: has the user done ANY meaningful step? If a
  // concept exists, or a variant has been generated, or an ad has
  // been launched — they've proved they know the flow. Show them the
  // KPI grid (even if it renders all zeros) instead of the checklist.
  //
  // Genuinely fresh users (zero concepts, zero variants, zero ads)
  // still land on the checklist as before.
  const isFirstAdMode =
    !checklistState.hasConcept && !checklistState.hasGeneratedAd && !checklistState.hasLaunchedAd;

  const roasTone =
    metrics.impliedRoas == null
      ? 'neutral'
      : metrics.impliedRoas >= 2
        ? 'positive'
        : metrics.impliedRoas < 1
          ? 'negative'
          : 'neutral';

  // Polish-25.5 Commit 27: build recharts-friendly timeseries + tile
  // sparklines from the same daily-summary points.
  const chartData: TimeseriesPoint[] = metrics.timeSeries.map((p) => ({
    date: p.date,
    primary: p.spendUsd,
    secondary: p.conversions,
  }));
  const spendSpark = metrics.timeSeries.map((p) => ({ v: p.spendUsd }));
  const convSpark = metrics.timeSeries.map((p) => ({ v: p.conversions }));

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
        actions={
          isFoundingMember ? (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-block cursor-help">
                    <Badge variant="secondary">FOUNDING MEMBER</Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  You&apos;re one of the first 50 users. Ads Bot access stays free forever — no
                  subscription required.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : undefined
        }
      />

      {isFirstAdMode && <GettingStartedChecklist state={checklistState} />}

      {!isFirstAdMode && (
        <>
          {/* Polish-25.5 Commit 27: KpiTile grid replaces the old MetricCard
              strip. New tiles carry inline sparklines for metrics with time-
              series data (spend, conversions); tiles without a series render
              plain (ROAS, active/killed/scaled counts). Layout is 12-col
              friendly: 6 tiles across a wide screen (2 rows on tablet, 1 on
              mobile). CellFlash still wraps the numeric value so tick-updates
              flash green/red. */}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <KpiTile
              label="Total spend"
              value={`$${metrics.totalSpendUsd.toFixed(2)}`}
              numericValue={metrics.totalSpendUsd}
              icon={Wallet}
              spark={spendSpark}
              hint={`${metrics.totalImpressions.toLocaleString()} impr · ${metrics.totalClicks.toLocaleString()} clk`}
            />
            <KpiTile
              label="Conversions"
              value={metrics.totalConversions.toLocaleString()}
              numericValue={metrics.totalConversions}
              icon={Target}
              spark={convSpark}
              hint={
                metrics.avgCtrPct != null
                  ? `CTR ${metrics.avgCtrPct.toFixed(2)}% · CPC $${(metrics.avgCpcUsd ?? 0).toFixed(2)}`
                  : undefined
              }
            />
            <KpiTile
              label="Implied ROAS"
              value={metrics.impliedRoas != null ? `${metrics.impliedRoas.toFixed(2)}x` : '—'}
              numericValue={metrics.impliedRoas}
              icon={TrendingUp}
              tone={roasTone}
              hint="Heuristic — $20 assumed / conv"
            />
            <KpiTile
              label="Active ads"
              value={metrics.adsActiveCount.toString()}
              numericValue={metrics.adsActiveCount}
              icon={Rocket}
            />
            <KpiTile
              label="Killed (period)"
              value={metrics.adsKilledCount.toString()}
              numericValue={metrics.adsKilledCount}
              icon={Skull}
              tone={metrics.adsKilledCount > 0 ? 'negative' : 'neutral'}
            />
            <KpiTile
              label="Scaled (period)"
              value={metrics.adsScaledCount.toString()}
              numericValue={metrics.adsScaledCount}
              icon={TrendingUp}
              tone={metrics.adsScaledCount > 0 ? 'positive' : 'neutral'}
            />
          </div>

          <div className="mb-4">
            <TimeseriesChart
              data={chartData}
              primaryLabel="Spend"
              secondaryLabel="Conversions"
              primaryFormat={(v) => `$${v.toFixed(0)}`}
              height={220}
            />
          </div>

          <div className="mb-6">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-fg text-sm font-semibold uppercase tracking-wider">
                Per-ad performance
              </h2>
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
              <PerAdTable rows={perAd} />
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
