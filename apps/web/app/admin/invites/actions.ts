'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { createInviteCode, getDb, logAuditEvent, revokeInviteCode, schema } from '@mbb/db';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Phase 7: admin server actions for /admin/invites. Re-check admin
 * role inside each action (defense in depth — the page-level
 * requireAdmin gates rendering, but actions can be invoked via fetch
 * by anyone authenticated).
 */
async function requireAdminUserId(): Promise<string> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const db = getDb();
  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, user.id),
    columns: { role: true },
  });
  if (row?.role !== 'admin') redirect('/dashboard');
  return user.id;
}

export interface GenerateInviteCodeResult {
  ok: boolean;
  code?: string;
  errorMessage?: string;
}

export async function generateInviteCodeAction(input: {
  isMultiUse?: boolean;
  maxUses?: number;
  count?: number;
}): Promise<GenerateInviteCodeResult & { codes?: string[] }> {
  const userId = await requireAdminUserId();
  const count = Math.min(Math.max(input.count ?? 1, 1), 25); // sane bulk-gen cap
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await createInviteCode({
      createdBy: userId,
      isMultiUse: input.isMultiUse,
      maxUses: input.maxUses,
    });
    codes.push(r.code);
    await logAuditEvent({
      userId,
      eventType: 'invite_code_generated',
      eventData: {
        invite_code_id: r.id,
        is_multi_use: !!input.isMultiUse,
        max_uses: input.maxUses ?? (input.isMultiUse ? 50 : 1),
        _meta: await auditMetaFromHeaders(),
      },
    });
  }
  revalidatePath('/admin/invites');
  return { ok: true, code: codes[0], codes };
}

export async function revokeInviteCodeAction(id: string): Promise<{ ok: boolean }> {
  const userId = await requireAdminUserId();
  await revokeInviteCode(id);
  await logAuditEvent({
    userId,
    eventType: 'invite_code_revoked',
    eventData: { invite_code_id: id, _meta: await auditMetaFromHeaders() },
  });
  revalidatePath('/admin/invites');
  return { ok: true };
}
