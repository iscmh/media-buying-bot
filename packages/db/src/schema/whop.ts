import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inviteCodes } from './beta-access';
import { users } from './users';

/**
 * Phase 8: replaces / supersedes waitlist_entries for new-user intake.
 * Existing /waitlist rows stay readable by /admin/waitlist; new traffic
 * lands here via /apply.
 *
 * status:
 *   pending  → admin hasn't reviewed yet
 *   approved → admin clicked Approve, invite_code + whop_checkout_url filled
 *   rejected → admin clicked Reject (or never followed through)
 *   paid     → the Whop webhook confirmed payment
 */
export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name'),
  agencyName: text('agency_name'),
  monthlyAdSpendUsd: text('monthly_ad_spend_usd'),
  verticals: text('verticals'),
  whyApply: text('why_apply'),
  heardFrom: text('heard_from'),

  status: text('status').notNull().default('pending'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  inviteCodeId: uuid('invite_code_id').references(() => inviteCodes.id, {
    onDelete: 'set null',
  }),
  whopCheckoutUrl: text('whop_checkout_url'),
  whopProductId: text('whop_product_id'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  rejectedReason: text('rejected_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase 8: Whop membership mirror. One row per Whop membership the
 * user holds (a primary subscription + optional add-on memberships).
 *
 * user_id is NULLABLE because webhooks can arrive before signup. The
 * auth.users INSERT trigger reconciles by `pending_email` when the
 * matching user signs up.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    pendingEmail: text('pending_email'),

    whopMembershipId: text('whop_membership_id').notNull().unique(),
    whopUserId: text('whop_user_id'),
    whopProductId: text('whop_product_id').notNull(),

    // Free-form so we don't need an enum migration when adding tiers.
    planTier: text('plan_tier').notNull(),
    status: text('status').notNull(),

    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),

    inviteCodeId: uuid('invite_code_id').references(() => inviteCodes.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    membershipUnique: uniqueIndex('subscriptions_whop_membership_id_uniq').on(
      table.whopMembershipId,
    ),
  }),
);

/**
 * Phase 8: per-user add-on quotas. Today only ad_account_slots is
 * tracked. Phase 9+ can add concept_slots, team_seats, etc.
 */
export const entitlements = pgTable('entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  adAccountSlots: integer('ad_account_slots').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Phase 8: every incoming Whop webhook lands here. Unique on
 * whop_event_id so a retried delivery is a logged no-op.
 * signature_valid=false rows are evidence of a probe — useful for
 * debugging + future rate-limiting / IP banning.
 */
export const whopEvents = pgTable('whop_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  whopEventId: text('whop_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
