import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { getActiveLinkByChatId, getDb, schema } from '@mbb/db';
import { inngest } from '@mbb/jobs';

/**
 * Phase 5: callback_query handler for kill/scale approval buttons.
 *
 * The polling cron posts a message with an inline keyboard whose
 * callback_data follows the format `approve:<approvalId>:<decision>`,
 * where decision is `confirm` or `skip`. When the user taps a button,
 * Telegram fires a callback_query update; this handler:
 *
 *   1. Parses callback_data + verifies it matches an active
 *      pending_approvals row.
 *   2. Verifies the chat id sending the callback matches the user's
 *      linked tg_chat_id (defense against forwarded keyboards).
 *   3. Dispatches `approval/decision.received` to Inngest, where the
 *      handle-approval-decision function does the actual Meta call.
 *   4. Edits the message so the buttons disappear / show the outcome.
 */
export function registerApprovalCallback(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data || !data.startsWith('approve:')) return;

    const parts = data.split(':');
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback data', show_alert: false });
      return;
    }
    const approvalId = parts[1]!;
    const decisionRaw = parts[2]!;
    if (decisionRaw !== 'confirm' && decisionRaw !== 'skip') {
      await ctx.answerCallbackQuery({ text: 'Unknown decision', show_alert: false });
      return;
    }
    const decision: 'confirm' | 'skip' = decisionRaw;

    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.answerCallbackQuery({ text: 'No chat id', show_alert: false });
      return;
    }

    // Ownership: chat id sending the tap must match the user whose
    // pending_approval this is.
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.answerCallbackQuery({
        text: 'This chat is not linked to a user — re-link via the web app.',
        show_alert: true,
      });
      return;
    }

    const db = getDb();
    const approval = await db.query.pendingApprovals.findFirst({
      where: eq(schema.pendingApprovals.id, approvalId),
      columns: { userId: true, status: true, expiresAt: true, telegramMessageId: true },
    });
    if (!approval || approval.userId !== link.userId) {
      await ctx.answerCallbackQuery({ text: 'Approval not found.', show_alert: true });
      return;
    }
    if (approval.status !== 'pending') {
      await ctx.answerCallbackQuery({
        text: `Already ${approval.status}.`,
        show_alert: true,
      });
      return;
    }
    if (approval.expiresAt < new Date()) {
      await ctx.answerCallbackQuery({
        text: 'This prompt has expired (24h limit).',
        show_alert: true,
      });
      return;
    }

    // Persist the message id if we don't have one stored yet — lets a
    // future job edit the message to clear the buttons.
    if (!approval.telegramMessageId && ctx.callbackQuery.message?.message_id != null) {
      await db
        .update(schema.pendingApprovals)
        .set({ telegramMessageId: String(ctx.callbackQuery.message.message_id) })
        .where(eq(schema.pendingApprovals.id, approvalId));
    }

    // Dispatch to Inngest — the handler does the actual Meta call.
    await inngest.send({
      name: 'approval/decision.received',
      data: { approvalId, decision },
    });

    // Acknowledge the tap promptly + replace the buttons with a static
    // status line so the user knows their tap landed even before the
    // Inngest worker finishes.
    await ctx.answerCallbackQuery({
      text: decision === 'confirm' ? 'Confirming…' : 'Skipping…',
    });
    if (ctx.callbackQuery.message?.message_id != null) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Edit can fail if the message is older than 48h or in a forum
        // topic — non-fatal.
      }
    }
  });
}
