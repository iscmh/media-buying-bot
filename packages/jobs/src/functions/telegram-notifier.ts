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
    const { userId, message: rawMessage } = event.data;

    // Polish-7.2: guard against non-string message payloads. A raw Date
    // or object passed here crashes Buffer.byteLength downstream with a
    // cryptic TypeError. Coerce + surface a clear error instead.
    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : rawMessage instanceof Date
          ? rawMessage.toISOString()
          : String(rawMessage ?? '');

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
        return {
          ok: false as const,
          status: 0,
          description: 'TELEGRAM_BOT_TOKEN not set',
          messageId: null as string | null,
        };
      }
      // Phase 5: optional inline keyboard for kill/scale approval prompts.
      // Telegram's wire format is reply_markup.inline_keyboard = [[ { text, callback_data } ]].
      const payload: Record<string, unknown> = { chat_id: chatId, text: message };
      const buttons = event.data.inlineButtons as
        | Array<Array<{ text: string; callbackData: string }>>
        | undefined;
      if (buttons && buttons.length > 0) {
        payload.reply_markup = {
          inline_keyboard: buttons.map((row) =>
            row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
          ),
        };
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          description?: string;
          result?: { message_id?: number };
        } | null;
        // Capture the message_id so the caller (decision-engine prompt
        // dispatcher) can persist it on the pending_approvals row and
        // edit/clear the message later.
        const messageId =
          json?.ok && json.result?.message_id != null ? String(json.result.message_id) : null;
        return {
          ok: res.ok && json?.ok === true,
          status: res.status,
          description: json?.description,
          messageId,
        };
      } catch (err) {
        return {
          ok: false as const,
          status: 0,
          description: err instanceof Error ? err.message : String(err),
          messageId: null as string | null,
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
