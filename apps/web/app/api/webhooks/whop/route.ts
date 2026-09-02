import { eq, sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb, schema } from '@mbb/db';

// Polish-5: Whop dispatches can fan out to several DB writes
// (subscriptions + entitlements + applications). 60s gives plenty of
// headroom; dynamic disables Next caching for the POST handler.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
import {
  isAddOnAdAccountProduct,
  parseMembership,
  productIdToPlanTier,
  type WhopMembershipSummary,
} from '@/lib/whop/client';
import {
  grantProMonthlyForPayment,
  grantTopupPackForPayment,
  isProSubscriptionProduct,
  resolveTopupPackForProductId,
} from '@/lib/whop/credit-grants';
import { verifyWhopSignature } from '@/lib/whop/signature';

/**
 * Phase 8: Whop webhook receiver.
 *
 * Contract:
 *   1. Read raw body (don't trust pre-parsed JSON — signature is over
 *      the exact byte stream Whop signed).
 *   2. Verify HMAC-SHA256 against WHOP_WEBHOOK_SECRET. Failure → 401,
 *      still log to whop_events with signature_valid=false (forensic
 *      breadcrumb).
 *   3. Idempotency: INSERT whop_events ON CONFLICT (whop_event_id) DO
 *      NOTHING. If a row already existed, skip processing — Whop
 *      retries duplicates on the same id.
 *   4. Dispatch by event_type. Each branch is best-effort:
 *      membership_went_valid   → upsert subscriptions / entitlements
 *      membership_went_invalid → mark subscription expired / decrement
 *                                add-on slots
 *      payment_succeeded       → mark applications.status='paid' (link
 *                                back to the original application
 *                                row via metadata.application_id)
 *      payment_failed          → mark subscription past_due
 *   5. Stamp processed_at + (on error) error_message. Always return
 *      200 once the event is logged — Whop interprets non-2xx as
 *      "retry forever".
 */

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signatureHeader = req.headers.get('x-whop-signature');
  const signatureValid = verifyWhopSignature(rawBody, signatureHeader);

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Body wasn't JSON — log a synthetic row + return 400.
    await logRejected({
      whopEventId: `non_json_${Date.now()}_${cryptoSafeId()}`,
      eventType: 'non_json',
      payload: { _raw: rawBody.slice(0, 1024) },
      signatureValid: false,
      errorMessage: 'Body was not JSON',
    });
    return new NextResponse('invalid body', { status: 400 });
  }

  const eventId =
    (typeof parsed.id === 'string' && parsed.id) ||
    (typeof (parsed.event as { id?: string } | undefined)?.id === 'string' &&
      (parsed.event as { id: string }).id) ||
    // Last-resort synthetic id so we still log probes that lack one.
    `synthetic_${Date.now()}_${cryptoSafeId()}`;
  const eventType =
    (typeof parsed.event === 'string' && parsed.event) ||
    (typeof parsed.type === 'string' && parsed.type) ||
    'unknown';

  if (!signatureValid) {
    await logRejected({
      whopEventId: eventId,
      eventType,
      payload: parsed,
      signatureValid: false,
      errorMessage: 'invalid signature',
    });
    return new NextResponse('invalid signature', { status: 401 });
  }

  // Idempotent insert. Drizzle's ON CONFLICT DO NOTHING + returning
  // tells us whether THIS request was the first to log the event.
  const db = getDb();
  const [inserted] = await db
    .insert(schema.whopEvents)
    .values({
      whopEventId: eventId,
      eventType,
      payload: parsed,
      signatureValid: true,
    })
    .onConflictDoNothing({ target: schema.whopEvents.whopEventId })
    .returning({ id: schema.whopEvents.id });

  if (!inserted) {
    // Duplicate delivery — log already exists from a prior request.
    return new NextResponse('ok (duplicate)', { status: 200 });
  }

  try {
    await dispatchEvent(eventType, parsed);
    await db
      .update(schema.whopEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.whopEvents.id, inserted.id));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.whopEvents)
      .set({ processedAt: new Date(), errorMessage })
      .where(eq(schema.whopEvents.id, inserted.id));
    // Return 200 anyway — the event is logged + we don't want Whop's
    // retry-on-non-2xx to repeat indefinitely. Operator triages via
    // whop_events.error_message.
  }
  return new NextResponse('ok', { status: 200 });
}

// =========================================================================
// Dispatch
// =========================================================================

async function dispatchEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  // Whop nests the payload under .data on most event types.
  const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
  const membership = parseMembership(data);

  switch (eventType) {
    case 'membership.went_valid':
    case 'membership_went_valid':
      await handleMembershipValid(membership);
      return;

    case 'membership.went_invalid':
    case 'membership_went_invalid':
      await handleMembershipInvalid(membership);
      return;

    case 'payment.succeeded':
    case 'payment_succeeded':
      await handlePaymentSucceeded(data, membership);
      return;

    case 'payment.failed':
    case 'payment_failed':
      await handlePaymentFailed(membership);
      return;

    default:
      // Logged + processed_at stamped; nothing actionable for unknown
      // event types. Add a case here when Whop ships a new one.
      return;
  }
}

async function handleMembershipValid(m: WhopMembershipSummary): Promise<void> {
  if (!m.id || !m.productId) return;

  // Add-on slot: doesn't create a subscription row, just bumps quota.
  if (isAddOnAdAccountProduct(m.productId)) {
    await bumpAdAccountSlots(m, +1);
    return;
  }

  const planTier = productIdToPlanTier(m.productId);
  if (!planTier) return; // unknown product — ignore

  const db = getDb();
  const userId = await lookupUserIdByEmail(m.email);
  const inviteCodeIdFromMeta =
    typeof m.metadata.invite_code_id === 'string' && m.metadata.invite_code_id.length > 0
      ? (m.metadata.invite_code_id as string)
      : null;

  await db
    .insert(schema.subscriptions)
    .values({
      userId: userId ?? null,
      pendingEmail: userId ? null : (m.email ?? null),
      whopMembershipId: m.id,
      whopUserId: m.whopUserId,
      whopProductId: m.productId,
      planTier,
      status: 'active',
      currentPeriodStart: m.currentPeriodStart,
      currentPeriodEnd: m.currentPeriodEnd,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd,
      inviteCodeId: inviteCodeIdFromMeta,
    })
    .onConflictDoUpdate({
      target: schema.subscriptions.whopMembershipId,
      set: {
        userId: userId ?? null,
        pendingEmail: userId ? null : (m.email ?? null),
        status: 'active',
        whopProductId: m.productId,
        currentPeriodStart: m.currentPeriodStart,
        currentPeriodEnd: m.currentPeriodEnd,
        cancelAtPeriodEnd: m.cancelAtPeriodEnd,
        canceledAt: null,
      },
    });
}

async function handleMembershipInvalid(m: WhopMembershipSummary): Promise<void> {
  if (!m.id) return;
  if (isAddOnAdAccountProduct(m.productId)) {
    await bumpAdAccountSlots(m, -1);
    return;
  }
  const db = getDb();
  await db
    .update(schema.subscriptions)
    .set({
      status: m.status === 'canceled' ? 'canceled' : 'expired',
      canceledAt: m.status === 'canceled' ? new Date() : null,
    })
    .where(eq(schema.subscriptions.whopMembershipId, m.id));
}

async function handlePaymentSucceeded(
  data: Record<string, unknown>,
  m: WhopMembershipSummary,
): Promise<void> {
  // application_id rides in metadata when we created the payment link
  // from the admin approval flow. Use it to mark the application paid.
  const appId =
    typeof m.metadata.application_id === 'string' ? (m.metadata.application_id as string) : null;
  if (appId) {
    const db = getDb();
    await db
      .update(schema.applications)
      .set({ status: 'paid', paidAt: new Date() })
      .where(eq(schema.applications.id, appId));
  }

  // Polish-29.0.2 Commit 111: credit grants triggered by payment.
  // Whop pattern:
  //   - initial signup: one membership.went_valid + one payment.succeeded
  //     for the same charge (both fire; we grant on payment).
  //   - monthly renewal: only payment.succeeded fires; new payment.id.
  //   - top-up pack purchase: one payment.succeeded with the pack's
  //     product_id; no membership.
  //
  // Payment id is the idempotency key so retries + parallel handlers
  // never double-grant. userId is resolved by joining membership.email
  // → users.email; if the user hasn't signed up yet the credits are
  // deferred (subscription row keeps pending_email; user reconciles
  // when they later sign up — followup ticket).
  const payment = extractPayment(data);
  if (!payment.id || !payment.productId) return;

  const userId = await lookupUserIdByEmail(m.email);
  if (!userId) {
    // No user yet. Log-level warning at most; the sub row will carry
    // pending_email so we can reconcile on signup.
    return;
  }

  if (isProSubscriptionProduct(payment.productId)) {
    await grantProMonthlyForPayment({
      userId,
      whopPaymentId: payment.id,
      whopMembershipId: m.id || null,
      whopProductId: payment.productId,
    });
    return;
  }

  const pack = resolveTopupPackForProductId(payment.productId);
  if (pack) {
    await grantTopupPackForPayment({
      userId,
      whopPaymentId: payment.id,
      pack,
    });
    return;
  }
  // Unknown product — payment landed but we don't grant. Operator
  // can hand-adjust with admin_adjust if legit.
}

/**
 * Pull the payment id + product id out of a Whop payment.succeeded
 * payload. Whop's schema has shifted between versions; accept a few
 * common shapes so a future rev doesn't silently break credit grants.
 */
function extractPayment(data: Record<string, unknown>): {
  id: string | null;
  productId: string | null;
} {
  const id =
    (typeof data.id === 'string' && data.id) ||
    (typeof (data.payment as { id?: string } | undefined)?.id === 'string' &&
      (data.payment as { id: string }).id) ||
    (typeof data.payment_id === 'string' && data.payment_id) ||
    null;
  const productId =
    (typeof data.product_id === 'string' && data.product_id) ||
    (typeof (data.product as { id?: string } | undefined)?.id === 'string' &&
      (data.product as { id: string }).id) ||
    (typeof (data.plan as { product_id?: string } | undefined)?.product_id === 'string' &&
      (data.plan as { product_id: string }).product_id) ||
    null;
  return { id, productId };
}

async function handlePaymentFailed(m: WhopMembershipSummary): Promise<void> {
  if (!m.id) return;
  const db = getDb();
  await db
    .update(schema.subscriptions)
    .set({ status: 'past_due' })
    .where(eq(schema.subscriptions.whopMembershipId, m.id));
}

// =========================================================================
// Helpers
// =========================================================================

async function lookupUserIdByEmail(email: string | null): Promise<string | null> {
  if (!email) return null;
  const db = getDb();
  const row = await db.query.users.findFirst({
    where: eq(sql`lower(${schema.users.email})`, email.toLowerCase()),
    columns: { id: true },
  });
  return row?.id ?? null;
}

async function bumpAdAccountSlots(m: WhopMembershipSummary, delta: number): Promise<void> {
  const userId = await lookupUserIdByEmail(m.email);
  if (!userId) return;
  const db = getDb();
  // UPSERT: if no entitlements row yet, seed at 1 (the default) +
  // delta. Otherwise increment in place, clamping at 0 from below.
  await db
    .insert(schema.entitlements)
    .values({ userId, adAccountSlots: Math.max(0, 1 + delta) })
    .onConflictDoUpdate({
      target: schema.entitlements.userId,
      set: {
        adAccountSlots: sql`greatest(${schema.entitlements.adAccountSlots} + ${delta}, 0)`,
      },
    });
}

async function logRejected(input: {
  whopEventId: string;
  eventType: string;
  payload: unknown;
  signatureValid: boolean;
  errorMessage: string;
}): Promise<void> {
  try {
    const db = getDb();
    await db
      .insert(schema.whopEvents)
      .values({
        whopEventId: input.whopEventId,
        eventType: input.eventType,
        payload: input.payload as Record<string, unknown>,
        signatureValid: input.signatureValid,
        errorMessage: input.errorMessage,
      })
      .onConflictDoNothing({ target: schema.whopEvents.whopEventId });
  } catch (err) {
    // Don't crash the request because audit logging failed.
    console.error('[whop-webhook] logRejected failed', err);
  }
}

function cryptoSafeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
