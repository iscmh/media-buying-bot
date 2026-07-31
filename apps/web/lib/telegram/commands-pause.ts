import 'server-only';
import type { Bot } from 'grammy';
import { and, eq, isNull } from 'drizzle-orm';
import {
  cascadePauseUser,
  getActiveLinkByChatId,
  getDb,
  isMetaConnected,
  logAuditEvent,
  schema,
  unpauseUser,
} from '@mbb/db';

/**
 * Polish-25.8 Commit 48: /pause + /unpause bot commands.
 *
 * /pause  — sets users.is_paused=true, adds user_pause_log row with
 *           paused_by='user' and reason='telegram_command'. Idempotent
 *           if already paused.
 * /unpause — mirrors web UnpauseButton: closes all open user_pause_log
 *            rows + flips is_paused=false. Warns if meta_disconnected
 *            is still open AND Meta still disconnected (auto-repause
 *            risk).
 */
export function registerPauseCommands(bot: Bot): void {
  bot.command('pause', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply("This chat isn't linked. /help for setup.");
      return;
    }
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, link.userId),
      columns: { isPaused: true },
    });
    if (user?.isPaused) {
      await ctx.reply('Bot is already paused. /unpause to resume.');
      return;
    }
    await cascadePauseUser({
      userId: link.userId,
      reason: 'telegram_command',
      pausedBy: 'user',
    });
    await ctx.reply(
      'Bot PAUSED. Auto-actions (kills, scales, launches) are frozen. Send /unpause to resume.',
    );
  });

  bot.command('unpause', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply("This chat isn't linked. /help for setup.");
      return;
    }
    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, link.userId),
      columns: { isPaused: true },
    });
    if (!user?.isPaused) {
      await ctx.reply('Bot was not paused. Nothing to do.');
      return;
    }

    // Same auto-repause warning as web UnpauseButton — check for
    // meta_disconnected open reasons + actual meta connection state.
    const openReasons = await db.query.userPauseLog.findMany({
      where: and(
        eq(schema.userPauseLog.userId, link.userId),
        isNull(schema.userPauseLog.unpausedAt),
      ),
      columns: { reason: true },
    });
    const reasonList = openReasons.map((r) => r.reason);
    const metaStillDisconnected =
      reasonList.includes('meta_disconnected') && !(await isMetaConnected(link.userId));

    if (metaStillDisconnected) {
      await ctx.reply(
        '⚠️ Meta is still disconnected. Unpausing now will auto-pause the bot again on the next launch attempt. Reconnect Meta in the web app first, then send /unpause.',
      );
      return;
    }

    const result = await unpauseUser(link.userId);
    if (result) {
      await ctx.reply(
        `✓ Bot resumed. Closed ${result.previousPauseCount} pause${
          result.previousPauseCount === 1 ? '' : 's'
        } (${result.previousReasons.join(', ') || 'none'}).`,
      );
    } else {
      await ctx.reply('Bot was already unpaused.');
    }
    await logAuditEvent({
      userId: link.userId,
      eventType: 'user_unpaused',
      eventData: { source: 'telegram_command' },
    });
  });
}
