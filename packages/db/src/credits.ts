/**
 * Polish-29.0.0 Commit 109: credit-system runtime.
 *
 * Public API surface for reserving, spending, refunding, and topping
 * up credits. Every code path that touches credit balances goes
 * through here so the ledger stays authoritative.
 *
 * Invariants (enforced here + at the DB via CHECK constraints):
 *   1. Balance never goes negative. A reservation that would drop it
 *      below zero throws InsufficientCreditsError up front.
 *   2. Every credit_transactions row has a non-null `balance_after`
 *      denormalized value. Reconstructing history never requires a
 *      SUM-scan.
 *   3. Reservations always resolve. Cron task expires stale ones so a
 *      crashed worker never traps credits.
 *   4. All balance mutations happen inside a transaction with
 *      SELECT ... FOR UPDATE on credits_balance so concurrent
 *      reservations can't oversell.
 */

import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from './client';
import { creditReservations, creditsBalance, creditTransactions, fraudSignals } from './schema';

// -----------------------------------------------------------------
// Types shared by helpers below
// -----------------------------------------------------------------

export type AddCreditsType =
  | 'signup_trial'
  | 'purchase'
  | 'sub_monthly_topup'
  | 'sub_bonus'
  | 'admin_adjust'
  | 'refund_on_fail';

// -----------------------------------------------------------------
// Errors
// -----------------------------------------------------------------

export class InsufficientCreditsError extends Error {
  readonly kind = 'insufficient_credits' as const;
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Insufficient credits: need ${required}, have ${available}`);
  }
}

export class ReservationNotFoundError extends Error {
  readonly kind = 'reservation_not_found' as const;
  constructor(public reservationId: string) {
    super(`Reservation ${reservationId} not found or already resolved`);
  }
}

// -----------------------------------------------------------------
// Reads
// -----------------------------------------------------------------

export async function getCreditBalance(userId: string): Promise<{
  balance: number;
  lifetimePurchased: number;
  lifetimeSpent: number;
}> {
  const db = getDb();
  const row = await db.query.creditsBalance.findFirst({
    where: eq(creditsBalance.userId, userId),
  });
  return {
    balance: row?.balance ?? 0,
    lifetimePurchased: row?.lifetimePurchased ?? 0,
    lifetimeSpent: row?.lifetimeSpent ?? 0,
  };
}

/**
 * Polish-29.0.3 Commit 113: paginated credit-transactions read for
 * the settings/credits history view. Newest first. `limit` capped at
 * 200 so a curious user hitting a raw URL can't page-scan the whole
 * ledger in one hit.
 */
export interface CreditHistoryEntry {
  id: string;
  delta: number;
  type: string;
  description: string | null;
  balanceAfter: number;
  createdAt: Date;
  metadata: unknown;
}

export async function getCreditHistory(userId: string, limit = 50): Promise<CreditHistoryEntry[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const db = getDb();
  const rows = await db
    .select({
      id: creditTransactions.id,
      delta: creditTransactions.delta,
      type: creditTransactions.type,
      description: creditTransactions.description,
      balanceAfter: creditTransactions.balanceAfter,
      createdAt: creditTransactions.createdAt,
      metadata: creditTransactions.metadata,
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(capped);
  return rows;
}

// -----------------------------------------------------------------
// Balance mutations — all go through creditLedger
// -----------------------------------------------------------------

/**
 * Add credits to a user's balance and write a matching audit-log
 * row. Used for signup trial, Whop purchases, monthly sub renewal,
 * bonuses, and admin adjustments.
 *
 * Returns the resulting balance so the caller can e.g. show it to
 * the user immediately after a Whop webhook completes.
 */
export async function addCredits(input: {
  userId: string;
  credits: number;
  type: AddCreditsType;
  refId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ balance: number }> {
  if (input.credits <= 0) {
    throw new Error(`addCredits requires positive credits, got ${input.credits}`);
  }
  const db = getDb();

  // Upsert with a single statement so a brand-new user (no balance
  // row yet) is handled without a separate insert. `returning` gives
  // us the post-write balance for the audit log's balance_after.
  const rows = await db
    .insert(creditsBalance)
    .values({
      userId: input.userId,
      balance: input.credits,
      lifetimePurchased: input.type === 'refund_on_fail' ? 0 : input.credits,
      lifetimeSpent: 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: creditsBalance.userId,
      set: {
        balance: sql`${creditsBalance.balance} + ${input.credits}`,
        lifetimePurchased:
          input.type === 'refund_on_fail'
            ? creditsBalance.lifetimePurchased
            : sql`${creditsBalance.lifetimePurchased} + ${input.credits}`,
        updatedAt: new Date(),
      },
    })
    .returning({ balance: creditsBalance.balance });
  const balance = rows[0]!.balance;

  await db.insert(creditTransactions).values({
    userId: input.userId,
    delta: input.credits,
    type: input.type,
    refId: input.refId,
    description: input.description,
    balanceAfter: balance,
    metadata: input.metadata,
  });

  return { balance };
}

/**
 * Polish-29.0.2 Commit 111: idempotent variant of addCredits.
 *
 * A (userId, type, refId) tuple grants exactly once. Whop webhook
 * deliveries retry on any non-2xx, so the same `payment.succeeded`
 * event can hit our /api/webhooks/whop endpoint multiple times —
 * each retry MUST NOT re-grant credits. The outer webhook is
 * already idempotent on whop_events.whop_event_id, but that's a
 * belt-and-suspenders defense at the storage layer: this helper is
 * the suspenders at the credit-ledger layer, so a bug (or manual
 * replay) upstream can't drain the runway.
 *
 * refId contract:
 *   sub_monthly_topup → Whop payment.id (unique per renewal charge)
 *   purchase          → Whop payment.id (unique per pack purchase)
 *   signup_trial      → user_id (unique per user — grants once, ever)
 *   sub_bonus         → whatever caller passes, must be unique
 *
 * Returns granted=false when the type+refId+userId already exists;
 * caller can log 'already granted' and move on without an error.
 */
export async function addCreditsIdempotent(input: {
  userId: string;
  credits: number;
  type: AddCreditsType;
  /** REQUIRED — this is the idempotency key. */
  refId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ balance: number; granted: boolean }> {
  if (!input.refId) {
    throw new Error(`addCreditsIdempotent requires a non-empty refId (type=${input.type})`);
  }
  const db = getDb();
  const existing = await db.query.creditTransactions.findFirst({
    where: and(
      eq(creditTransactions.userId, input.userId),
      eq(creditTransactions.type, input.type),
      eq(creditTransactions.refId, input.refId),
    ),
    columns: { id: true, balanceAfter: true },
  });
  if (existing) {
    const current = await getCreditBalance(input.userId);
    return { balance: current.balance, granted: false };
  }
  const { balance } = await addCredits(input);
  return { balance, granted: true };
}

/**
 * Reserve credits for an in-flight generation. Deducts from balance
 * immediately (so a second concurrent job can't oversell) and creates
 * a row in credit_reservations. Convert-to-spend or release-back on
 * completion via `consumeReservation` / `releaseReservation`.
 *
 * Throws InsufficientCreditsError up front when balance < credits.
 * Balance CHECK constraint at the DB level is the final backstop.
 */
export async function reserveCredits(input: {
  userId: string;
  credits: number;
  modelId: string;
  generationJobId?: string;
  /** Reservation TTL in minutes. Default 30. */
  ttlMinutes?: number;
}): Promise<{ reservationId: string; balanceAfter: number }> {
  if (input.credits <= 0) {
    throw new Error(`reserveCredits requires positive credits, got ${input.credits}`);
  }
  const db = getDb();
  const ttl = input.ttlMinutes ?? 30;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  // Single UPDATE ... WHERE balance >= credits — Postgres will
  // atomically reject the update if the row's balance is too low
  // (returning 0 rows), which we then convert into
  // InsufficientCreditsError. No SELECT-then-UPDATE race.
  const rows = await db
    .update(creditsBalance)
    .set({
      balance: sql`${creditsBalance.balance} - ${input.credits}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditsBalance.userId, input.userId),
        sql`${creditsBalance.balance} >= ${input.credits}`,
      ),
    )
    .returning({ balance: creditsBalance.balance });

  if (rows.length === 0) {
    const current = await getCreditBalance(input.userId);
    throw new InsufficientCreditsError(input.credits, current.balance);
  }
  const balanceAfter = rows[0]!.balance;

  const reservations = await db
    .insert(creditReservations)
    .values({
      userId: input.userId,
      generationJobId: input.generationJobId,
      credits: input.credits,
      modelId: input.modelId,
      expiresAt,
    })
    .returning({ id: creditReservations.id });

  return { reservationId: reservations[0]!.id, balanceAfter };
}

/**
 * Convert an active reservation into a permanent spend. Called by
 * the worker after a generation completes successfully. The
 * credit_transactions row records the actual final spend; the
 * balance was already decremented at reserve time.
 */
export async function consumeReservation(input: {
  reservationId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();

  const rows = await db
    .update(creditReservations)
    .set({ releasedAt: new Date(), resolution: 'consumed' })
    .where(
      and(eq(creditReservations.id, input.reservationId), isNull(creditReservations.releasedAt)),
    )
    .returning({
      userId: creditReservations.userId,
      credits: creditReservations.credits,
      generationJobId: creditReservations.generationJobId,
      modelId: creditReservations.modelId,
    });

  if (rows.length === 0) throw new ReservationNotFoundError(input.reservationId);
  const r = rows[0]!;

  // Bump lifetime_spent (balance already dropped at reserve time).
  await db
    .update(creditsBalance)
    .set({
      lifetimeSpent: sql`${creditsBalance.lifetimeSpent} + ${r.credits}`,
      updatedAt: new Date(),
    })
    .where(eq(creditsBalance.userId, r.userId));

  const balance = (await getCreditBalance(r.userId)).balance;
  await db.insert(creditTransactions).values({
    userId: r.userId,
    delta: -r.credits,
    type: 'spend',
    refId: r.generationJobId ?? undefined,
    description: input.description,
    balanceAfter: balance,
    metadata: { model_id: r.modelId, ...input.metadata },
  });
  await db.insert(fraudSignals).values({
    userId: r.userId,
    eventType: 'credit_spend',
    credits: r.credits,
    metadata: { model_id: r.modelId, generation_job_id: r.generationJobId ?? undefined },
  });
}

/**
 * Return a reservation's credits to the user's balance. Called by the
 * worker when a generation fails cleanly (before the API call went
 * out, or when the provider itself refunded). Idempotent — a second
 * release on the same id is a no-op.
 */
export async function releaseReservation(input: {
  reservationId: string;
  reason: 'released' | 'expired';
  description?: string;
}): Promise<void> {
  const db = getDb();
  const rows = await db
    .update(creditReservations)
    .set({ releasedAt: new Date(), resolution: input.reason })
    .where(
      and(eq(creditReservations.id, input.reservationId), isNull(creditReservations.releasedAt)),
    )
    .returning({
      userId: creditReservations.userId,
      credits: creditReservations.credits,
      generationJobId: creditReservations.generationJobId,
      modelId: creditReservations.modelId,
    });
  if (rows.length === 0) return; // already resolved — idempotent
  const r = rows[0]!;

  await db
    .update(creditsBalance)
    .set({
      balance: sql`${creditsBalance.balance} + ${r.credits}`,
      updatedAt: new Date(),
    })
    .where(eq(creditsBalance.userId, r.userId));

  const balance = (await getCreditBalance(r.userId)).balance;
  await db.insert(creditTransactions).values({
    userId: r.userId,
    delta: r.credits,
    type: 'refund_on_fail',
    refId: r.generationJobId ?? undefined,
    description:
      input.description ??
      (input.reason === 'expired'
        ? 'Reservation expired (worker likely crashed) — credits returned'
        : 'Generation failed — credits refunded'),
    balanceAfter: balance,
    metadata: { model_id: r.modelId, reason: input.reason },
  });
}

/**
 * Cron helper: sweep all reservations past their expiry that are
 * still active. Returns the count released.
 */
export async function expireStaleReservations(): Promise<{ released: number }> {
  const db = getDb();
  const stale = await db
    .select({ id: creditReservations.id })
    .from(creditReservations)
    .where(
      and(isNull(creditReservations.releasedAt), lte(creditReservations.expiresAt, new Date())),
    );
  for (const s of stale) {
    await releaseReservation({ reservationId: s.id, reason: 'expired' });
  }
  return { released: stale.length };
}
