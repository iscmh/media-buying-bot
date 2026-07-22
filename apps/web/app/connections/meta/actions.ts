'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cascadePauseUser, decryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { revokeMetaToken } from '@/lib/meta/graph-api';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Disconnect Meta. Order matters:
 *
 *   1. Decrypt the stored token.
 *   2. Best-effort revoke via DELETE /me/permissions (logs to
 *      meta_api_call_logs whether it succeeds or fails).
 *   3. Soft-delete the meta_connections row.
 *   4. Cascade-pause the user (sets is_paused, writes pause log).
 *   5. Audit log meta_disconnected with revoke status.
 *   6. Redirect to /settings/connections?tab=meta — the gate will land them in the
 *      paste form sub-state.
 *
 * If revoke fails, we still proceed. The token expires in ≤60 days; the
 * extra exposure window is the cost of a graceful disconnect.
 */
export async function disconnectMetaAction(): Promise<void> {
  const user = await requireUser();
  const db = getDb();

  const conn = await db.query.metaConnections.findFirst({
    where: and(
      eq(schema.metaConnections.userId, user.id),
      isNull(schema.metaConnections.deletedAt),
    ),
    columns: { id: true, accessTokenEncrypted: true },
  });
  if (!conn) {
    redirect('/settings/connections?tab=meta');
  }

  let revokeStatus: number | null = null;
  let revokeOk = false;
  if (conn.accessTokenEncrypted) {
    try {
      const token = await decryptSecret(conn.accessTokenEncrypted);
      const result = await revokeMetaToken(user.id, token);
      revokeStatus = result.status;
      revokeOk = result.ok;
    } catch {
      // Best-effort: a decrypt or fetch error here doesn't block local cleanup.
      revokeStatus = null;
      revokeOk = false;
    }
  }

  await db
    .update(schema.metaConnections)
    .set({ deletedAt: new Date(), status: 'revoked', accessTokenEncrypted: null })
    .where(eq(schema.metaConnections.id, conn.id));

  await cascadePauseUser({
    userId: user.id,
    reason: 'meta_disconnected',
    pausedBy: 'auto',
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'meta_disconnected',
    eventData: {
      revoke_attempted: !!conn.accessTokenEncrypted,
      revoke_status: revokeStatus,
      revoke_ok: revokeOk,
    },
  });

  revalidatePath('/connections/meta');
  redirect('/settings/connections?tab=meta');
}
