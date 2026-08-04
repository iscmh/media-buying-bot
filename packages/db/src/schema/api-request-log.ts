import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys';
import { users } from './users';

/**
 * Polish-25.10 Commit 59: mirror of
 * supabase/migrations/0044_api_request_log.sql.
 *
 * Powers the 60/min sliding-window rate limiter + gives us a basic
 * audit trail per API key. Prune older than 7 days via a future
 * cleanup cron.
 */
export const apiRequestLog = pgTable(
  'api_request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyCreatedIdx: index('api_request_log_key_created_idx').on(t.apiKeyId, t.createdAt),
    userCreatedIdx: index('api_request_log_user_created_idx').on(t.userId, t.createdAt),
  }),
);
