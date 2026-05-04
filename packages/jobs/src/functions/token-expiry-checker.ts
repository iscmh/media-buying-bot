import { inngest } from '../client.js';

/**
 * Hourly cron. For each meta_connection:
 *   * 7 days before expiry → email + Telegram nudge.
 *   * 1 day before expiry → second nudge.
 *   * After expiry → auto-pause user, send refresh notification.
 *
 * Phase 2 wires this on once token storage is real.
 */
export const tokenExpiryChecker = inngest.createFunction(
  { id: 'token-expiry-checker', name: 'Token expiry checker' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    void step;
    throw new Error('tokenExpiryChecker not implemented (Phase 2)');
  },
);
