import { boolean, integer, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { campaignObjectiveEnum } from './enums.js';
import { users } from './users.js';

/**
 * One row per user. Created automatically on first login.
 *
 * Currency: USD only for MVP. TODO: add currency support when expanding
 * internationally — adds complexity around Meta API currency mismatch
 * detection and multi-currency reporting.
 */
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Test cap per ad set on launch (USD).
  defaultTestCap: numeric('default_test_cap', { precision: 10, scale: 2 })
    .notNull()
    .default('20.00'),
  adSetsPerLaunch: integer('ad_sets_per_launch').notNull().default(5),
  dailyGenerationVolume: integer('daily_generation_volume').notNull().default(40),

  campaignObjective: campaignObjectiveEnum('campaign_objective').notNull().default('CBO'),

  // Kill thresholds.
  killThresholdCpc: numeric('kill_threshold_cpc', { precision: 8, scale: 4 })
    .notNull()
    .default('2.5000'),
  killThresholdCtr: numeric('kill_threshold_ctr', { precision: 5, scale: 2 })
    .notNull()
    .default('2.00'),
  gracePeriodMinutes: integer('grace_period_minutes').notNull().default(30),
  hour6CutoffEnabled: boolean('hour_6_cutoff_enabled').notNull().default(true),

  // Scale tiers (USD daily caps).
  scaleTier1Cap: numeric('scale_tier_1_cap', { precision: 10, scale: 2 })
    .notNull()
    .default('200.00'),
  scaleTier2Cap: numeric('scale_tier_2_cap', { precision: 10, scale: 2 })
    .notNull()
    .default('400.00'),
  manualApprovalThreshold: numeric('manual_approval_threshold', { precision: 10, scale: 2 })
    .notNull()
    .default('400.00'),

  // User-configured cap. Platform enforces stricter of (this, env ceiling).
  platformDailySpendCeiling: numeric('platform_daily_spend_ceiling', { precision: 10, scale: 2 })
    .notNull()
    .default('500.00'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
