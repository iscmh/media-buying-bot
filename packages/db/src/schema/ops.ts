import { boolean, integer, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { featureFlagScopeEnum, pauseActorEnum } from './enums';
import { users } from './users';

/**
 * Feature flags. DB-backed so I can flip without redeploy.
 *
 * `scope = 'global'` → applies to everyone, `userId` must be NULL.
 * `scope = 'user'` → applies to that user only, `userId` required.
 */
export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  flagName: text('flag_name').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  scope: featureFlagScopeEnum('scope').notNull().default('global'),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  description: text('description'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-row table. Setting `is_active = true` halts every user's bot
 * worldwide. Use as last-resort kill switch (Meta API broken, security
 * incident, etc.). The single-row constraint is enforced via a CHECK on `id`.
 */
export const globalEmergencyStop = pgTable('global_emergency_stop', {
  // Always 1. Enforced by CHECK constraint in migration.
  id: smallint('id').primaryKey(),
  isActive: boolean('is_active').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  reason: text('reason'),
  activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * History of per-user pause events. The "current" pause state lives on
 * `users.is_paused` for fast hot-path reads.
 */
export const userPauseLog = pgTable('user_pause_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  pausedAt: timestamp('paused_at', { withTimezone: true }).notNull().defaultNow(),
  unpausedAt: timestamp('unpaused_at', { withTimezone: true }),

  reason: text('reason').notNull(),
  pausedBy: pauseActorEnum('paused_by').notNull(),
});

/**
 * Rate limit hits. Used to trigger 30-min cooldowns when a user hits the
 * limit twice in one hour (anti-ban guardrail #1).
 */
export const rateLimitEvents = pgTable('rate_limit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  hitAt: timestamp('hit_at', { withTimezone: true }).notNull().defaultNow(),
  errorCode: integer('error_code').notNull(), // Meta error code: 17, 80004, 613
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
});
