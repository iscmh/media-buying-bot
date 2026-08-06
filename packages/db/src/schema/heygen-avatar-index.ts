/**
 * Polish-26 Commit 61: Drizzle table for the enriched HeyGen
 * avatar index. Direct mirror of makeugc-avatar-index.ts —
 * populated + refreshed by refresh-heygen-avatar-index Inngest
 * cron; read by the polish26-heygen worker's avatar-match step.
 *
 * See supabase/migrations/0045_heygen_avatar_index.sql for the
 * SQL-side definition + comments.
 *
 * Column shape is intentionally identical to makeugc_avatar_index
 * (except `heygen_gender` in place of `makeugc_gender`) so the
 * enriched-avatar matcher code can be reused across both providers.
 * The Gemini vision analysis prompt is likewise shared verbatim.
 */
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const heygenAvatarIndex = pgTable('heygen_avatar_index', {
  avatarId: text('avatar_id').primaryKey(),
  avatarName: text('avatar_name').notNull(),
  thumbnailUrl: text('thumbnail_url').notNull(),

  heygenGender: text('heygen_gender').notNull(),

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
