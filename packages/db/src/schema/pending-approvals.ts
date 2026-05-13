import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { launchedAds } from './launched-ads';
import { users } from './users';

/**
 * Phase 5: one row per kill/scale prompt awaiting a user tap in
 * Telegram. The polling cron's decision engine creates the row + posts
 * a Telegram message with an inline keyboard ("Confirm" / "Skip"); the
 * callback_query handler in apps/bot reads it back when the user taps,
 * verifies ownership (chat_id matches), and dispatches an Inngest
 * event to execute the actual Meta pause/scale.
 *
 * Rows have a 24h expires_at default — if the user doesn't tap by
 * then, status flips to 'expired' (lazy: checked when the callback
 * fires, never with a sweep job to keep the system stateless).
 */
export const pendingApprovals = pgTable('pending_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  launchedAdId: uuid('launched_ad_id')
    .notNull()
    .references(() => launchedAds.id, { onDelete: 'cascade' }),

  // Free-form text — discriminated by check constraint at the DB level.
  // 'kill' | 'scale'. (Plain text not enum so adding 'unpause' / 'bid_adjust'
  // in Phase 6 is a code-only change.)
  actionType: text('action_type').notNull(),
  proposedPayload: jsonb('proposed_payload').notNull().default({}),
  reason: text('reason').notNull(),

  telegramMessageId: text('telegram_message_id'),
  // 'pending' | 'confirmed' | 'skipped' | 'expired'.
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
