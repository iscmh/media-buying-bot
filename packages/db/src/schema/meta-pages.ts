import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Phase 4b: cache of Facebook Pages the user has authorized for use as
 * ad creative "Page" (object_story_spec.page_id). Refreshed by calling
 * GET /me/accounts via callMeta and upserting on (user_id, page_id).
 *
 * page_access_token_encrypted holds a long-lived page token for the
 * rare endpoints that require it (most launch CRUD uses the user
 * access token from meta_connections — page tokens are only needed
 * for page-scoped operations).
 */
export const metaPages = pgTable(
  'meta_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pageId: text('page_id').notNull(),
    pageName: text('page_name').notNull(),
    pageAccessTokenEncrypted: text('page_access_token_encrypted'),
    category: text('category'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userPageUnique: uniqueIndex('meta_pages_user_page_unique').on(table.userId, table.pageId),
  }),
);
