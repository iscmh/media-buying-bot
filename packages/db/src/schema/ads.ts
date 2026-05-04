import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adStatusEnum, campaignObjectiveEnum } from './enums';
import { generatedCreatives } from './generation';
import { users } from './users';

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  metaCampaignId: text('meta_campaign_id').unique(),
  name: text('name').notNull(),
  objective: campaignObjectiveEnum('objective').notNull(),
  status: adStatusEnum('status').notNull().default('pending'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adSets = pgTable('ad_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),

  metaAdsetId: text('meta_adset_id').unique(),
  name: text('name').notNull(),

  dailyBudget: numeric('daily_budget', { precision: 10, scale: 2 }).notNull(),
  status: adStatusEnum('status').notNull().default('pending'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ads = pgTable('ads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  adSetId: uuid('ad_set_id')
    .notNull()
    .references(() => adSets.id, { onDelete: 'cascade' }),
  generatedCreativeId: uuid('generated_creative_id')
    .notNull()
    .references(() => generatedCreatives.id, { onDelete: 'restrict' }),

  metaAdId: text('meta_ad_id').unique(),
  status: adStatusEnum('status').notNull().default('pending'),

  killReason: text('kill_reason'),
  killedAt: timestamp('killed_at', { withTimezone: true }),
  scaledAt: timestamp('scaled_at', { withTimezone: true }),
  scaleTierReached: integer('scale_tier_reached'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
