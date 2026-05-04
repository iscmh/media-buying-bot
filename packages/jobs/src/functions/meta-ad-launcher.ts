import { inngest } from '../client.js';

/**
 * Take generated creatives, push to user's Meta account via the Marketing API.
 * Async ad creation handling, rejection handling, retry logic.
 *
 * Phase 4 wires this up. All Meta calls go through @mbb/meta-api/callMeta
 * (which gates on spend safety + rate limits + dry-run).
 */
export const metaAdLauncher = inngest.createFunction(
  { id: 'meta-ad-launcher', name: 'Meta ad launcher' },
  { event: 'meta/launch.requested' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('metaAdLauncher not implemented (Phase 4)');
  },
);
