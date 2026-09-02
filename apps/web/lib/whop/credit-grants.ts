import 'server-only';

import { CREDIT_TOPUP_PACKS, PRO_INCLUDED_CREDITS, SIGNUP_FREE_TRIAL_CREDITS } from '@mbb/shared';
import { addCreditsIdempotent } from '@mbb/db';

/**
 * Polish-29.0.2 Commit 111: Whop → credits grant helpers.
 *
 * These wrap `addCreditsIdempotent` with Whop-specific idempotency
 * keys (payment.id for renewals + top-ups, user.id for signup trial).
 * Every function no-ops safely on a retry — the outer webhook is
 * already idempotent on whop_events.whop_event_id, but a manual
 * replay or a code bug upstream must never drain the runway.
 *
 * Env mapping (add to Vercel):
 *   WHOP_PRODUCT_ID_MONTHLY      → PRO subscription (already used
 *                                   for tier resolution in client.ts).
 *                                   Grants PRO_INCLUDED_CREDITS on
 *                                   each payment.succeeded.
 *   WHOP_PRODUCT_ID_TOPUP_500    → +500 credits
 *   WHOP_PRODUCT_ID_TOPUP_2500   → +2,500 credits
 *   WHOP_PRODUCT_ID_TOPUP_10000  → +10,000 credits + 2,500 bonus
 *
 * The top-up SKUs match the pack shape in credit-pricing.ts —
 * changes to that catalog cascade here at type-check time via the
 * shared imports.
 */

// -----------------------------------------------------------------
// Product-id → grant amount resolution
// -----------------------------------------------------------------

export interface TopupPackMatch {
  sku: string;
  credits: number;
  bonusCredits: number;
  label: string;
}

/**
 * Look up which top-up pack a Whop product_id corresponds to.
 * Returns null when the product isn't a top-up pack (i.e. it's a
 * subscription or an unknown SKU).
 */
export function resolveTopupPackForProductId(productId: string): TopupPackMatch | null {
  const map: Record<string, string | undefined> = {
    'credits-500': process.env['WHOP_PRODUCT_ID_TOPUP_500'],
    'credits-2500': process.env['WHOP_PRODUCT_ID_TOPUP_2500'],
    'credits-10000': process.env['WHOP_PRODUCT_ID_TOPUP_10000'],
  };
  for (const pack of CREDIT_TOPUP_PACKS) {
    if (map[pack.sku] && map[pack.sku] === productId) {
      return {
        sku: pack.sku,
        credits: pack.credits,
        bonusCredits: pack.bonusCredits,
        label: pack.label,
      };
    }
  }
  return null;
}

/**
 * Is this product ID our PRO subscription? Reused by the webhook to
 * decide whether payment.succeeded → grant monthly PRO credits.
 */
export function isProSubscriptionProduct(productId: string): boolean {
  const monthly = process.env['WHOP_PRODUCT_ID_MONTHLY'];
  const annual = process.env['WHOP_PRODUCT_ID_ANNUAL'];
  const lifetime = process.env['WHOP_PRODUCT_ID_LIFETIME'];
  return (
    (Boolean(monthly) && productId === monthly) ||
    (Boolean(annual) && productId === annual) ||
    (Boolean(lifetime) && productId === lifetime)
  );
}

// -----------------------------------------------------------------
// Grant helpers — each one keyed on a Whop-side unique id
// -----------------------------------------------------------------

export interface GrantResult {
  balance: number;
  granted: boolean;
  credits: number;
  reason: string;
}

/**
 * Grant the free-trial credits on first signup. Keyed on user_id, so
 * a re-invocation (login callback firing more than once) never
 * double-grants.
 */
export async function grantSignupTrial(userId: string): Promise<GrantResult> {
  const res = await addCreditsIdempotent({
    userId,
    credits: SIGNUP_FREE_TRIAL_CREDITS,
    type: 'signup_trial',
    refId: userId,
    description: `Welcome — ${SIGNUP_FREE_TRIAL_CREDITS} free credits to try out the app.`,
    metadata: { source: 'signup_trial' },
  });
  return {
    balance: res.balance,
    granted: res.granted,
    credits: res.granted ? SIGNUP_FREE_TRIAL_CREDITS : 0,
    reason: res.granted ? 'signup_trial_granted' : 'signup_trial_already_granted',
  };
}

/**
 * Grant the monthly PRO credits on a paid subscription charge. Keyed
 * on the Whop payment.id so both the initial charge and every renewal
 * grant fresh credits (each payment has its own id), but a duplicate
 * webhook delivery for the SAME payment doesn't double-grant.
 */
export async function grantProMonthlyForPayment(input: {
  userId: string;
  whopPaymentId: string;
  whopMembershipId: string | null;
  whopProductId: string;
}): Promise<GrantResult> {
  const res = await addCreditsIdempotent({
    userId: input.userId,
    credits: PRO_INCLUDED_CREDITS,
    type: 'sub_monthly_topup',
    refId: input.whopPaymentId,
    description: `PRO plan credits: ${PRO_INCLUDED_CREDITS} added.`,
    metadata: {
      whop_payment_id: input.whopPaymentId,
      whop_membership_id: input.whopMembershipId,
      whop_product_id: input.whopProductId,
      source: 'whop_pro_renewal',
    },
  });
  return {
    balance: res.balance,
    granted: res.granted,
    credits: res.granted ? PRO_INCLUDED_CREDITS : 0,
    reason: res.granted ? 'pro_credits_granted' : 'pro_credits_already_granted_for_payment',
  };
}

/**
 * Grant top-up pack credits (500/2500/10000+bonus) on a one-off
 * payment.succeeded event. Bonus credits ride the same transaction
 * type ('purchase') but a separate 'sub_bonus' row so lifetime-value
 * reporting stays accurate.
 */
export async function grantTopupPackForPayment(input: {
  userId: string;
  whopPaymentId: string;
  pack: TopupPackMatch;
}): Promise<{
  base: GrantResult;
  bonus: GrantResult | null;
}> {
  const base = await addCreditsIdempotent({
    userId: input.userId,
    credits: input.pack.credits,
    type: 'purchase',
    refId: input.whopPaymentId,
    description: `Top-up: ${input.pack.label} (${input.pack.credits} credits).`,
    metadata: {
      whop_payment_id: input.whopPaymentId,
      pack_sku: input.pack.sku,
      source: 'whop_topup_pack',
    },
  });

  let bonus: GrantResult | null = null;
  if (input.pack.bonusCredits > 0) {
    const b = await addCreditsIdempotent({
      userId: input.userId,
      credits: input.pack.bonusCredits,
      type: 'sub_bonus',
      // Suffix so the bonus row has its own idempotency key —
      // otherwise the second addCreditsIdempotent call would see the
      // 'purchase' row and no-op, blocking the bonus from ever landing.
      refId: `${input.whopPaymentId}:bonus`,
      description: `Volume bonus: +${input.pack.bonusCredits} credits.`,
      metadata: {
        whop_payment_id: input.whopPaymentId,
        pack_sku: input.pack.sku,
        source: 'whop_topup_pack_bonus',
      },
    });
    bonus = {
      balance: b.balance,
      granted: b.granted,
      credits: b.granted ? input.pack.bonusCredits : 0,
      reason: b.granted ? 'bonus_granted' : 'bonus_already_granted_for_payment',
    };
  }
  return {
    base: {
      balance: base.balance,
      granted: base.granted,
      credits: base.granted ? input.pack.credits : 0,
      reason: base.granted ? 'topup_granted' : 'topup_already_granted_for_payment',
    },
    bonus,
  };
}
