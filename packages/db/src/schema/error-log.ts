import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Polish-25.7 Commit 46: mirror of supabase/migrations/0041_error_log.sql.
 *
 * Rows written by:
 *   - server-action wrapper (apps/web/lib/with-error-logging.ts)
 *   - API-route wrapper
 *   - Inngest onFailure hook (packages/jobs/src/error-hook.ts)
 *   - client error boundary + unhandled-promise handler via
 *     /api/log-error
 *
 * Rows read by /admin/errors only. Retention: 90 days via
 * cleanup-error-log Inngest cron.
 */
export const errorLog = pgTable('error_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  source: text('source').notNull(),
  sourceName: text('source_name'),
  message: text('message').notNull(),
  stack: text('stack'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  breadcrumbs: jsonb('breadcrumbs').$type<Array<Record<string, unknown>>>().notNull().default([]),
  severity: text('severity').notNull().default('error'),
  fingerprint: text('fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ErrorLogSource =
  | 'server_action'
  | 'api_route'
  | 'worker'
  | 'client_render'
  | 'client_boundary'
  | 'unhandled_promise';

export type ErrorLogSeverity = 'error' | 'warning' | 'info';
