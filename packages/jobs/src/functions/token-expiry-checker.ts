import { inngest } from '../client';

/**
 * Hourly cron. For each meta_connection:
 *   * 7 days before expiry → email + Telegram nudge.
 *   * 1 day before expiry → second nudge.
 *   * After expiry → auto-pause user, send refresh notification.
 *
 * Phase 2 wires this on once token storage is real.
 *
 * TODO (Phase 2 scope): implement the actual token-refresh loop.
 *   1. SELECT meta_connections WHERE token_expires_at < now() + '7 days'
 *   2. For connections expiring within 24h: attempt refresh via
 *      POST /oauth/access_token?grant_type=fb_exchange_token
 *      (extends a short-lived token to long-lived)
 *   3. On success: UPDATE meta_connections SET access_token_encrypted,
 *      token_expires_at, last_verified_at
 *   4. On failure: send Telegram alert "Meta token expiring — reconnect
 *      at /connections/meta", then if past expiry: cascadePauseUser
 *   5. Log every refresh attempt to meta_api_call_logs
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
