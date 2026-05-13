import { date, integer, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ads } from './ads';
import { launchedAds } from './launched-ads';
import { users } from './users';

export const performanceLogs = pgTable('performance_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  adId: uuid('ad_id')
    .notNull()
    .references(() => ads.id, { onDelete: 'cascade' }),

  // Hours since launch, e.g. 1, 2, 4, 6, 24.
  hourMark: integer('hour_mark').notNull(),

  cpc: numeric('cpc', { precision: 10, scale: 4 }),
  ctr: numeric('ctr', { precision: 5, scale: 2 }),
  conversions: integer('conversions').notNull().default(0),
  spend: numeric('spend', { precision: 10, scale: 2 }).notNull().default('0.00'),

  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase-1 + Phase-6. The Phase-1 columns (spend / revenue / profit /
 * roi / conversions / cpa / top_performer_ad_id) power the spend-safety
 * "spent today" check and a future P&L view. Phase 6 adds the
 * dashboard-friendly aggregates the daily-summary cron writes and the
 * /dashboard chart reads.
 *
 * Idempotency: unique (user_id, date) — the cron's ON CONFLICT DO
 * NOTHING path makes re-runs in the same hour safe.
 */
export const dailySummaries = pgTable(
  'daily_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),

    // Phase-1 columns.
    spend: numeric('spend', { precision: 12, scale: 2 }).notNull().default('0.00'),
    revenue: numeric('revenue', { precision: 12, scale: 2 }).notNull().default('0.00'),
    profit: numeric('profit', { precision: 12, scale: 2 }).notNull().default('0.00'),
    roi: numeric('roi', { precision: 8, scale: 4 }),
    conversions: integer('conversions').notNull().default(0),
    cpa: numeric('cpa', { precision: 10, scale: 2 }),
    topPerformerAdId: uuid('top_performer_ad_id').references(() => ads.id, {
      onDelete: 'set null',
    }),

    // Phase-6 aggregates (filled by daily-summary cron).
    adsActiveCount: integer('ads_active_count').notNull().default(0),
    adsLaunchedCount: integer('ads_launched_count').notNull().default(0),
    adsKilledCount: integer('ads_killed_count').notNull().default(0),
    adsScaledCount: integer('ads_scaled_count').notNull().default(0),
    totalClicks: integer('total_clicks').notNull().default(0),
    totalImpressions: integer('total_impressions').notNull().default(0),
    avgCpcUsd: numeric('avg_cpc_usd', { precision: 10, scale: 2 }),
    avgCtrPct: numeric('avg_ctr_pct', { precision: 5, scale: 2 }),
    impliedRoas: numeric('implied_roas', { precision: 10, scale: 2 }),
    bestPerformingAdId: uuid('best_performing_ad_id').references(() => launchedAds.id, {
      onDelete: 'set null',
    }),
    worstPerformingAdId: uuid('worst_performing_ad_id').references(() => launchedAds.id, {
      onDelete: 'set null',
    }),
    telegramSentAt: timestamp('telegram_sent_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDateUnique: uniqueIndex('daily_summaries_user_date_unique').on(table.userId, table.date),
  }),
);
