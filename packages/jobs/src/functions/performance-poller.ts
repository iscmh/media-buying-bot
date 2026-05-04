import { inngest } from '../client.js';

/**
 * Polls Meta for first-hour, hour 4, hour 6, hour 24 performance data per
 * active ad set. Stagger calls per user (sequential), 15-minute cadence.
 *
 * Phase 5.
 */
export const performancePoller = inngest.createFunction(
  { id: 'performance-poller', name: 'Performance poller' },
  { event: 'performance/poll.scheduled' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('performancePoller not implemented (Phase 5)');
  },
);
