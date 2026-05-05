import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { generatedCreatives, generationJobs } from './generation';
import { users } from './users';

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

/**
 * Phase 3b: every Gemini / Claude / Kie.ai / HeyGen / Arcads / Creatify
 * API call from inside an Inngest generation job. Same shape as
 * meta_api_call_logs plus a `provider` discriminator and `cost_usd`.
 *
 * Not folded into meta_api_call_logs because that table has Meta-specific
 * semantics (tokens, ad-account scoping). Two parallel tables is cleaner
 * than one cross-purposed one.
 *
 * Service-role writes only; users read their own via RLS.
 */
export const aiProviderApiCallLogs = pgTable('ai_provider_api_call_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Free-form text rather than enum so adding a provider doesn't require
  // a migration. Expected values: 'gemini', 'claude', 'kie_ai', 'heygen',
  // 'arcads', 'creatify'.
  provider: text('provider').notNull(),

  endpoint: text('endpoint').notNull(),
  method: text('method').notNull(),

  // Sanitized: API keys stripped, large media payloads excerpted.
  requestBodySanitized: jsonb('request_body_sanitized').notNull().default({}),
  responseStatus: integer('response_status'),
  responseBodyExcerpt: jsonb('response_body_excerpt'),

  latencyMs: integer('latency_ms'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),

  generationJobId: uuid('generation_job_id').references(() => generationJobs.id, {
    onDelete: 'set null',
  }),
  generatedCreativeId: uuid('generated_creative_id').references(() => generatedCreatives.id, {
    onDelete: 'set null',
  }),

  calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
});
