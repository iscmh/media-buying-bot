import { inngest } from '../client.js';

/**
 * Drives the generation pipeline for a queued generation_jobs row:
 *   1. Fetch concept rows.
 *   2. Resolve user's AIProvider (BYOK key decrypt).
 *   3. Call provider.generateVariants(...).
 *   4. Insert generated_creatives rows.
 *   5. Mark job completed.
 *
 * Phase 3.
 */
export const generationJobProcessor = inngest.createFunction(
  { id: 'generation-job-processor', name: 'Generation job processor' },
  { event: 'generation/job.requested' },
  async ({ event, step }) => {
    void event;
    void step;
    throw new Error('generationJobProcessor not implemented (Phase 3)');
  },
);
