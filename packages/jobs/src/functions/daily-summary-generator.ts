import { inngest } from '../client';

/**
 * Computes the previous day's P&L per user (in user's local timezone) and
 * writes a `daily_summaries` row. Then triggers `telegram/notify.requested`
 * with the formatted summary.
 *
 * Cron: scheduled per user at 00:05 in their timezone (Phase 6).
 */
export const dailySummaryGenerator = inngest.createFunction(
  { id: 'daily-summary-generator', name: 'Daily summary generator' },
  { event: 'summary/daily.requested' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('dailySummaryGenerator not implemented (Phase 6)');
  },
);
