import { Bot } from 'grammy';
import { registerApprovalCallback } from './commands/approval-callback';
import { registerLink } from './commands/link';
import { registerStart } from './commands/start';
import { registerStatus } from './commands/status';

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  registerStart(bot);
  registerLink(bot);
  registerStatus(bot);
  // Phase 5: inline-button callback for kill/scale approval prompts.
  registerApprovalCallback(bot);

  bot.catch((err) => {
    console.error('[bot] handler error', err);
  });

  return bot;
}
