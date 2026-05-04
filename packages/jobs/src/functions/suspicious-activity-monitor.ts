import { inngest } from '../client.js';

/**
 * Anti-ban guardrail #3. For a given user, check:
 *   * Ad rejection rate over the last 24h (>30% → auto-pause).
 *   * BM access failures (ban indicator → auto-pause).
 *   * 3+ consecutive ad rejections for the same policy reason → auto-pause.
 *
 * Triggered after every batch of ad creations and on a 15-min cron.
 *
 * Phase 5.
 */
export const suspiciousActivityMonitor = inngest.createFunction(
  { id: 'suspicious-activity-monitor', name: 'Suspicious activity monitor' },
  { event: 'suspicious_activity/check.scheduled' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('suspiciousActivityMonitor not implemented (Phase 5)');
  },
);
