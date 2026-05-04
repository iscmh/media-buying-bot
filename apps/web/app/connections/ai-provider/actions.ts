'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { AiProviderKeyInputSchema, type AIProviderName } from '@mbb/shared';
import { cascadePauseUser, encryptSecret, getDb, logAuditEvent, schema } from '@mbb/db';
import { getProvider } from '@mbb/ai-providers';
import { getSupabaseServerClient } from '@/lib/supabase/server';

async function requireUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

export interface VerifyAndSaveProviderResult {
  ok: boolean;
  errorMessage?: string;
}

/**
 * Verify a pasted provider key, encrypt it, and persist to
 * ai_provider_connections. Real verification (HeyGen) hits the provider's
 * API; format-only verification (Arcads, Creatify today) checks credential
 * shape and surfaces a "verify at first generation" note in the UI.
 *
 * Always audit-logs `ai_provider_verified` with verification_method so we
 * can tell after the fact whether we actually talked to the provider.
 */
export async function verifyAndSaveProviderKey(
  formData: FormData,
): Promise<VerifyAndSaveProviderResult> {
  const parsed = AiProviderKeyInputSchema.safeParse({
    provider: formData.get('provider'),
    apiKey: formData.get('apiKey'),
  });
  if (!parsed.success) {
    return { ok: false, errorMessage: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const user = await requireUser();
  const provider = getProvider(parsed.data.provider as AIProviderName);
  const result = await provider.verifyKey(parsed.data.apiKey);

  await logAuditEvent({
    userId: user.id,
    eventType: 'ai_provider_verified',
    eventData: {
      provider: parsed.data.provider,
      ok: result.ok,
      verification_method: result.method,
      status_code: 'statusCode' in result ? result.statusCode : null,
    },
  });

  if (!result.ok) {
    return { ok: false, errorMessage: result.reason };
  }

  const db = getDb();
  const encrypted = await encryptSecret(parsed.data.apiKey);

  // Soft-delete any existing non-deleted row (one active connection per
  // user; provider switch supersedes the old one).
  await db
    .update(schema.aiProviderConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(
      and(
        eq(schema.aiProviderConnections.userId, user.id),
        isNull(schema.aiProviderConnections.deletedAt),
      ),
    );

  await db.insert(schema.aiProviderConnections).values({
    userId: user.id,
    provider: parsed.data.provider as AIProviderName,
    apiKeyEncrypted: encrypted,
    apiKeyVerifiedAt: new Date(),
    status: 'active',
    isPrimary: true,
    lastUsedAt: null,
  });

  revalidatePath('/connections/ai-provider');
  return { ok: true };
}

/**
 * Disconnect the user's AI provider. Soft-delete + cascade-pause + redirect
 * to /connections/ai-provider so the page re-renders into the paste-form
 * sub-state. No "re-onboard from ToS" — the gate already handles this:
 * onboarding is complete, the user is just reconfiguring a connection.
 */
export async function disconnectAiProviderAction(): Promise<void> {
  const user = await requireUser();
  const db = getDb();

  const existing = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, user.id),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: { id: true, provider: true },
  });
  if (!existing) {
    redirect('/connections/ai-provider');
  }

  await db
    .update(schema.aiProviderConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(eq(schema.aiProviderConnections.id, existing.id));

  await cascadePauseUser({
    userId: user.id,
    reason: 'ai_provider_disconnected',
    pausedBy: 'auto',
  });

  await logAuditEvent({
    userId: user.id,
    eventType: 'ai_provider_disconnected',
    eventData: { provider: existing.provider },
  });

  revalidatePath('/connections/ai-provider');
  redirect('/connections/ai-provider');
}
