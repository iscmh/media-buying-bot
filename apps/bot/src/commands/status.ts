import type { Bot } from 'grammy';

/**
 * /status — quick health snapshot. Phase 2 will look up the linked user
 * and show: paused?, today's spend, active ad sets, last kill/scale event.
 */
export function registerStatus(bot: Bot): void {
  bot.command('status', async (ctx) => {
    await ctx.reply(
      `Status command not implemented yet (Phase 2).\nDry run: ${process.env.BOT_DRY_RUN ?? 'true'}`,
    );
  });
}
