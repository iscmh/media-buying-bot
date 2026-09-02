'use server';

import { redirect } from 'next/navigation';
import { CREDIT_TOPUP_PACKS } from '@mbb/shared';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { createPaymentLink } from '@/lib/whop/client';

/**
 * Polish-29.0.3 Commit 113: server action wiring the top-up buttons
 * on /settings/credits to Whop's hosted checkout.
 *
 * Flow:
 *   1. User clicks a pack button ("Buy 2,500 credits — $50").
 *   2. This action resolves the pack sku → Whop product id (env-mapped),
 *      calls createPaymentLink with the authenticated user's email +
 *      metadata (source, user_id, pack_sku), and redirects to the URL.
 *   3. Whop hosts the checkout; on success their webhook fires
 *      payment.succeeded, our /api/webhooks/whop handler resolves the
 *      product id back to the pack, and grants credits via
 *      grantTopupPackForPayment (Commit 111).
 *
 * If a pack's env var isn't set yet (op hasn't wired the SKU in Whop's
 * dashboard), we return a form-friendly error string instead of throwing —
 * the button will show it inline and the user isn't stranded on a broken
 * redirect.
 */

export interface StartTopupResult {
  ok: boolean;
  errorMessage?: string;
}

export async function startTopupCheckout(sku: string): Promise<StartTopupResult> {
  const pack = CREDIT_TOPUP_PACKS.find((p) => p.sku === sku);
  if (!pack) {
    return { ok: false, errorMessage: `Unknown top-up pack: ${sku}` };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return { ok: false, errorMessage: 'Please sign in again — session expired.' };
  }

  const productId = productIdForPackSku(sku);
  if (!productId) {
    return {
      ok: false,
      errorMessage: `Top-up pack ${sku} is not configured yet. An admin needs to set the WHOP_PRODUCT_ID_TOPUP_* env var and create the corresponding product in Whop.`,
    };
  }

  const link = await createPaymentLink({
    productId,
    customerEmail: user.email,
    metadata: {
      source: 'topup_checkout',
      user_id: user.id,
      pack_sku: sku,
    },
  });

  if (!link.ok || !link.url) {
    return {
      ok: false,
      errorMessage: link.errorMessage ?? 'Failed to create Whop payment link.',
    };
  }

  // Redirect throws internally — the ok:true return is only reached
  // in tests / when a mock swallows the redirect.
  redirect(link.url);
}

function productIdForPackSku(sku: string): string | null {
  switch (sku) {
    case 'credits-500':
      return process.env['WHOP_PRODUCT_ID_TOPUP_500'] ?? null;
    case 'credits-2500':
      return process.env['WHOP_PRODUCT_ID_TOPUP_2500'] ?? null;
    case 'credits-10000':
      return process.env['WHOP_PRODUCT_ID_TOPUP_10000'] ?? null;
    default:
      return null;
  }
}
