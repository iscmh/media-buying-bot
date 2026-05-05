import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@mbb/db';
import { AI_PROVIDER_META, type AIProviderName } from '@mbb/shared';

/**
 * One-shot read of "what's connected for this user" for the dashboard
 * cards. Matches the gate's view of the world: only a row that's
 * `status='active'` and not soft-deleted counts as connected.
 *
 * The Meta path doesn't store the BM's display name (Phase 1 schema),
 * so we surface the last 4 digits of the ID. Phase 3+ can add a
 * business_manager_name column if the dashboard wants to show "AFW Media"
 * instead of "BM …7890".
 */

export interface ConnectionSummaries {
  meta: { connected: true; bmIdShort: string; adAccountCount: number } | { connected: false };
  telegram: { connected: true; username: string | null } | { connected: false };
  aiProvider: { connected: true; provider: AIProviderName; label: string } | { connected: false };
}

export async function getConnectionSummaries(userId: string): Promise<ConnectionSummaries> {
  const db = getDb();

  const [meta, tg, ai] = await Promise.all([
    db.query.metaConnections.findFirst({
      where: and(
        eq(schema.metaConnections.userId, userId),
        eq(schema.metaConnections.status, 'active'),
        isNull(schema.metaConnections.deletedAt),
      ),
      columns: { businessManagerId: true, adAccountIds: true },
    }),
    db.query.telegramConnections.findFirst({
      where: and(
        eq(schema.telegramConnections.userId, userId),
        eq(schema.telegramConnections.status, 'active'),
      ),
      columns: { metadata: true },
    }),
    db.query.aiProviderConnections.findFirst({
      where: and(
        eq(schema.aiProviderConnections.userId, userId),
        eq(schema.aiProviderConnections.status, 'active'),
        isNull(schema.aiProviderConnections.deletedAt),
      ),
      columns: { provider: true },
    }),
  ]);

  return {
    meta: meta?.businessManagerId
      ? {
          connected: true,
          bmIdShort: meta.businessManagerId.slice(-4),
          adAccountCount: meta.adAccountIds?.length ?? 0,
        }
      : { connected: false },
    telegram: tg
      ? { connected: true, username: tg.metadata?.tgUsername ?? null }
      : { connected: false },
    aiProvider: ai
      ? {
          connected: true,
          provider: ai.provider as AIProviderName,
          label: AI_PROVIDER_META[ai.provider as AIProviderName].label,
        }
      : { connected: false },
  };
}
