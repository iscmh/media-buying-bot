import { inngest } from '../client';

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
    // Polish-5: the throw above was firing on every Inngest cron tick
    // and surfacing as a red function in the dashboard, even though
    // the feature is intentionally deferred. No-op + log + skipped:true
    // so the dashboard stays green and ops can grep for "skipped" rows
    // when they look for "what's not implemented yet".
    console.log('token-expiry-checker skipped — not implemented yet');
    return { ok: true, skipped: true };
  },
);
