import type { Bot } from 'grammy';

/**
 * /start [link_code]
 *
 * If a link code is included (deep-link from web onboarding), redeem it
 * and bind this Telegram chat to the user's account. Phase 2.
 */
export function registerStart(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const code = ctx.match?.toString().trim();
    if (code) {
      await ctx.reply(
        `Got link code "${code}". Account linking flow ships in Phase 2.`,
      );
      return;
    }
    await ctx.reply(
      'Welcome to Media Buying Bot. Open the web app to generate a link code, then send it back here as `/start <code>`.',
    );
  });
}
