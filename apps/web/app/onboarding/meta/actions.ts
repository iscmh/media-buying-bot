'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { decryptSecret, encryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { MetaSelectionSchema, MetaTokenInputSchema } from '@mbb/shared';
import { listAdAccounts, listBusinesses, verifyMetaToken } from '@/lib/meta/graph-api';
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

  revalidatePath('/onboarding/meta');
  return { ok: true };
}

// ----- list BMs + ad accounts (called from server component, not via form) -----

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

  await db
    .update(schema.metaConnections)
    .set({
      businessManagerId: parsed.data.businessManagerId,
      adAccountIds: parsed.data.adAccountIds,
      status: 'active',
      lastVerifiedAt: new Date(),
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

  revalidatePath('/onboarding/meta');
  redirect('/onboarding/telegram');
}
