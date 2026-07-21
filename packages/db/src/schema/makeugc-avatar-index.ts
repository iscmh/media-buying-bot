/**
 * Polish-25 Commit 7: Drizzle table for the enriched MakeUGC
 * avatar index. Populated + refreshed by
 * refresh-makeugc-avatar-index Inngest cron; read by the
 * polish25-makeugc worker's avatar-match step.
 *
 * See supabase/migrations/0037_makeugc_avatar_index.sql for the
 * SQL-side definition, comments, and index rationale.
 */
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const makeugcAvatarIndex = pgTable('makeugc_avatar_index', {
  avatarId: text('avatar_id').primaryKey(),
  avatarName: text('avatar_name').notNull(),
  thumbnailUrl: text('thumbnail_url').notNull(),

  makeugcGender: text('makeugc_gender').notNull(),

  ageBucket: text('age_bucket').notNull(),
  ethnicity: text('ethnicity').notNull(),
  hairColor: text('hair_color').notNull(),
  hairStyle: text('hair_style'),
  facialHair: text('facial_hair'),
  wardrobeStyle: text('wardrobe_style'),
  wardrobeSummary: text('wardrobe_summary'),
  backgroundSetting: text('background_setting'),

  visionAnalysisRaw: jsonb('vision_analysis_raw'),

  visionAnalyzedAt: timestamp('vision_analyzed_at', { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
