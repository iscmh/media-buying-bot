import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Polish-25.2 Commit 16b: named launch presets. See migration 0038
 * for the WHY. One row per (user, preset name). CRUD in
 * /settings/presets; consumed by the launch dialog dropdown at
 * /runs/[id].
 *
 * Fields mirror the launch dialog inline form. Note the launch
 * dialog also collects offer_url + page_id but those are per-
 * concept / per-connection things — never stored on a preset.
 */
export const userLaunchPresets = pgTable(
  'user_launch_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    targetingCountries: text('targeting_countries')
      .array()
      .notNull()
      .default(sql`array['US']::text[]`),
    ageMin: integer('age_min').notNull().default(18),
    ageMax: integer('age_max').notNull().default(65),

    optimizationGoal: text('optimization_goal').notNull().default('CONVERSIONS'),
    placementType: text('placement_type').notNull().default('advantage_plus'),
    perAdDailyBudgetUsd: numeric('per_ad_daily_budget_usd', { precision: 10, scale: 2 })
      .notNull()
      .default('10.00'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ageMinCheck: check('user_launch_presets_age_min_check', sql`${t.ageMin} between 13 and 65`),
    ageMaxCheck: check('user_launch_presets_age_max_check', sql`${t.ageMax} between 13 and 65`),
    ageOrderCheck: check('user_launch_presets_age_order_check', sql`${t.ageMin} <= ${t.ageMax}`),
    budgetCheck: check('user_launch_presets_budget_check', sql`${t.perAdDailyBudgetUsd} > 0`),
  }),
);
