import { and, eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

/**
 * Phase 4a: send a plain-text Telegram message to a user. Looks up the
 * user's active Telegram chat_id from telegram_connections, then POSTs
 * to api.telegram.org/bot<token>/sendMessage. Best-effort — silent
 * failure if the user hasn't linked Telegram yet, audit log on send
 * failure for observability.
 *
 * Triggered by `telegram/notify.requested` (sent from launch jobs,
 * future kill/scale events, daily summaries).
 *
 * Uses the existing TELEGRAM_BOT_TOKEN env var (Phase 2 introduced it
 * for the bot webhook). Not a new env var — same token apps/bot uses.
 */
export const telegramNotifier = inngest.createFunction(
  { id: 'telegram-notifier', name: 'Telegram notifier', retries: 2 },
  { event: 'telegram/notify.requested' },
  async ({ event, step }) => {
    const { userId, message } = event.data;

    const chatId = await step.run('lookup-chat-id', async () => {
      const db = getDb();
      const conn = await db.query.telegramConnections.findFirst({
        where: and(
          eq(schema.telegramConnections.userId, userId),
          eq(schema.telegramConnections.status, 'active'),
        ),
        columns: { tgChatId: true },
      });
      return conn?.tgChatId ?? null;
    });

    if (!chatId) {
      // No active Telegram link — nothing we can do. Audit so missing
      // notifications are visible in case the user expected one.
      await logAuditEvent({
        userId,
        eventType: 'telegram_notify_skipped_unlinked',
        eventData: { message_length: message.length },
      });
      return { ok: false, reason: 'no active telegram connection' };
    }

    const sendResult = await step.run('send-message', async () => {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return { ok: false as const, status: 0, description: 'TELEGRAM_BOT_TOKEN not set' };
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          signal: AbortSignal.timeout(5_000),
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          description?: string;
        } | null;
        return {
          ok: res.ok && json?.ok === true,
          status: res.status,
          description: json?.description,
        };
      } catch (err) {
        return {
          ok: false as const,
          status: 0,
          description: err instanceof Error ? err.message : String(err),
        };
      }
    });

    if (!sendResult.ok) {
      await logAuditEvent({
        userId,
        eventType: 'telegram_notify_failed',
        eventData: {
          status: sendResult.status,
          description: sendResult.description ?? null,
        },
      });
    }

    return sendResult;
  },
);
