import { Bot } from 'grammy';
import { registerStart } from './commands/start.js';
import { registerLink } from './commands/link.js';
import { registerStatus } from './commands/status.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  registerStart(bot);
  registerLink(bot);
  registerStatus(bot);

  bot.catch((err) => {
    console.error('[bot] handler error', err);
  });

  return bot;
}
