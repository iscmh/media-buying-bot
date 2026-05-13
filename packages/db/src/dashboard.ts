import { and, asc, count, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { ASSUMED_CONVERSION_VALUE_USD } from '@mbb/shared';
import { getDb } from './client';
import { generatedCreatives } from './schema/generation';
import { launchedAds } from './schema/launched-ads';
import { dailySummaries } from './schema/performance';
import { users } from './schema/users';

/**
 * Phase 6 P&L dashboard aggregations. Two read paths:
 *
 *   getDashboardMetrics — top-of-page metric cards + the spend / conv
 *                          time-series chart. Time-window scope is
 *                          enforced via launched_ads.launched_at, and
 *                          the time series itself pulls from
 *                          daily_summaries (one row per local-day) so
 *                          we get a real history once the cron has
 *                          been running a few days.
 *
 *   getPerAdBreakdown   — the per-ad table below the cards. Joins
 *                          launched_ads → generated_creatives so each
 *                          row carries the AI-generated headline.
 *
 * Honest tradeoff worth flagging: launched_ads.meta_spend_usd is the
 * CUMULATIVE spend Meta reported at the latest poll, not a daily
 * delta. The cards sum it directly — "total spent on this batch of
 * ads, lifetime" — which is what an operator wants at-a-glance. True
 * day-by-day attribution requires a separate ad_metrics_history table
 * (out of scope for Phase 6; Phase 6+ can layer it on the same poll
 * loop).
 */

export type TimeRange = '24h' | '7d' | '30d' | 'all';

export interface DashboardMetrics {
  totalSpendUsd: number;
  totalConversions: number;
  totalClicks: number;
  totalImpressions: number;
  avgCpcUsd: number | null;
  avgCtrPct: number | null;
  impliedRoas: number | null;
  adsActiveCount: number;
  adsKilledCount: number;
  adsScaledCount: number;
  /**
   * One point per local-day within the window. Pulled from
   * daily_summaries; an empty array means no cron-written history yet.
   */
  timeSeries: Array<{ date: string; spendUsd: number; conversions: number }>;
}

export interface PerAdRow {
  launchedAdId: string;
  headline: string | null;
  imageUrl: string | null;
  status: string;
  dailyBudgetUsd: number;
  totalSpendUsd: number;
  totalClicks: number;
  totalConversions: number;
  ctrPct: number;
  cpcUsd: number;
  impliedRoas: number;
  launchedAtIso: string;
  generationJobId: string | null;
}

export async function getDashboardMetrics(input: {
  userId: string;
  range: TimeRange;
  /** IANA tz from users.timezone — used to compute day boundaries. */
  userTimezone: string;
}): Promise<DashboardMetrics> {
  const db = getDb();
  const since = rangeToCutoff(input.range, input.userTimezone);

  // 1. Lifetime aggregates over the ads launched in the window.
  const whereLifetime = since
    ? and(eq(launchedAds.userId, input.userId), gte(launchedAds.launchedAt, since))
    : eq(launchedAds.userId, input.userId);

  const [agg] = await db
    .select({
      spend: sql<string>`coalesce(sum(${launchedAds.metaSpendUsd}), 0)`,
      conversions: sql<string>`coalesce(sum(${launchedAds.metaConversions}), 0)`,
      clicks: sql<string>`coalesce(sum(${launchedAds.metaClicks}), 0)`,
      impressions: sql<string>`coalesce(sum(${launchedAds.metaImpressions}), 0)`,
    })
    .from(launchedAds)
    .where(whereLifetime);

  const totalSpendUsd = Number(agg?.spend ?? 0);
  const totalConversions = Number(agg?.conversions ?? 0);
  const totalClicks = Number(agg?.clicks ?? 0);
  const totalImpressions = Number(agg?.impressions ?? 0);
  const avgCpcUsd = totalClicks > 0 ? totalSpendUsd / totalClicks : null;
  const avgCtrPct = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;
  const impliedRoas =
    totalSpendUsd > 0 ? (totalConversions * ASSUMED_CONVERSION_VALUE_USD) / totalSpendUsd : null;

  // 2. Lifecycle counters — distinct statuses + scale_count > 0.
  const statusRows = await db
    .select({ status: launchedAds.status, c: count() })
    .from(launchedAds)
    .where(whereLifetime)
    .groupBy(launchedAds.status);
  const byStatus = new Map(statusRows.map((r) => [r.status, Number(r.c)]));

  const scaledRows = await db
    .select({ scaled: count() })
    .from(launchedAds)
    .where(
      since
        ? and(
            eq(launchedAds.userId, input.userId),
            gte(launchedAds.launchedAt, since),
            isNotNull(launchedAds.lastScaledAt),
          )
        : and(eq(launchedAds.userId, input.userId), isNotNull(launchedAds.lastScaledAt)),
    );
  const scaled = scaledRows[0]?.scaled ?? 0;

  // 3. Time series — daily_summaries within the same window.
  const summariesSince = since
    ? sql`${dailySummaries.date} >= ${dateOnly(since)}::date`
    : undefined;
  const series = await db
    .select({
      date: dailySummaries.date,
      spend: dailySummaries.spend,
      conversions: dailySummaries.conversions,
    })
    .from(dailySummaries)
    .where(
      summariesSince
        ? and(eq(dailySummaries.userId, input.userId), summariesSince)
        : eq(dailySummaries.userId, input.userId),
    )
    .orderBy(asc(dailySummaries.date));

  return {
    totalSpendUsd: round2(totalSpendUsd),
    totalConversions,
    totalClicks,
    totalImpressions,
    avgCpcUsd: avgCpcUsd != null ? round2(avgCpcUsd) : null,
    avgCtrPct: avgCtrPct != null ? round2(avgCtrPct) : null,
    impliedRoas: impliedRoas != null ? round2(impliedRoas) : null,
    adsActiveCount: byStatus.get('active') ?? 0,
    adsKilledCount: byStatus.get('killed') ?? 0,
    adsScaledCount: Number(scaled ?? 0),
    timeSeries: series.map((r) => ({
      date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().slice(0, 10),
      spendUsd: Number(r.spend ?? 0),
      conversions: r.conversions ?? 0,
    })),
  };
}

export async function getPerAdBreakdown(input: {
  userId: string;
  range: TimeRange;
  userTimezone: string;
  sortBy?: 'spend' | 'roas' | 'launched_at';
  limit?: number;
}): Promise<PerAdRow[]> {
  const db = getDb();
  const since = rangeToCutoff(input.range, input.userTimezone);
  const rows = await db
    .select({
      id: launchedAds.id,
      status: launchedAds.status,
      dailyBudgetUsd: launchedAds.dailyBudgetUsd,
      spend: launchedAds.metaSpendUsd,
      clicks: launchedAds.metaClicks,
      conversions: launchedAds.metaConversions,
      impressions: launchedAds.metaImpressions,
      launchedAt: launchedAds.launchedAt,
      generationJobId: launchedAds.generationJobId,
      generatedCreativeId: launchedAds.generatedCreativeId,
    })
    .from(launchedAds)
    .where(
      since
        ? and(eq(launchedAds.userId, input.userId), gte(launchedAds.launchedAt, since))
        : eq(launchedAds.userId, input.userId),
    )
    .orderBy(desc(launchedAds.launchedAt));

  // Join: generated_creatives → headline + fileUrl. One follow-up query
  // keeps the main aggregation indexable.
  const creativeIds = rows.map((r) => r.generatedCreativeId).filter(Boolean);
  const creatives = creativeIds.length
    ? await db
        .select({
          id: generatedCreatives.id,
          headline: generatedCreatives.headline,
          fileUrl: generatedCreatives.fileUrl,
        })
        .from(generatedCreatives)
        .where(inArray(generatedCreatives.id, creativeIds))
    : [];
  const creativeMap = new Map(creatives.map((c) => [c.id, c]));

  const enriched: PerAdRow[] = rows.map((r) => {
    const spend = Number(r.spend ?? 0);
    const clicks = Number(r.clicks ?? 0);
    const conversions = Number(r.conversions ?? 0);
    const impressions = Number(r.impressions ?? 0);
    const ctrPct = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const cpcUsd = clicks > 0 ? spend / clicks : 0;
    const impliedRoas = spend > 0 ? (conversions * ASSUMED_CONVERSION_VALUE_USD) / spend : 0;
    const creative = creativeMap.get(r.generatedCreativeId);
    return {
      launchedAdId: r.id,
      headline: creative?.headline ?? null,
      imageUrl: creative?.fileUrl ?? null,
      status: r.status,
      dailyBudgetUsd: Number(r.dailyBudgetUsd),
      totalSpendUsd: round2(spend),
      totalClicks: clicks,
      totalConversions: conversions,
      ctrPct: round2(ctrPct),
      cpcUsd: round2(cpcUsd),
      impliedRoas: round2(impliedRoas),
      launchedAtIso: r.launchedAt.toISOString(),
      generationJobId: r.generationJobId,
    };
  });

  // In-memory sort — caller's limit caps blast radius. Drizzle conditional
  // orderBy on derived columns isn't worth the SQL gymnastics for the
  // expected ≤ few hundred rows.
  const sortBy = input.sortBy ?? 'spend';
  if (sortBy === 'spend') enriched.sort((a, b) => b.totalSpendUsd - a.totalSpendUsd);
  else if (sortBy === 'roas') enriched.sort((a, b) => b.impliedRoas - a.impliedRoas);

  return input.limit ? enriched.slice(0, input.limit) : enriched;
}

/**
 * Resolve the user's timezone with a sane fallback. Used by the dashboard
 * page so a single helper call gives both the tz + the cutoff math.
 */
export async function getUserTimezone(userId: string): Promise<string> {
  const db = getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { timezone: true },
  });
  return row?.timezone ?? 'America/New_York';
}

// =========================================================================
// TZ-aware day boundary helpers — same trick as launch-cap.ts /
// cost-cap.ts (the chart hits one Date math hot path, share code later).
// =========================================================================
function rangeToCutoff(range: TimeRange, tz: string): Date | null {
  if (range === 'all') return null;
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  const startOfToday = startOfTodayInTimezone(new Date(), tz);
  return new Date(startOfToday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

function startOfTodayInTimezone(now: Date, timezone: string): Date {
  const parts = formatToParts(now, timezone);
  const naiveUtcMidnight = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0,
    0,
  );
  const offsetMs = computeZoneOffsetMs(new Date(naiveUtcMidnight), timezone);
  return new Date(naiveUtcMidnight - offsetMs);
}

function formatToParts(d: Date, timezone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

function computeZoneOffsetMs(d: Date, timezone: string): number {
  const tzParts = formatToParts(d, timezone);
  const utcParts = formatToParts(d, 'UTC');
  const tzMs = Date.UTC(
    Number(tzParts.year),
    Number(tzParts.month) - 1,
    Number(tzParts.day),
    Number(tzParts.hour),
    Number(tzParts.minute),
    Number(tzParts.second),
  );
  const utcMs = Date.UTC(
    Number(utcParts.year),
    Number(utcParts.month) - 1,
    Number(utcParts.day),
    Number(utcParts.hour),
    Number(utcParts.minute),
    Number(utcParts.second),
  );
  return tzMs - utcMs;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
