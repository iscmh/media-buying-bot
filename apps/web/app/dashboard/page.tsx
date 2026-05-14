import Link from 'next/link';
import { eq } from 'drizzle-orm';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format/date';
import { requireOnboardingComplete } from '@/lib/onboarding-gate';
import { MetricCard } from './_components/metric-card';
import { PauseBanner } from './_components/pause-banner';
import { SpendChart } from './_components/spend-chart';
import { TimeRangePicker } from './_components/time-range-picker';
import { getConnectionSummaries } from './_lib/connection-summaries';

export const metadata = { title: 'Dashboard — Media Buying Bot' };
export const dynamic = 'force-dynamic';

const VALID_RANGES: TimeRange[] = ['24h', '7d', '30d', 'all'];

interface Props {
  searchParams: Promise<{ range?: string }>;
}

export default async function DashboardPage({ searchParams }: Props) {
  const user = await requireOnboardingComplete();
  const { range: rangeParam } = await searchParams;
  const range: TimeRange = VALID_RANGES.includes(rangeParam as TimeRange)
    ? (rangeParam as TimeRange)
    : '7d';

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

  const [pauseReason, summaries, userTimezone] = await Promise.all([
    userRow?.isPaused ? getLatestPauseReason(user.userId) : Promise.resolve(null),
    getConnectionSummaries(user.userId),
    getUserTimezone(user.userId),
  ]);

  const [metrics, perAd] = await Promise.all([
    getDashboardMetrics({ userId: user.userId, range, userTimezone }),
    getPerAdBreakdown({ userId: user.userId, range, userTimezone, sortBy: 'spend', limit: 50 }),
  ]);

  const roasTone =
    metrics.impliedRoas == null
      ? 'neutral'
      : metrics.impliedRoas >= 2
        ? 'good'
        : metrics.impliedRoas < 1
          ? 'bad'
          : 'neutral';

  return (
    <main className="container mx-auto px-4 py-12">
      {pauseReason && (
        <PauseBanner
          reason={pauseReason.reason}
          pausedAt={pauseReason.pausedAt}
          openPauseCount={pauseReason.openPauseCount}
          pausedBy={pauseReason.pausedBy}
        />
      )}

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold">Dashboard</h1>
            {isFoundingMember && (
              <Badge variant="gold" title="Phase 7 founding-member tier — perks land in Phase 8.">
                ⭐ Founding Member
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {user.email} · timezone {userTimezone}
          </p>
        </div>
        <TimeRangePicker current={range} />
      </div>

      {/* Metric cards — 2×3 on desktop. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label="Total spend"
          value={`$${metrics.totalSpendUsd.toFixed(2)}`}
          emoji="💸"
          hint={`${metrics.totalImpressions.toLocaleString()} impressions · ${metrics.totalClicks.toLocaleString()} clicks`}
        />
        <MetricCard
          label="Conversions"
          value={metrics.totalConversions.toLocaleString()}
          emoji="🎯"
          hint={
            metrics.avgCtrPct != null
              ? `CTR ${metrics.avgCtrPct.toFixed(2)}% · CPC $${(metrics.avgCpcUsd ?? 0).toFixed(2)}`
              : '—'
          }
        />
        <MetricCard
          label="Implied ROAS"
          value={metrics.impliedRoas != null ? `${metrics.impliedRoas.toFixed(2)}x` : '—'}
          emoji={roasTone === 'good' ? '🟢' : roasTone === 'bad' ? '🔴' : '🟡'}
          tone={roasTone}
          hint="Heuristic — $20 assumed per conv. Phase 6+ wires real value."
        />
        <MetricCard label="Active ads" value={metrics.adsActiveCount.toString()} emoji="🟢" />
        <MetricCard
          label="Killed (period)"
          value={metrics.adsKilledCount.toString()}
          emoji="💀"
          tone={metrics.adsKilledCount > 0 ? 'bad' : 'neutral'}
        />
        <MetricCard
          label="Scaled (period)"
          value={metrics.adsScaledCount.toString()}
          emoji="📈"
          tone={metrics.adsScaledCount > 0 ? 'good' : 'neutral'}
        />
      </div>

      {/* Spend chart */}
      <div className="mb-6">
        <SpendChart data={metrics.timeSeries} />
      </div>

      {/* Per-ad breakdown */}
      <div className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Per-ad performance</h2>
          <Link
            href="/launched"
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            View full /launched →
          </Link>
        </div>
        {perAd.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              No launched ads in this window yet.
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
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
                          <Link href={`/jobs/${r.generationJobId ?? ''}`}>
                            <img
                              src={r.imageUrl}
                              alt={r.headline ?? 'variant'}
                              className="bg-muted h-10 w-10 rounded object-cover"
                            />
                          </Link>
                        ) : (
                          <div className="bg-muted h-10 w-10 rounded" />
                        )}
                        <p className="line-clamp-2 max-w-[16ch] text-xs font-medium">
                          {r.headline ?? '(no headline)'}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{r.status}</TableCell>
                    <TableCell className="text-xs">${r.dailyBudgetUsd.toFixed(2)}</TableCell>
                    <TableCell className="text-xs">${r.totalSpendUsd.toFixed(2)}</TableCell>
                    <TableCell className="text-xs">{r.totalConversions}</TableCell>
                    <TableCell className="text-xs">{r.ctrPct.toFixed(2)}%</TableCell>
                    <TableCell className="text-xs">${r.cpcUsd.toFixed(2)}</TableCell>
                    <TableCell
                      className={
                        'text-xs ' +
                        (r.impliedRoas >= 2
                          ? 'text-green-700'
                          : r.impliedRoas < 1 && r.totalSpendUsd > 0
                            ? 'text-destructive'
                            : '')
                      }
                    >
                      {r.totalSpendUsd > 0 ? `${r.impliedRoas.toFixed(2)}x` : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(new Date(r.launchedAtIso))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Quick links — was the original dashboard */}
      <h2 className="mb-3 text-lg font-semibold">Quick links</h2>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Link href="/connections/meta">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Meta connection</CardTitle>
              <CardDescription>Manage your Business Manager + ad accounts.</CardDescription>
            </CardHeader>
            <CardContent>
              {summaries.meta.connected ? (
                <p className="text-sm">
                  <span className="font-medium">Connected</span>{' '}
                  <span className="text-muted-foreground">
                    · BM …{summaries.meta.bmIdShort} · {summaries.meta.adAccountCount} ad account
                    {summaries.meta.adAccountCount === 1 ? '' : 's'}
                  </span>
                </p>
              ) : (
                <p className="text-destructive text-sm">Disconnected — reconnect →</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/connections/telegram">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Telegram bot</CardTitle>
              <CardDescription>Where you receive kill/scale alerts.</CardDescription>
            </CardHeader>
            <CardContent>
              {summaries.telegram.connected ? (
                <p className="text-sm">
                  <span className="font-medium">Linked</span>{' '}
                  {summaries.telegram.username && (
                    <span className="text-muted-foreground font-mono">
                      as @{summaries.telegram.username}
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-destructive text-sm">Disconnected — reconnect →</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/concepts">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Concepts</CardTitle>
              <CardDescription>Upload winning creatives.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Launch new variants →</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/launched">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Launched ads</CardTitle>
              <CardDescription>Full management table.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">All launches across all time →</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Settings</CardTitle>
              <CardDescription>Caps · kill/scale · daily summaries.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">Configure bot rules →</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </main>
  );
}
