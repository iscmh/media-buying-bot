import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * General application audit log. NOT for Meta API calls — those go to
 * `meta_api_call_logs` (separate table because of volume).
 *
 * `event_type` is a string (not enum) on purpose: new event types should
 * be addable without a migration. Examples:
 *   - "user.signup"
 *   - "user.tos_accepted"
 *   - "settings.updated"
 *   - "kill_switch.user_pause"
 *   - "kill_switch.global_emergency_stop"
 *   - "spend_safety.denied"
 */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Nullable because some events (e.g. global emergency stop) are platform-level.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

  eventType: text('event_type').notNull(),
  eventData: jsonb('event_data').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every Meta Graph API call. Required for liability defense if a customer
 * disputes a bot action. Bodies are sanitized — no access tokens, no PII.
 */
export const metaApiCallLogs = pgTable('meta_api_call_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  endpoint: text('endpoint').notNull(),
  method: text('method').notNull(),

  // Sanitized: tokens stripped, PII redacted before write.
  requestBodySanitized: jsonb('request_body_sanitized').notNull().default({}),
  responseStatus: integer('response_status'),
  // Excerpt only — full bodies can be huge. ~2KB cap enforced in code.
  responseBodyExcerpt: jsonb('response_body_excerpt'),

  latencyMs: integer('latency_ms'),

  // Whether this was a no-op due to BOT_DRY_RUN.
  dryRun: integer('dry_run').notNull().default(0),

  calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
});
