'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  checkAdAccountSlotQuota,
  decryptSecret,
  encryptSecret,
  getDb,
  logAuditEvent,
  schema,
} from '@mbb/db';
import { metaMinimumMinor, MetaSelectionSchema, MetaTokenInputSchema } from '@mbb/shared';
import {
  listAdAccounts,
  listBusinesses,
  listUserPages,
  verifyMetaToken,
} from '@/lib/meta/graph-api';
import { isAdAccountSelectable, type AdAccountRow, type BusinessRow } from '@/lib/meta/types';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

// ----- verify token + persist (status=pending) -----

export interface VerifyTokenActionResult {
  ok: boolean;
  errorMessage?: string;
}

export async function verifyMetaTokenAction(formData: FormData): Promise<VerifyTokenActionResult> {
  const parsed = MetaTokenInputSchema.safeParse({
    accessToken: formData.get('accessToken'),
  });
  if (!parsed.success) {
    return { ok: false, errorMessage: parsed.error.issues[0]?.message ?? 'Invalid token format.' };
  }
  const { accessToken } = parsed.data;
  const user = await requireUser();

  const result = await verifyMetaToken(user.id, accessToken);
  if (!result.ok || !result.data) {
    return { ok: false, errorMessage: result.errorMessage };
  }

  const expiresAt =
    result.data.expires_at && result.data.expires_at > 0
      ? new Date(result.data.expires_at * 1000)
      : null;

  const encrypted = await encryptSecret(accessToken);
  const db = getDb();

  // Upsert: one active or pending row per user (we ignore soft-deleted ones).
  const existing = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, user.id),
      isNull(schema.metaConnections.deletedAt),
    ),
    columns: { id: true },
  });

  if (existing) {
    await db
      .update(schema.metaConnections)
      .set({
        accessTokenEncrypted: encrypted,
        fbUserId: result.data.user_id,
        tokenExpiresAt: expiresAt,
        connectionMethod: 'byok',
        status: 'pending',
        lastVerifiedAt: new Date(),
      })
      .where(eq(schema.metaConnections.id, existing.id));
  } else {
    await db.insert(schema.metaConnections).values({
      userId: user.id,
      accessTokenEncrypted: encrypted,
      fbUserId: result.data.user_id,
      tokenExpiresAt: expiresAt,
      connectionMethod: 'byok',
      status: 'pending',
      lastVerifiedAt: new Date(),
    });
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'meta_token_connected',
    eventData: {
      fb_user_id: result.data.user_id,
      app_id: result.data.app_id,
      token_expires_at: expiresAt?.toISOString() ?? null,
      // intentionally NOT logging the token itself.
    },
  });

  revalidatePath('/settings/connections');
  return { ok: true };
}

// ----- list BMs + ad accounts (called from server component, not via form) -----

/**
 * Polish-3.5: helper for selectMetaBusinessAction — fetches the
 * currently-active decrypted access token. Throws if none. Keeps the
 * select-time pages fetch from duplicating the decrypt path.
 */
async function getActiveToken(userId: string): Promise<string> {
  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: { accessTokenEncrypted: true },
  });
  if (!conn?.accessTokenEncrypted) throw new Error('No Meta token on file.');
  return decryptSecret(conn.accessTokenEncrypted);
}

export async function listMetaResources(userId: string): Promise<
  | {
      businesses: BusinessRow[];
      adAccounts: AdAccountRow[];
    }
  | { error: string }
> {
  const db = getDb();
  const conn = await db.query.metaConnections.findFirst({
    where: and(eq(schema.metaConnections.userId, userId), isNull(schema.metaConnections.deletedAt)),
    columns: { accessTokenEncrypted: true },
  });
  if (!conn?.accessTokenEncrypted) {
    return { error: 'No Meta token on file. Paste your token to continue.' };
  }
  let token: string;
  try {
    token = await decryptSecret(conn.accessTokenEncrypted);
  } catch {
    return {
      error:
        'Could not decrypt your stored Meta token. Re-paste it to reconnect (this can happen if the platform vault key was rotated).',
    };
  }

  try {
    const [businesses, adAccounts] = await Promise.all([
      listBusinesses(userId, token),
      listAdAccounts(userId, token),
    ]);
    return { businesses, adAccounts };
  } catch (err) {
    return {
      error: `Meta is not responding to listing requests right now: ${err instanceof Error ? err.message : 'unknown error'}. Try again in a minute.`,
    };
  }
}

// ----- save BM + ad account selection -----

export interface SelectMetaActionResult {
  ok: boolean;
  errorMessage?: string;
}

export async function selectMetaBusinessAction(
  formData: FormData,
): Promise<SelectMetaActionResult> {
  const adAccountIds = formData.getAll('adAccountIds').map(String);
  const parsed = MetaSelectionSchema.safeParse({
    businessManagerId: formData.get('businessManagerId'),
    adAccountIds,
  });
  if (!parsed.success) {
    return {
      ok: false,
      errorMessage: parsed.error.issues[0]?.message ?? 'Invalid selection.',
    };
  }
  const user = await requireUser();
  const db = getDb();

  // Re-verify the chosen ad accounts are actually selectable + scoped to chosen BM.
  const resources = await listMetaResources(user.id);
  if ('error' in resources) {
    return { ok: false, errorMessage: resources.error };
  }
  const bmExists = resources.businesses.some((b) => b.id === parsed.data.businessManagerId);
  if (!bmExists) {
    return {
      ok: false,
      errorMessage: 'That Business Manager is not visible on your token. Refresh and try again.',
    };
  }
  for (const aaId of parsed.data.adAccountIds) {
    const aa = resources.adAccounts.find((a) => a.id === aaId);
    if (!aa) {
      return {
        ok: false,
        errorMessage: `Ad account ${aaId} is not visible on your token. Refresh and try again.`,
      };
    }
    if (aa.business?.id !== parsed.data.businessManagerId) {
      return {
        ok: false,
        errorMessage: `Ad account ${aa.name} is not under the selected Business Manager.`,
      };
    }
    if (!isAdAccountSelectable(aa.account_status)) {
      return {
        ok: false,
        errorMessage: `Ad account ${aa.name} is not active and cannot be selected.`,
      };
    }
  }

  // Phase 8: ad-account-slot quota. Default entitlement is 1 slot;
  // add-on Whop purchases bump it. Don't let a 2nd+ ad-account land
  // if the user hasn't paid for the extra slot. Because this code
  // OVERWRITES adAccountIds on the user's single meta_connections
  // row, the post-write total equals the selection length — compare
  // directly against the limit rather than using helper.allowed
  // (which would double-count the current row).
  const quota = await checkAdAccountSlotQuota({ userId: user.id });
  if (parsed.data.adAccountIds.length > quota.limit) {
    return {
      ok: false,
      errorMessage: `You've selected ${parsed.data.adAccountIds.length} ad accounts but your plan includes ${quota.limit}. Add the $49/mo per-ad-account slot at whop.com/orders to connect more.`,
    };
  }

  // Polish-3.5: capture account currency / tz / min-budget + page list at
  // selection time. Currency drives launch-time USD→account conversion;
  // pages let the launch path validate the user-picked page id without
  // re-hitting /me/accounts.
  const primaryAccount = resources.adAccounts.find((a) => a.id === parsed.data.adAccountIds[0]);
  const accountCurrency = primaryAccount?.currency ?? null;
  const accountTimezone = primaryAccount?.timezone_name ?? null;
  const minDailyBudgetMinor = accountCurrency ? metaMinimumMinor(accountCurrency) : null;

  let pagesPayload: Array<{ id: string; name: string; accessToken?: string; tasks?: string[] }> =
    [];
  try {
    // Pull pages with the same token used for the listing flow; if it
    // fails, we don't block selection — launch path will surface a
    // clearer error than Meta's "Invalid parameter".
    const fetched = await listUserPages(user.id, await getActiveToken(user.id));
    pagesPayload = fetched.map((p) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      tasks: p.tasks,
    }));
  } catch {
    // Swallow — non-blocking. The launch dialog already has a Refresh
    // Pages button that retries this call.
  }

  await db
    .update(schema.metaConnections)
    .set({
      businessManagerId: parsed.data.businessManagerId,
      adAccountIds: parsed.data.adAccountIds,
      status: 'active',
      lastVerifiedAt: new Date(),
      accountCurrency,
      accountTimezone,
      minDailyBudgetMinor,
      pages: pagesPayload,
    })
    .where(
      and(eq(schema.metaConnections.userId, user.id), isNull(schema.metaConnections.deletedAt)),
    );

  const bmName = resources.businesses.find((b) => b.id === parsed.data.businessManagerId)?.name;
  await logAuditEvent({
    userId: user.id,
    eventType: 'meta_bm_selected',
    eventData: {
      bm_id: parsed.data.businessManagerId,
      bm_name: bmName ?? null,
      ad_account_count: parsed.data.adAccountIds.length,
      ad_account_ids: parsed.data.adAccountIds,
    },
  });

  revalidatePath('/settings/connections');
  // Polish-25.2 Commit 13: after Meta selection completes, land the
  // user back on the Meta tab (they'll see the connected summary).
  // Telegram was a required onboarding step pre-Commit-10a; it's
  // now opt-in and reachable from the Telegram tab.
  redirect('/settings/connections?tab=meta');
}
