import { and, desc, eq } from 'drizzle-orm';
import { getDb } from './client';
import { entitlements } from './schema/whop';
import { userSettings } from './schema/settings';
import { subscriptions } from './schema/whop';

/**
 * Phase 8 subscription gate.
 *
 * Founding members (Phase 7 grandfathered tier) bypass billing forever
 * — they got perpetual access in exchange for being early. Everyone
 * else needs an `active` subscription row.
 *
 * `past_due` is treated as no-access on purpose: the user's renewal
 * failed and they need to fix payment before they get back in. Whop
 * will emit `payment_failed` → status=past_due, then either
 * `payment_succeeded` → back to active OR `membership_went_invalid` →
 * expired.
 */

export type SubscriptionGateReason =
  | 'founding_member'
  | 'active'
  | 'no_subscription'
  | 'past_due'
  | 'canceled'
  | 'expired';

export interface SubscriptionGateResult {
  hasAccess: boolean;
  reason: SubscriptionGateReason;
  isFoundingMember: boolean;
  plan?: 'monthly' | 'annual' | 'lifetime';
  currentPeriodEnd?: Date | null;
}

export async function checkActiveSubscription(userId: string): Promise<SubscriptionGateResult> {
  const db = getDb();

  // 1. Founding-member bypass.
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { isFoundingMember: true },
  });
  if (settings?.isFoundingMember) {
    return { hasAccess: true, reason: 'founding_member', isFoundingMember: true };
  }

  // 2. Most recent subscription row.
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
    orderBy: desc(subscriptions.createdAt),
    columns: {
      status: true,
      planTier: true,
      currentPeriodEnd: true,
    },
  });

  if (!sub) {
    return { hasAccess: false, reason: 'no_subscription', isFoundingMember: false };
  }
  const planTier = sub.planTier as 'monthly' | 'annual' | 'lifetime' | undefined;
  if (sub.status === 'active') {
    return {
      hasAccess: true,
      reason: 'active',
      isFoundingMember: false,
      plan: planTier,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }
  // Map every non-active status to a no-access result with a reason
  // tag the paywall UI can render specific copy for.
  return {
    hasAccess: false,
    reason:
      sub.status === 'past_due' ? 'past_due' : sub.status === 'canceled' ? 'canceled' : 'expired',
    isFoundingMember: false,
    plan: planTier,
    currentPeriodEnd: sub.currentPeriodEnd,
  };
}

// =========================================================================
// Add-on quotas
// =========================================================================

export interface QuotaResult {
  used: number;
  limit: number;
  allowed: boolean;
}

/**
 * Phase 8: how many ad accounts the user has connected vs how many
 * slots they've paid for. Used by the Meta-connect server action +
 * the settings billing card.
 *
 * Counts ad_account_ids[] entries across active meta_connections
 * rows — one connection can authorize multiple ad accounts. The
 * default entitlement is 1 (no add-on purchased); each successful
 * Whop add-on webhook bumps it by 1.
 */
export async function checkAdAccountSlotQuota(input: {
  userId: string;
  /** How many additional ad accounts the caller wants to add. */
  adding?: number;
}): Promise<QuotaResult> {
  const adding = input.adding ?? 0;
  const db = getDb();
  const entRow = await db.query.entitlements.findFirst({
    where: eq(entitlements.userId, input.userId),
    columns: { adAccountSlots: true },
  });
  const limit = entRow?.adAccountSlots ?? 1;

  // The schema module name collides with this file; import locally to
  // avoid a circular import surface in the package.
  const { metaConnections } = await import('./schema/connections');
  const rows = await db
    .select({ adAccountIds: metaConnections.adAccountIds })
    .from(metaConnections)
    .where(and(eq(metaConnections.userId, input.userId), eq(metaConnections.status, 'active')));
  const used = rows.reduce((sum, r) => sum + (r.adAccountIds?.length ?? 0), 0);

  return { used, limit, allowed: used + adding <= limit };
}
