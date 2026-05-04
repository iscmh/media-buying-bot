import type { Bot } from 'grammy';

/**
 * /link <code> — alias for /start <code>. Phase 2.
 */
export function registerLink(bot: Bot): void {
  bot.command('link', async (ctx) => {
    const code = ctx.match?.toString().trim();
    if (!code) {
      await ctx.reply(
        'Usage: /link <code>. Generate a code in the web app under Connections → Telegram.',
      );
      return;
    }
    await ctx.reply(`Got link code "${code}". Account linking flow ships in Phase 2.`);
  });
}
