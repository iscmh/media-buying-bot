'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  createApiKey,
  getDb,
  listApiKeys,
  logAuditEvent,
  revokeApiKey,
  schema,
  type ApiKeyRow,
} from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Polish-25.10 Commit 59: server actions backing /settings/api.
 *
 * Gate:
 *   users.role = 'admin' OR user_settings.is_founding_member = true
 *
 * TODO(Commit 60): when billing lands, replace this OR-gate with
 *   users.role = 'admin' OR subscriptions.plan_tier = 'scale' OR
 *   user_settings.is_founding_member
 *
 * The action layer enforces the gate defense-in-depth; the page
 * component enforces it too so non-Scale users see the "coming soon"
 * message instead of an empty list.
 */

export interface ApiAccessCheck {
  userId: string;
  hasAccess: boolean;
  reason: 'admin' | 'founding_member' | 'no_access';
}

export async function assertApiAccess(): Promise<ApiAccessCheck> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const db = getDb();
  const [userRow, settingsRow] = await Promise.all([
    db.query.users.findFirst({
      where: eq(schema.users.id, user.id),
      columns: { role: true },
    }),
    db.query.userSettings.findFirst({
      where: eq(schema.userSettings.userId, user.id),
      columns: { isFoundingMember: true },
    }),
  ]);
  if (userRow?.role === 'admin') {
    return { userId: user.id, hasAccess: true, reason: 'admin' };
  }
  if (settingsRow?.isFoundingMember) {
    return { userId: user.id, hasAccess: true, reason: 'founding_member' };
  }
  return { userId: user.id, hasAccess: false, reason: 'no_access' };
}

export interface CreateApiKeyResult {
  ok: boolean;
  errorMessage?: string;
  /** Plaintext token, returned once — the UI must show + never store. */
  plaintext?: string;
  row?: {
    id: string;
    name: string;
    keyPrefix: string;
    createdAt: string;
  };
}

export async function createApiKeyAction(input: { name: string }): Promise<CreateApiKeyResult> {
  const trimmed = input.name.trim();
  if (trimmed.length === 0) {
    return { ok: false, errorMessage: 'Name cannot be empty.' };
  }
  if (trimmed.length > 80) {
    return { ok: false, errorMessage: 'Name capped at 80 characters.' };
  }
  const gate = await assertApiAccess();
  if (!gate.hasAccess) {
    return {
      ok: false,
      errorMessage: 'API access is available on the Scale tier (coming soon).',
    };
  }
  const { row, plaintext } = await createApiKey({ userId: gate.userId, name: trimmed });
  await logAuditEvent({
    userId: gate.userId,
    eventType: 'api_key_created',
    eventData: {
      api_key_id: row.id,
      name: row.name,
      key_prefix: row.keyPrefix,
      _meta: await auditMetaFromHeaders(),
    },
  });
  revalidatePath('/settings/api');
  return {
    ok: true,
    plaintext,
    row: {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export async function revokeApiKeyAction(input: {
  keyId: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const gate = await assertApiAccess();
  if (!gate.hasAccess) {
    return { ok: false, errorMessage: 'API access not available on your tier.' };
  }
  const { revoked } = await revokeApiKey({ userId: gate.userId, keyId: input.keyId });
  if (!revoked) {
    return { ok: false, errorMessage: 'Key not found or already revoked.' };
  }
  await logAuditEvent({
    userId: gate.userId,
    eventType: 'api_key_revoked',
    eventData: {
      api_key_id: input.keyId,
      _meta: await auditMetaFromHeaders(),
    },
  });
  revalidatePath('/settings/api');
  return { ok: true };
}

export interface ApiKeyListRow {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listApiKeysForUser(userId: string): Promise<ApiKeyListRow[]> {
  const rows: ApiKeyRow[] = await listApiKeys(userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.keyPrefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}
