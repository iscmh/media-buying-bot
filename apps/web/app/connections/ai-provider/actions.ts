'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { AiProviderKeyInputSchema, type AIProviderName } from '@mbb/shared';
import {
  cascadePauseUser,
  decryptSecret,
  encryptSecret,
  getDb,
  logAuditEvent,
  schema,
} from '@mbb/db';
import { getProvider, listHeyGenAvatars } from '@mbb/ai-providers';
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
  const providerName = parsed.data.provider as AIProviderName;

  // Polish-8: per-provider soft-delete (was: kill ALL other providers).
  // Multi-provider model — only the SAME provider's prior row gets
  // superseded; other providers' connections stay live.
  await db
    .update(schema.aiProviderConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(
      and(
        eq(schema.aiProviderConnections.userId, user.id),
        eq(schema.aiProviderConnections.provider, providerName),
        isNull(schema.aiProviderConnections.deletedAt),
      ),
    );

  // Polish-4: detect tier inline for HeyGen — listing avatars gives us
  // 'premium' if any premium avatars are visible to this account.
  // Best-effort: failure to detect doesn't block the connect, tier
  // stays null and can be refreshed via "Verify connection".
  const tier = await detectTierFor(user.id, providerName, parsed.data.apiKey);

  // Polish-8: first connection becomes isPrimary; later ones don't
  // override an existing primary.
  const existingPrimary = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, user.id),
      eq(schema.aiProviderConnections.isPrimary, true),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: { id: true },
  });

  await db.insert(schema.aiProviderConnections).values({
    userId: user.id,
    provider: providerName,
    apiKeyEncrypted: encrypted,
    apiKeyVerifiedAt: new Date(),
    lastVerifiedAt: new Date(),
    tier,
    status: 'active',
    isPrimary: !existingPrimary,
    lastUsedAt: null,
  });

  revalidatePath('/connections/ai-provider');
  return { ok: true };
}

/**
 * Polish-4: re-verify an existing AI provider connection. Hits the
 * provider's list endpoint to re-detect tier (so when a user upgrades
 * HeyGen to Premium and clicks Verify, the badge flips immediately)
 * and bumps lastVerifiedAt.
 */
export interface ReverifyResult {
  ok: boolean;
  tier?: 'free' | 'pro' | 'premium';
  errorMessage?: string;
}

export async function reverifyAiProviderAction(provider?: AIProviderName): Promise<ReverifyResult> {
  const user = await requireUser();
  const db = getDb();

  // Polish-8: caller can target a specific provider. Defaults to the
  // user's single active connection for back-compat with old callers.
  const conn = await db.query.aiProviderConnections.findFirst({
    where: provider
      ? and(
          eq(schema.aiProviderConnections.userId, user.id),
          eq(schema.aiProviderConnections.provider, provider),
          isNull(schema.aiProviderConnections.deletedAt),
        )
      : and(
          eq(schema.aiProviderConnections.userId, user.id),
          isNull(schema.aiProviderConnections.deletedAt),
        ),
    columns: { id: true, provider: true, apiKeyEncrypted: true },
  });
  if (!conn) {
    return { ok: false, errorMessage: 'No active AI provider connection.' };
  }

  let apiKey: string;
  try {
    apiKey = await decryptSecret(conn.apiKeyEncrypted);
  } catch {
    return { ok: false, errorMessage: 'Could not decrypt stored key. Reconnect to fix.' };
  }

  const tier = await detectTierFor(user.id, conn.provider as AIProviderName, apiKey);
  await db
    .update(schema.aiProviderConnections)
    .set({ lastVerifiedAt: new Date(), tier })
    .where(eq(schema.aiProviderConnections.id, conn.id));

  await logAuditEvent({
    userId: user.id,
    eventType: 'ai_provider_reverified',
    eventData: { provider: conn.provider, tier },
  });

  revalidatePath('/connections/ai-provider');
  return { ok: true, tier: tier ?? undefined };
}

/**
 * Polish-4 helper: HeyGen tier comes from the /v2/avatars response —
 * if any premium avatars are visible we infer the connection is on a
 * Premium plan. Other providers don't ship a tier today; return null.
 * Best-effort: a network failure leaves tier null instead of throwing.
 */
async function detectTierFor(
  userId: string,
  provider: AIProviderName,
  apiKey: string,
): Promise<'free' | 'pro' | 'premium' | null> {
  if (provider !== 'heygen') return null;
  try {
    const r = await listHeyGenAvatars({ userId, apiKey });
    return r.ok ? (r.tier ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Disconnect a specific AI provider. Soft-delete + audit.
 *
 * Polish-8: scoped to one provider — disconnecting (say) Replicate
 * doesn't kill the user's HeyGen connection. cascadePauseUser only
 * fires when the disconnected provider was the user's primary AND no
 * other active provider remains (otherwise generation can still run).
 */
export async function disconnectAiProviderAction(provider?: AIProviderName): Promise<void> {
  const user = await requireUser();
  const db = getDb();

  const existing = await db.query.aiProviderConnections.findFirst({
    where: provider
      ? and(
          eq(schema.aiProviderConnections.userId, user.id),
          eq(schema.aiProviderConnections.provider, provider),
          isNull(schema.aiProviderConnections.deletedAt),
        )
      : and(
          eq(schema.aiProviderConnections.userId, user.id),
          isNull(schema.aiProviderConnections.deletedAt),
        ),
    columns: { id: true, provider: true, isPrimary: true },
  });
  if (!existing) {
    redirect('/connections/ai-provider');
  }

  await db
    .update(schema.aiProviderConnections)
    .set({ deletedAt: new Date(), status: 'revoked' })
    .where(eq(schema.aiProviderConnections.id, existing.id));

  // Polish-8: only pause the user if NO active provider remains. With
  // multi-provider, dropping one is normal; full pause is reserved for
  // "you have nothing connected anymore."
  const remaining = await db.query.aiProviderConnections.findFirst({
    where: and(
      eq(schema.aiProviderConnections.userId, user.id),
      isNull(schema.aiProviderConnections.deletedAt),
    ),
    columns: { id: true },
  });
  if (!remaining) {
    await cascadePauseUser({
      userId: user.id,
      reason: 'ai_provider_disconnected',
      pausedBy: 'auto',
    });
  }

  await logAuditEvent({
    userId: user.id,
    eventType: 'ai_provider_disconnected',
    eventData: { provider: existing.provider, was_primary: existing.isPrimary },
  });

  revalidatePath('/connections/ai-provider');
  redirect('/connections/ai-provider');
}
