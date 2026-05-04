import { inngest } from '../client.js';

/**
 * Pushes a message to the user's Telegram chat. Decoupled from senders so
 * any function can fan out via `inngest.send({ name: 'telegram/notify.requested', ... })`.
 *
 * Phase 5 wires actual Telegram Bot API calls.
 */
export const telegramNotifier = inngest.createFunction(
  { id: 'telegram-notifier', name: 'Telegram notifier' },
  { event: 'telegram/notify.requested' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('telegramNotifier not implemented (Phase 5)');
  },
);
