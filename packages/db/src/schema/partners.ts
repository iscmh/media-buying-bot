import { jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { partnerReferralStatusEnum, partnerStatusEnum } from './enums';
import { users } from './users';

/**
 * Agency BM partners. Scaffolding from day 1 — actual partner deal wired
 * in a later phase. Many users in MMO/bizopp/finance need agency BMs to
 * isolate enforcement risk from their personal FB accounts.
 */
export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerName: text('partner_name').notNull(),
  // URL template with `{user_id}` placeholder for tracking, e.g.
  // "https://partner.com/signup?ref={user_id}"
  referralUrlTemplate: text('referral_url_template').notNull(),
  // Free-form: { type: 'flat', amountUsd: 50 } or { type: 'rev_share', pct: 10 }
  commissionStructure: jsonb('commission_structure').notNull().default({}),
  status: partnerStatusEnum('status').notNull().default('pending'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const partnerReferrals = pgTable('partner_referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'restrict' }),

  referredAt: timestamp('referred_at', { withTimezone: true }).notNull().defaultNow(),
  signupConfirmedAt: timestamp('signup_confirmed_at', { withTimezone: true }),

  status: partnerReferralStatusEnum('status').notNull().default('referred'),

  totalPaidToPartner: numeric('total_paid_to_partner', { precision: 12, scale: 2 })
    .notNull()
    .default('0.00'),
  ourCommission: numeric('our_commission', { precision: 12, scale: 2 }).notNull().default('0.00'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
