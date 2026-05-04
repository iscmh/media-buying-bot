import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { getActiveLinkByChatId, getDb, redeemTelegramLinkCode, schema } from '@mbb/db';

/**
 * /start [link_code]
 *
 *  - With a code: validate (pending + ≤ 15 min old), bind this Telegram
 *    chat to the user_id, set status='active'. Reply with success that
 *    references the user's email.
 *  - Without a code: if this chat is already linked, greet by email; else
 *    show the "generate a code in the web app" instructions.
 */
export function registerStart(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const arg = ctx.match?.toString().trim();
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply(
        'Could not read chat id from your Telegram message. Try again from a one-on-one chat with the bot.',
      );
      return;
    }

    if (arg) {
      const tgUsername = ctx.from?.username;
      const result = await redeemTelegramLinkCode({
        code: arg,
        tgChatId,
        tgUsername,
      });

      if (!result.ok) {
        if (result.reason === 'expired') {
          await ctx.reply(
            'That link code expired (codes are good for 15 minutes). Generate a new one in the web app and try again.',
          );
        } else {
          await ctx.reply(
            'That code is invalid or has already been used. Generate a new one in the web app and try again.',
          );
        }
        return;
      }

      const email = await lookupEmail(result.userId);
      const who = email ? ` to ${email}` : '';
      await ctx.reply(
        `✓ Linked successfully${who}. You'll receive kill/scale alerts and daily summaries here.`,
      );
      return;
    }

    // Bare /start: greet differently if this chat is already linked.
    const link = await getActiveLinkByChatId(tgChatId);
    if (link) {
      const email = await lookupEmail(link.userId);
      const who = email ? ` (${email})` : '';
      await ctx.reply(
        `Welcome back${who}. Your account is linked. You'll get notifications here when ads need attention. /status for a quick health snapshot.`,
      );
      return;
    }

    await ctx.reply(
      'Welcome to Media Buying Bot.\n\nOpen the web app, finish the Meta connect step, then send the link code from the Telegram step here as `/start <code>`.',
    );
  });
}

async function lookupEmail(userId: string): Promise<string | null> {
  try {
    const db = getDb();
    const row = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { email: true },
    });
    return row?.email ?? null;
  } catch {
    return null;
  }
}
