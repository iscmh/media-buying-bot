import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { getActiveLinkByChatId, getDb, schema } from '@mbb/db';

/**
 * /status — quick health snapshot.
 *
 * Phase 2a scope: confirm linkage, show paused state, surface dry-run flag.
 * Phase 5 will add today's spend, active ad sets, last kill/scale event.
 */
export function registerStatus(bot: Bot): void {
  bot.command('status', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id from your Telegram message.');
      return;
    }

    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply(
        "This chat isn't linked to a Ads Bot account yet. Send `/start <code>` from the web app.",
      );
      return;
    }

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, link.userId),
      columns: { email: true, isPaused: true },
    });

    const dryRun = (process.env.BOT_DRY_RUN ?? 'true').toLowerCase() === 'true';
    const lines = [
      `Account: ${user?.email ?? 'unknown'}`,
      `Paused: ${user?.isPaused ? 'yes' : 'no'}`,
      `Dry run: ${dryRun ? 'on' : 'off'}`,
      'Spend / kill-scale stats land in Phase 5.',
    ];
    await ctx.reply(lines.join('\n'));
  });
}
