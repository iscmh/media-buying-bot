import { and, eq, sql } from 'drizzle-orm';
import { ASSUMED_CONVERSION_VALUE_USD } from '@mbb/shared';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

/**
 * Phase 6: hourly cron that fires the daily P&L recap to each user at
 * their local `daily_summary_hour_local`. Idempotent per (user, date)
 * via the unique constraint on daily_summaries — re-running in the
 * same hour is a no-op even if Inngest retries.
 *
 * Eligibility (computed in SQL so we don't pull every user every hour):
 *   - settings.daily_summary_enabled = true
 *   - extract(hour from now() AT TIME ZONE users.timezone)
 *       = settings.daily_summary_hour_local
 *
 * For each match:
 *   1. Compute "yesterday" in user-local tz (the date the summary covers)
 *   2. Aggregate launched_ads cumulative metrics + lifecycle counters
 *   3. INSERT ON CONFLICT DO NOTHING — returns inserted row's id
 *   4. If insert happened AND not BOT_DRY_RUN: dispatch Telegram
 *   5. Stamp telegram_sent_at
 *
 * Snapshot vs daily-delta tradeoff: Phase 6 v1 uses CUMULATIVE
 * launched_ads.meta_spend_usd as "total_spend" rather than yesterday-
 * only delta. Reason: we don't yet store per-day metric history.
 * Day-over-day deltas land when Phase 6+ adds ad_metrics_history.
 * Telegram message text reflects this honestly ("lifetime spend so far").
 */
export const dailySummaryGenerator = inngest.createFunction(
  { id: 'daily-summary-generator', name: 'Daily summary generator' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const dryRun = (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';

    // 1. Eligible users — single SQL hop using AT TIME ZONE math.
    const eligible = await step.run('select-eligible-users', async () => {
      const db = getDb();
      const rows = await db.execute(sql<{
        user_id: string;
        timezone: string;
        hour_local: number;
      }>`
        select u.id as user_id,
               u.timezone,
               us.daily_summary_hour_local as hour_local
        from public.users u
        join public.user_settings us on us.user_id = u.id
        where us.daily_summary_enabled = true
          and extract(hour from now() at time zone u.timezone)::int
              = us.daily_summary_hour_local
      `);
      // Drizzle's execute() returns an array-like; some drivers expose
      // .rows. Normalize.
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      return (list as Array<{ user_id: string; timezone: string; hour_local: number }>).map(
        (r) => ({
          userId: r.user_id,
          timezone: r.timezone,
        }),
      );
    });

    if (eligible.length === 0) {
      return { ok: true, eligible: 0, sent: 0 };
    }

    let sent = 0;

    for (const u of eligible) {
      // Polish-5: a single user's aggregate row going sideways used to
      // crash the cron mid-loop and starve the remaining users. Wrap
      // per-user so one failure logs to audit + falls back to a
      // generic "see /dashboard" message instead of blowing up.
      let result: SummaryResult;
      try {
        result = await step.run(`build-summary-${u.userId}`, async () =>
          computeAndUpsertSummary({ userId: u.userId, timezone: u.timezone, dryRun }),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await logAuditEvent({
          userId: u.userId,
          eventType: 'daily_summary_build_failed',
          eventData: { error: errorMessage },
        });
        if (!dryRun) {
          await step.sendEvent('daily-summary-telegram-fallback', {
            name: 'telegram/notify.requested',
            data: {
              userId: u.userId,
              message: 'Daily summary unavailable — see /dashboard',
            },
          });
        }
        continue;
      }
      if (result.alreadySentToday) continue;
      if (!result.inserted) continue;
      if (dryRun) {
        await logAuditEvent({
          userId: u.userId,
          eventType: 'daily_summary_skipped_telegram_dry_run',
          eventData: {
            summary_id: result.summaryId,
            summary_date: result.summaryDate,
          },
        });
        continue;
      }
      await step.sendEvent('daily-summary-telegram', {
        name: 'telegram/notify.requested',
        data: { userId: u.userId, message: result.message },
      });
      await step.run(`mark-sent-${u.userId}`, async () => {
        const db = getDb();
        await db
          .update(schema.dailySummaries)
          .set({ telegramSentAt: new Date() })
          .where(eq(schema.dailySummaries.id, result.summaryId));
      });
      sent++;
    }

    return { ok: true, eligible: eligible.length, sent };
  },
);

interface SummaryResult {
  inserted: boolean;
  alreadySentToday: boolean;
  summaryId: string;
  summaryDate: string;
  message: string;
}

async function computeAndUpsertSummary(input: {
  userId: string;
  timezone: string;
  dryRun: boolean;
}): Promise<SummaryResult> {
  void input.dryRun;
  const db = getDb();
  const { userId, timezone } = input;

  // Yesterday in the user's tz (the date the summary covers).
  const todayLocal = startOfTodayInTimezone(new Date(), timezone);
  const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);
  const summaryDateStr = yesterdayLocal.toISOString().slice(0, 10);

  // Lifetime aggregates across the user's launched ads.
  const [agg] = await db
    .select({
      spend: sql<string>`coalesce(sum(${schema.launchedAds.metaSpendUsd}), 0)`,
      conversions: sql<string>`coalesce(sum(${schema.launchedAds.metaConversions}), 0)`,
      clicks: sql<string>`coalesce(sum(${schema.launchedAds.metaClicks}), 0)`,
      impressions: sql<string>`coalesce(sum(${schema.launchedAds.metaImpressions}), 0)`,
    })
    .from(schema.launchedAds)
    .where(eq(schema.launchedAds.userId, userId));

  const totalSpendUsd = Number(agg?.spend ?? 0);
  const totalConversions = Number(agg?.conversions ?? 0);
  const totalClicks = Number(agg?.clicks ?? 0);
  const totalImpressions = Number(agg?.impressions ?? 0);
  const avgCpcUsd = totalClicks > 0 ? totalSpendUsd / totalClicks : null;
  const avgCtrPct = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;
  const impliedRoas =
    totalSpendUsd > 0 ? (totalConversions * ASSUMED_CONVERSION_VALUE_USD) / totalSpendUsd : null;

  // Lifecycle counters scoped to "events that landed yesterday in
  // user-local time". For BOT_DRY_RUN dev, this can be empty; that's
  // fine — the summary still posts.
  const launchedRows = await db
    .select({ id: schema.launchedAds.id })
    .from(schema.launchedAds)
    .where(
      and(
        eq(schema.launchedAds.userId, userId),
        sql`${schema.launchedAds.launchedAt} >= ${yesterdayLocal} and ${schema.launchedAds.launchedAt} < ${todayLocal}`,
      ),
    );
  const killedRows = await db
    .select({ id: schema.launchedAds.id })
    .from(schema.launchedAds)
    .where(
      and(
        eq(schema.launchedAds.userId, userId),
        sql`${schema.launchedAds.killedAt} >= ${yesterdayLocal} and ${schema.launchedAds.killedAt} < ${todayLocal}`,
      ),
    );
  const scaledRows = await db
    .select({ id: schema.launchedAds.id })
    .from(schema.launchedAds)
    .where(
      and(
        eq(schema.launchedAds.userId, userId),
        sql`${schema.launchedAds.lastScaledAt} >= ${yesterdayLocal} and ${schema.launchedAds.lastScaledAt} < ${todayLocal}`,
      ),
    );
  const activeRows = await db
    .select({ id: schema.launchedAds.id })
    .from(schema.launchedAds)
    .where(and(eq(schema.launchedAds.userId, userId), eq(schema.launchedAds.status, 'active')));

  // Best / worst by implied ROAS.
  const allActive = await db
    .select({
      id: schema.launchedAds.id,
      spend: schema.launchedAds.metaSpendUsd,
      conversions: schema.launchedAds.metaConversions,
      generatedCreativeId: schema.launchedAds.generatedCreativeId,
    })
    .from(schema.launchedAds)
    .where(eq(schema.launchedAds.userId, userId));
  const scored = allActive
    .map((r) => {
      const spend = Number(r.spend ?? 0);
      const conv = Number(r.conversions ?? 0);
      const roas = spend > 0 ? (conv * ASSUMED_CONVERSION_VALUE_USD) / spend : 0;
      return { id: r.id, spend, conv, roas, creativeId: r.generatedCreativeId };
    })
    .filter((r) => r.spend > 0);
  scored.sort((a, b) => b.roas - a.roas);
  const best = scored[0] ?? null;
  const worst = scored[scored.length - 1] ?? null;

  // Look up headlines for best/worst.
  let bestHeadline: string | null = null;
  let worstHeadline: string | null = null;
  if (best || worst) {
    const ids = [best?.creativeId, worst?.creativeId].filter(Boolean) as string[];
    if (ids.length > 0) {
      const creatives = await db
        .select({
          id: schema.generatedCreatives.id,
          headline: schema.generatedCreatives.headline,
        })
        .from(schema.generatedCreatives)
        .where(sql`${schema.generatedCreatives.id} = any(${ids})`);
      const byId = new Map(creatives.map((c) => [c.id, c.headline]));
      bestHeadline = best ? (byId.get(best.creativeId) ?? null) : null;
      worstHeadline = worst ? (byId.get(worst.creativeId) ?? null) : null;
    }
  }

  // Idempotent insert. ON CONFLICT DO NOTHING; check returning to see
  // if this is the first write for the day.
  const [inserted] = await db
    .insert(schema.dailySummaries)
    .values({
      userId,
      date: summaryDateStr,
      spend: totalSpendUsd.toFixed(2),
      conversions: totalConversions,
      totalClicks,
      totalImpressions,
      avgCpcUsd: avgCpcUsd != null ? avgCpcUsd.toFixed(2) : null,
      avgCtrPct: avgCtrPct != null ? avgCtrPct.toFixed(2) : null,
      impliedRoas: impliedRoas != null ? impliedRoas.toFixed(2) : null,
      adsActiveCount: activeRows.length,
      adsLaunchedCount: launchedRows.length,
      adsKilledCount: killedRows.length,
      adsScaledCount: scaledRows.length,
      bestPerformingAdId: best?.id ?? null,
      worstPerformingAdId: worst?.id ?? null,
    })
    .onConflictDoNothing({ target: [schema.dailySummaries.userId, schema.dailySummaries.date] })
    .returning({ id: schema.dailySummaries.id });

  if (!inserted) {
    // Conflict — row already there. Look it up so caller has the id +
    // can decide whether to re-send Telegram (we do not).
    const existing = await db.query.dailySummaries.findFirst({
      where: and(
        eq(schema.dailySummaries.userId, userId),
        eq(schema.dailySummaries.date, summaryDateStr),
      ),
      columns: { id: true },
    });
    return {
      inserted: false,
      alreadySentToday: true,
      summaryId: existing?.id ?? '',
      summaryDate: summaryDateStr,
      message: '',
    };
  }

  const message = formatDailyRecap({
    summaryDate: summaryDateStr,
    totalSpendUsd,
    totalConversions,
    impliedRoas,
    adsActiveCount: activeRows.length,
    adsKilledToday: killedRows.length,
    adsScaledToday: scaledRows.length,
    bestHeadline,
    bestSpendUsd: best?.spend ?? 0,
    bestConv: best?.conv ?? 0,
    bestRoas: best?.roas ?? 0,
    worstHeadline,
    worstSpendUsd: worst?.spend ?? 0,
    worstConv: worst?.conv ?? 0,
  });

  return {
    inserted: true,
    alreadySentToday: false,
    summaryId: inserted.id,
    summaryDate: summaryDateStr,
    message,
  };
}

/**
 * Phase 6 Telegram template. ROAS emoji follows the same gradient the
 * decision engine uses:
 *   🟢 ≥ 2.0  →  scale-territory
 *   🟡 ≥ 1.0  →  break-even
 *   🔴 < 1.0  →  losing money
 *   ⚪️ no spend yet
 */
export function formatDailyRecap(input: {
  summaryDate: string | null | undefined;
  totalSpendUsd: number | null | undefined;
  totalConversions: number | null | undefined;
  impliedRoas: number | null | undefined;
  adsActiveCount: number | null | undefined;
  adsKilledToday: number | null | undefined;
  adsScaledToday: number | null | undefined;
  bestHeadline: string | null | undefined;
  bestSpendUsd: number | null | undefined;
  bestConv: number | null | undefined;
  bestRoas: number | null | undefined;
  worstHeadline: string | null | undefined;
  worstSpendUsd: number | null | undefined;
  worstConv: number | null | undefined;
}): string {
  // Polish-5: bare ?? 0 defaults so a single null in the aggregate row
  // doesn't throw on toFixed(). Prod crash: an unpolled launched_ad
  // produced a null sum that hit Buffer.byteLength via the Telegram
  // dispatch step. Fail soft + still ship a message.
  try {
    const roas = input.impliedRoas ?? null;
    const roasEmoji = roasIndicator(roas);
    const roasText = roas != null ? `${roas.toFixed(2)}x` : 'n/a';
    const spend = input.totalSpendUsd ?? 0;
    const conv = input.totalConversions ?? 0;
    const active = input.adsActiveCount ?? 0;
    const killed = input.adsKilledToday ?? 0;
    const scaled = input.adsScaledToday ?? 0;
    const date = input.summaryDate ?? '—';

    const lines: string[] = [];
    lines.push(`📊 Daily Recap — ${date}`);
    lines.push('');
    lines.push(`💸 Spent (lifetime so far): $${spend.toFixed(2)}`);
    lines.push(`🎯 Conversions: ${conv}`);
    lines.push(`${roasEmoji} ROAS: ${roasText}`);
    lines.push(`Active ads: ${active}`);
    if (killed > 0) lines.push(`💀 Killed yesterday: ${killed}`);
    if (scaled > 0) lines.push(`📈 Scaled yesterday: ${scaled}`);

    if (input.bestHeadline) {
      const bestSpend = input.bestSpendUsd ?? 0;
      const bestConv = input.bestConv ?? 0;
      const bestRoas = input.bestRoas ?? 0;
      lines.push('');
      lines.push(
        `🏆 Best performer: "${input.bestHeadline}" — $${bestSpend.toFixed(2)} → ${bestConv} conv (${bestRoas.toFixed(2)}x)`,
      );
    }
    if (input.worstHeadline && input.worstHeadline !== input.bestHeadline) {
      const worstSpend = input.worstSpendUsd ?? 0;
      const worstConv = input.worstConv ?? 0;
      lines.push(
        `💀 Worst performer: "${input.worstHeadline}" — $${worstSpend.toFixed(2)} → ${worstConv} conv`,
      );
    }

    lines.push('');
    lines.push('View full dashboard: /dashboard');
    return lines.join('\n');
  } catch {
    return 'Daily summary unavailable — see /dashboard';
  }
}

function roasIndicator(roas: number | null): string {
  if (roas == null) return '⚪️';
  if (roas >= 2) return '🟢';
  if (roas >= 1) return '🟡';
  return '🔴';
}

// TZ helper — duplicated from cost-cap.ts / launch-cap.ts / dashboard.ts.
// Same intent, kept local so the cron module stays self-contained.
function startOfTodayInTimezone(now: Date, timezone: string): Date {
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
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const naiveUtcMidnight = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0,
    0,
  );
  const naive = new Date(naiveUtcMidnight);
  const tzParts: Record<string, string> = {};
  for (const p of fmt.formatToParts(naive)) {
    if (p.type !== 'literal') tzParts[p.type] = p.value;
  }
  const utcFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const utcParts: Record<string, string> = {};
  for (const p of utcFmt.formatToParts(naive)) {
    if (p.type !== 'literal') utcParts[p.type] = p.value;
  }
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
  return new Date(naiveUtcMidnight - (tzMs - utcMs));
}
