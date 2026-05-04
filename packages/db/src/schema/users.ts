import { boolean, pgSchema, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums.js';

/**
 * Reference to Supabase's auth.users table. We don't manage this — Supabase
 * Auth does. Drizzle just needs the FK target.
 */
const authSchema = pgSchema('auth');
export const authUsers = authSchema.table('users', {
  id: uuid('id').primaryKey(),
});

/**
 * App-level user row. Linked 1:1 to auth.users via FK on `id`.
 * Created automatically by a Supabase trigger (see migrations) when a row
 * lands in auth.users.
 *
 * Soft-delete via `deleted_at`. Logs/audit rows referencing a deleted user
 * stay intact for compliance.
 */
export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  fullName: text('full_name'),
  role: userRoleEnum('role').notNull().default('user'),

  // IANA timezone, e.g. "America/New_York". Used for daily summaries.
  timezone: text('timezone').notNull().default('America/New_York'),

  // Per-user pause flag. Read on every bot action — fast hot path.
  // History/reasons live in `user_pause_log`.
  isPaused: boolean('is_paused').notNull().default(false),

  // ToS acceptance is gated before any onboarding step that touches Meta.
  tosAcceptedAt: timestamp('tos_accepted_at', { withTimezone: true }),
  tosVersion: text('tos_version'),

  // Soft delete.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
