import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Polish-29.0.0 Commit 109: credit-system schema.
 *
 * Model:
 *   - `credits_balance`      — one row per user, live spendable balance
 *   - `credit_transactions`  — append-only audit log of every credit
 *                              in/out. Balance is derivable from the
 *                              sum; the balance table is a hot cache.
 *   - `credit_reservations`  — holds credits during in-flight
 *                              generation jobs, prevents double-spend
 *                              when a user fires two jobs at once
 *                              against a low balance. Auto-expires at
 *                              30min so a crashed worker never traps
 *                              credits forever.
 *   - `fraud_signals`        — velocity + IP anomaly tracking. Read
 *                              on every purchase / high-spend event.
 *                              Fraud dashboard queries this.
 *
 * All four tables are RLS-scoped to the row's user_id in the
 * migration file. Backend code never bypasses RLS with the service
 * role for these tables — every read/write is user-scoped.
 */

// ============================================================
// credits_balance
// ============================================================
export const creditsBalance = pgTable('credits_balance', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /**
   * Currently spendable credits. Never negative — worker rejects
   * a job whose reservation would drive balance < 0.
   */
  balance: integer('balance').notNull().default(0),

  /**
   * Cumulative credits ever added (purchase + monthly-sub + trial +
   * admin adjust). Used for lifetime-value reporting.
   */
  lifetimePurchased: integer('lifetime_purchased').notNull().default(0),

  /** Cumulative credits ever consumed by successful generations. */
  lifetimeSpent: integer('lifetime_spent').notNull().default(0),

  /**
   * Auto-topup toggle: when true, a Whop charge for the user's
   * saved payment method fires once balance drops below the pack
   * threshold. Off by default.
   */
  autoTopupEnabled: text('auto_topup_enabled').notNull().default('false'),

  /** Which top-up pack sku auto-topup fires against. Null = disabled. */
  autoTopupPackSku: text('auto_topup_pack_sku'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// credit_transactions
// ============================================================
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Signed integer. Positive for additions (purchase, sub topup,
     * trial grant, refund-on-fail), negative for spends.
     */
    delta: integer('delta').notNull(),

    /**
     * Category of the transaction. Every code path that writes here
     * picks one — never leave null.
     *
     *   'signup_trial'       — free credits at first login
     *   'purchase'           — one-off top-up pack via Whop
     *   'sub_monthly_topup'  — recurring credits on Whop sub renewal
     *   'sub_bonus'          — bonus credits (e.g. volume pack bonus)
     *   'spend'              — consumed by a successful generation
     *   'refund_on_fail'     — generation failed, credits returned
     *   'admin_adjust'       — manual adjustment (support / fraud
     *                          claw-back). Requires an admin note.
     *   'chargeback_reverse' — Whop dispute: credits deducted +
     *                          balance may go temporarily negative
     */
    type: text('type').notNull(),

    /**
     * Reference to whatever caused the transaction. Shape depends on
     * `type`:
     *   'purchase' / 'sub_monthly_topup' / 'sub_bonus' →
     *      whop_event.id or whop_transaction_id
     *   'spend' / 'refund_on_fail' → generation_jobs.id
     *   'admin_adjust' → admin user_id
     *   'chargeback_reverse' → whop_dispute_id
     */
    refId: text('ref_id'),

    /** Human-readable description shown in the user's history view. */
    description: text('description'),

    /**
     * Denormalized balance-after value for auditability. Lets us
     * reconstruct history without SUM-scans across the whole log.
     */
    balanceAfter: integer('balance_after').notNull(),

    /**
     * Structured metadata (pack sku, model id, cost per credit,
     * useapi request id, whop event id, admin note, etc.).
     */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('credit_tx_user_created_idx').on(t.userId, t.createdAt),
    typeIdx: index('credit_tx_type_idx').on(t.type),
  }),
);

// ============================================================
// credit_reservations
// ============================================================
export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The generation job this reservation is holding credits for.
     * Nullable because reservations for other future flows (e.g.
     * admin manual test) don't tie to a generation job.
     */
    generationJobId: uuid('generation_job_id'),

    /**
     * Credits held. Deducted from balance immediately on reservation
     * insert; returned to balance on release / expiry.
     */
    credits: integer('credits').notNull(),

    /**
     * Stable id of the credit model being used (see
     * @mbb/shared/credit-pricing). Denormalized so the audit trail
     * survives credit-cost changes.
     */
    modelId: text('model_id').notNull(),

    /**
     * Reservation auto-releases at this timestamp so a worker crash
     * never traps credits. Default 30min from creation.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * When the reservation was resolved. Null while active. Set to
     * now() when convert-to-spend or release-back-to-balance fires.
     */
    releasedAt: timestamp('released_at', { withTimezone: true }),

    /**
     * How the reservation was resolved:
     *   null       — still active
     *   'consumed' — job succeeded, converted to a spend transaction
     *   'released' — job failed, credits returned to balance
     *   'expired'  — 30min timeout fired, credits returned (worker
     *                probably crashed)
     */
    resolution: text('resolution'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userActiveIdx: index('credit_res_user_active_idx').on(t.userId, t.releasedAt),
    expiresIdx: index('credit_res_expires_idx').on(t.expiresAt),
  }),
);

// ============================================================
// fraud_signals
// ============================================================
export const fraudSignals = pgTable(
  'fraud_signals',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Category the signal reports on. Velocity checks + purchase
     * events + generation bursts all land here so a single query
     * can enforce "user X spent > $Y in the last hour" across
     * multiple signal types.
     *
     *   'credit_purchase' — Whop charge succeeded
     *   'credit_spend'    — generation consumed credits
     *   'chargeback'      — Whop dispute opened
     *   'signup'          — account created (for per-IP rate limit)
     *   'ip_anomaly'      — request IP country != card country
     *   'admin_freeze'    — manual freeze via admin dashboard
     */
    eventType: text('event_type').notNull(),

    /** USD amount when applicable (purchases, chargebacks). */
    amountUsd: integer('amount_usd_cents'),

    /** Credits amount when applicable (spends). */
    credits: integer('credits'),

    /** Best-effort IP. May be null for server-triggered events. */
    ip: text('ip'),

    /**
     * Free-form context. Purchase → { pack_sku, whop_event_id }.
     * Spend → { generation_job_id, model_id }. Chargeback →
     * { whop_dispute_id, reason }. etc.
     */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userEventCreatedIdx: index('fraud_user_event_created_idx').on(
      t.userId,
      t.eventType,
      t.createdAt,
    ),
  }),
);
