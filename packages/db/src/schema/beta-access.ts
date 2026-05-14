import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Phase 7: invite codes that gate signup. Admins generate codes from
 * /admin/invites or via the waitlist-approval flow. Single-use by
 * default with a 30-day expiry; the multi-use + max_uses fields
 * support promo codes when needed.
 *
 * Validation + redemption happen in the auth.users INSERT trigger so
 * a single auth.signUp transaction either redeems the code or rejects
 * the signup — no race window where a user exists with an unredeemed
 * code.
 */
export const inviteCodes = pgTable('invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  isMultiUse: boolean('is_multi_use').notNull().default(false),
  maxUses: integer('max_uses').notNull().default(1),
  useCount: integer('use_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase 7: public waitlist queue. Anyone can submit themselves
 * (RLS policy allows unauthed INSERT). Admins approve from
 * /admin/waitlist, which generates an invite_codes row + emails the
 * code (or stubs the send if RESEND_API_KEY isn't set).
 */
export const waitlistEntries = pgTable('waitlist_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  source: text('source'),
  message: text('message'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  inviteCodeId: uuid('invite_code_id').references(() => inviteCodes.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
