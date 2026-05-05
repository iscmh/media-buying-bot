'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { ToolProviderKeyInputSchema, type ToolProviderName } from '@mbb/shared';
import { cascadePauseUser, encryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { auditMetaFromHeaders } from '@/lib/audit/request-meta';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

export interface VerifyAndSaveToolKeyResult {
  ok: boolean;
  errorMessage?: string;
}

/**
 * Verify a pasted tool-provider key (Gemini / Claude / Kie.ai), encrypt it,
 * and persist to tool_connections. Phase 3a uses FORMAT-ONLY validation
 * (regex). Real verification lands in Phase 3b alongside the live API
 * calls in generation jobs.
 *
 * Audit-logs `tool_connected` with verification_method='format_only'.
 */
export async function verifyAndSaveToolKey(
  formData: FormData,
): Promise<VerifyAndSaveToolKeyResult> {
  const parsed = ToolProviderKeyInputSchema.safeParse({
    provider: formData.get('provider'),
    apiKey: formData.get('apiKey'),
  });
  if (!parsed.success) {
    return { ok: false, errorMessage: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const user = await requireUser();
  const meta = await auditMetaFromHeaders();

  await logAuditEvent({
    userId: user.id,
    eventType: 'tool_connected',
    eventData: {
      provider: parsed.data.provider,
      verification_method: 'format_only',
      _meta: meta,
    },
  });

  const db = getDb();
  const encrypted = await encryptSecret(parsed.data.apiKey);

  // Soft-delete any existing non-deleted row for this (user, provider).
  // Multiple providers can be active at once; only the SAME provider gets
  // superseded.
  await db
    .update(schema.toolConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(
      and(
        eq(schema.toolConnections.userId, user.id),
        eq(schema.toolConnections.provider, parsed.data.provider as ToolProviderName),
        isNull(schema.toolConnections.deletedAt),
      ),
    );

  await db.insert(schema.toolConnections).values({
    userId: user.id,
    provider: parsed.data.provider as ToolProviderName,
    apiKeyEncrypted: encrypted,
    apiKeyVerifiedAt: new Date(),
    status: 'active',
  });

  revalidatePath('/connections/tools');
  return { ok: true };
}

/**
 * Disconnect ONE tool provider (operator clicks Disconnect on a specific
 * card). Soft-deletes that provider's row, cascade-pauses the user, audit
 * logs, redirects back to /connections/tools so the page re-renders into
 * the paste form for that provider.
 *
 * Cascade-pause matches the pattern from Meta/Telegram/AI provider
 * disconnect: any disconnect halts the bot until the operator deliberately
 * unpauses from the dashboard.
 */
export async function disconnectToolAction(formData: FormData): Promise<void> {
  const provider = formData.get('provider');
  if (provider !== 'gemini' && provider !== 'claude' && provider !== 'kie_ai') {
    return;
  }
  const user = await requireUser();
  const meta = await auditMetaFromHeaders();
  const db = getDb();

  const existing = await db.query.toolConnections.findFirst({
    where: and(
      eq(schema.toolConnections.userId, user.id),
      eq(schema.toolConnections.provider, provider),
      isNull(schema.toolConnections.deletedAt),
    ),
    columns: { id: true },
  });
  if (!existing) {
    redirect('/connections/tools');
  }

  await db
    .update(schema.toolConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(eq(schema.toolConnections.id, existing.id));

  await cascadePauseUser({
    userId: user.id,
    reason: `tool_disconnected:${provider}`,
    pausedBy: 'auto',
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'tool_disconnected',
    eventData: { provider, _meta: meta },
  });

  revalidatePath('/connections/tools');
  redirect('/connections/tools');
}
