import 'server-only';

/**
 * Phase 8: thin Whop API client for the two endpoints we hit today.
 *
 *   createPaymentLink — admin approves an application, we generate the
 *                       Whop checkout URL for the chosen tier.
 *   getMembership     — webhook arrives with just a membership_id;
 *                       fetch the full record to read product_id +
 *                       email + period dates.
 *
 * Returns discriminated results so the caller (admin action / webhook
 * handler) can branch cleanly on misconfiguration without try/catch
 * scaffolding everywhere.
 */

const WHOP_API_BASE = 'https://api.whop.com/v2';
const TIMEOUT_MS = 10_000;

export type WhopPlanTier = 'monthly' | 'annual' | 'lifetime';
export type WhopMembershipStatus = 'active' | 'past_due' | 'canceled' | 'expired';

export interface CreatePaymentLinkInput {
  productId: string;
  customerEmail?: string;
  /** Forwarded to webhook payloads so we can link back to the inviter. */
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentLinkResult {
  ok: boolean;
  url?: string;
  paymentLinkId?: string;
  errorMessage?: string;
}

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
): Promise<CreatePaymentLinkResult> {
  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    return { ok: false, errorMessage: 'WHOP_API_KEY not configured' };
  }
  try {
    const res = await fetch(`${WHOP_API_BASE}/payment_links`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: input.productId,
        customer_email: input.customerEmail,
        metadata: input.metadata ?? {},
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as {
      url?: string;
      payment_link_id?: string;
      id?: string;
      message?: string;
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        errorMessage: json?.message ?? `Whop returned HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      url: json?.url,
      // Whop responses sometimes use `id`, sometimes `payment_link_id` —
      // accept either so a future API rev doesn't break us.
      paymentLinkId: json?.payment_link_id ?? json?.id,
    };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface WhopMembershipSummary {
  id: string;
  status: WhopMembershipStatus;
  productId: string;
  email: string | null;
  whopUserId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, unknown>;
}

export interface GetMembershipResult {
  ok: boolean;
  membership?: WhopMembershipSummary;
  errorMessage?: string;
}

export async function getMembership(membershipId: string): Promise<GetMembershipResult> {
  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey) {
    return { ok: false, errorMessage: 'WHOP_API_KEY not configured' };
  }
  try {
    const res = await fetch(`${WHOP_API_BASE}/memberships/${encodeURIComponent(membershipId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        ok: false,
        errorMessage: (json?.message as string) ?? `Whop returned HTTP ${res.status}`,
      };
    }
    return { ok: true, membership: parseMembership(json) };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Normalize a Whop membership payload (either GET /memberships/:id or
 * the embedded version on a webhook event) into our internal shape.
 * Exported so the webhook handler can reuse the parse without an
 * extra API roundtrip.
 */
export function parseMembership(raw: unknown): WhopMembershipSummary {
  if (!raw || typeof raw !== 'object') {
    return blankMembership();
  }
  const r = raw as Record<string, unknown>;
  // Whop has used both `product_id` and a nested `product.id` over the
  // years; accept both.
  const productId =
    (typeof r.product_id === 'string' && r.product_id) ||
    (typeof (r.product as { id?: string } | undefined)?.id === 'string' &&
      (r.product as { id: string }).id) ||
    '';
  const user = (r.user as { id?: string; email?: string } | undefined) ?? {};

  return {
    id: typeof r.id === 'string' ? r.id : '',
    status: normalizeStatus(r.status),
    productId,
    email: typeof user.email === 'string' ? user.email : null,
    whopUserId: typeof user.id === 'string' ? user.id : null,
    currentPeriodStart: dateFrom(r.current_period_start ?? r.renewal_period_start),
    currentPeriodEnd: dateFrom(r.current_period_end ?? r.renewal_period_end ?? r.expires_at),
    cancelAtPeriodEnd: r.cancel_at_period_end === true,
    metadata: (r.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

function blankMembership(): WhopMembershipSummary {
  return {
    id: '',
    status: 'expired',
    productId: '',
    email: null,
    whopUserId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    metadata: {},
  };
}

function normalizeStatus(value: unknown): WhopMembershipStatus {
  const s = typeof value === 'string' ? value.toLowerCase() : '';
  if (s === 'active' || s === 'completed' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  return 'expired';
}

function dateFrom(value: unknown): Date | null {
  if (typeof value === 'number') {
    // Whop sometimes returns seconds, sometimes ms. >2099 in seconds is
    // larger than 4e9; treat anything < 1e12 as seconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms);
  }
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Phase 8: map a Whop product_id to one of our tier strings. Returns
 * null if it doesn't match any configured product (likely the add-on
 * product — caller branches on that separately).
 */
export function productIdToPlanTier(productId: string): WhopPlanTier | null {
  if (productId === process.env.WHOP_PRODUCT_ID_MONTHLY) return 'monthly';
  if (productId === process.env.WHOP_PRODUCT_ID_ANNUAL) return 'annual';
  if (productId === process.env.WHOP_PRODUCT_ID_LIFETIME) return 'lifetime';
  return null;
}

export function isAddOnAdAccountProduct(productId: string): boolean {
  return productId === process.env.WHOP_ADDON_PRODUCT_ID_AD_ACCOUNT;
}
