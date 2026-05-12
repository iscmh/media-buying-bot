import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { concepts } from './concepts';
import { launchedAdStatusEnum } from './enums';
import { generatedCreatives, generationJobs } from './generation';
import { users } from './users';

/**
 * Phase 4a: one row per Meta ad we attempted to launch. Stores the Meta
 * IDs (or dry_run_<uuid> placeholders), the launch config snapshot, and
 * Phase-5 performance columns reserved for the future poller.
 *
 * `mode` is 'mock' while BOT_DRY_RUN=true and 'live' once Phase 4b
 * flips it; `status` starts at 'dry_run' / 'active' accordingly and
 * transitions through paused / killed / rejected_by_meta / launch_failed
 * over the ad's lifetime.
 */
export const launchedAds = pgTable('launched_ads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  generatedCreativeId: uuid('generated_creative_id')
    .notNull()
    .references(() => generatedCreatives.id),
  generationJobId: uuid('generation_job_id').references(() => generationJobs.id, {
    onDelete: 'set null',
  }),
  conceptId: uuid('concept_id').references(() => concepts.id, { onDelete: 'set null' }),

  // Meta object IDs. dry_run_<uuid> placeholders while mode='mock'.
  metaCampaignId: text('meta_campaign_id'),
  metaAdSetId: text('meta_ad_set_id'),
  metaCreativeId: text('meta_creative_id'),
  metaAdId: text('meta_ad_id'),

  // Per-ad daily budget at launch time. Drives the daily launch cap math.
  dailyBudgetUsd: numeric('daily_budget_usd', { precision: 10, scale: 2 }).notNull(),
  optimizationGoal: text('optimization_goal').notNull(),
  placementType: text('placement_type').notNull(),

  status: launchedAdStatusEnum('status').notNull().default('dry_run'),
  // Mirror of generation_jobs.mode — 'mock' in 4a, 'live' once 4b flips
  // BOT_DRY_RUN to false.
  mode: text('mode').notNull().default('mock'),
  errorMessage: text('error_message'),

  launchedAt: timestamp('launched_at', { withTimezone: true }).notNull().defaultNow(),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  killedAt: timestamp('killed_at', { withTimezone: true }),

  // Phase 5 — filled by the poller.
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  metaSpendUsd: numeric('meta_spend_usd', { precision: 10, scale: 2 }),
  metaImpressions: integer('meta_impressions'),
  metaClicks: integer('meta_clicks'),
  metaConversions: integer('meta_conversions'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
