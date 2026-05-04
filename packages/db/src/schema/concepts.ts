import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { conceptContentTypeEnum, conceptStatusEnum } from './enums.js';
import { users } from './users.js';

/**
 * Source creative concepts uploaded by the user. The bot analyzes and
 * remixes these into 30-40 variants in the generation pipeline (Phase 3).
 */
export const concepts = pgTable('concepts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  contentType: conceptContentTypeEnum('content_type').notNull(),

  // For video concepts. Stored in Supabase Storage.
  fileUrl: text('file_url'),
  // For text concepts (or video metadata).
  description: text('description'),

  status: conceptStatusEnum('status').notNull().default('pending_review'),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
