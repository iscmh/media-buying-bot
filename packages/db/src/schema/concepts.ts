import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { conceptContentTypeEnum, conceptStatusEnum } from './enums';
import { users } from './users';

/**
 * Source creative concepts uploaded by the user. The bot analyzes and
 * remixes these into 30-40 variants in the generation pipeline (Phase 3).
 *
 * Phase 3a extension: niche/source/offer metadata + per-content-type fields.
 * Static concepts populate static_* fields; UGC concepts populate
 * ugc_original_script. Both leave the other side NULL.
 */
export const concepts = pgTable('concepts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  contentType: conceptContentTypeEnum('content_type').notNull(),

  // Stored in Supabase Storage at <user_id>/concepts/<concept_id>/...
  fileUrl: text('file_url'),
  description: text('description'),

  status: conceptStatusEnum('status').notNull().default('pending_review'),

  // Phase 3a metadata — see migration 0008 for column definitions.
  nicheTag: text('niche_tag'),
  sourcePlatform: text('source_platform'),
  offerUrl: text('offer_url'),
  originalCpaUsd: numeric('original_cpa_usd', { precision: 10, scale: 2 }),
  originalRoas: numeric('original_roas', { precision: 10, scale: 2 }),

  // Static-only.
  staticHeadline: text('static_headline'),
  staticPrimaryText: text('static_primary_text'),
  staticDescription: text('static_description'),

  // UGC-only.
  ugcOriginalScript: text('ugc_original_script'),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
