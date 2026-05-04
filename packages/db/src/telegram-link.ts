import { and, eq } from 'drizzle-orm';
import { logAuditEvent } from './audit';
import { getDb } from './client';
import { telegramConnections } from './schema/connections';

/**
 * Telegram link code redemption.
 *
 * Lives in @mbb/db so both the web app (via a server action wrapper) and
 * the bot (direct import) share the same redemption rules:
 *   - code must be valid (link_code match) and pending
 *   - code must be ≤ 15 minutes old (link_code_generated_at)
 *   - on success: tg_chat_id bound, status='active', link_code cleared,
 *     link_code_generated_at cleared
 *   - audit logs telegram_link_code_redeemed
 */

export const LINK_CODE_TTL_MINUTES = 15;

export type RedeemFailureReason = 'invalid_or_used' | 'expired';

export type RedeemResult =
  | { ok: true; userId: string }
  | { ok: false; reason: RedeemFailureReason };

export async function redeemTelegramLinkCode(input: {
  code: string;
  tgChatId: string;
  tgUsername?: string;
}): Promise<RedeemResult> {
  const db = getDb();
  const row = await db.query.telegramConnections.findFirst({
    where: and(
      eq(telegramConnections.linkCode, input.code),
      eq(telegramConnections.status, 'pending'),
    ),
    columns: { id: true, userId: true, linkCodeGeneratedAt: true },
  });
  if (!row || !row.linkCodeGeneratedAt) {
    return { ok: false, reason: 'invalid_or_used' };
  }
  const ageMs = Date.now() - row.linkCodeGeneratedAt.getTime();
  if (ageMs > LINK_CODE_TTL_MINUTES * 60 * 1000) {
    return { ok: false, reason: 'expired' };
  }

  await db
    .update(telegramConnections)
    .set({
      tgChatId: input.tgChatId,
      linkedAt: new Date(),
      status: 'active',
      linkCode: null,
      linkCodeGeneratedAt: null,
      metadata: input.tgUsername ? { tgUsername: input.tgUsername } : null,
    })
    .where(eq(telegramConnections.id, row.id));

  await logAuditEvent({
    userId: row.userId,
    eventType: 'telegram_link_code_redeemed',
    eventData: {
      tg_chat_id: input.tgChatId,
      tg_username: input.tgUsername ?? null,
    },
  });

  return { ok: true, userId: row.userId };
}

/** For the bot's "are you already linked?" greeting on bare /start. */
export async function getActiveLinkByChatId(tgChatId: string): Promise<{
  userId: string;
} | null> {
  const db = getDb();
  const row = await db.query.telegramConnections.findFirst({
    where: and(
      eq(telegramConnections.tgChatId, tgChatId),
      eq(telegramConnections.status, 'active'),
    ),
    columns: { userId: true },
  });
  return row ? { userId: row.userId } : null;
}
