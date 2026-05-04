import { date, integer, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ads } from './ads';
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

export const dailySummaries = pgTable('daily_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),

  spend: numeric('spend', { precision: 12, scale: 2 }).notNull().default('0.00'),
  revenue: numeric('revenue', { precision: 12, scale: 2 }).notNull().default('0.00'),
  profit: numeric('profit', { precision: 12, scale: 2 }).notNull().default('0.00'),
  roi: numeric('roi', { precision: 8, scale: 4 }),
  conversions: integer('conversions').notNull().default(0),
  cpa: numeric('cpa', { precision: 10, scale: 2 }),
  topPerformerAdId: uuid('top_performer_ad_id').references(() => ads.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
