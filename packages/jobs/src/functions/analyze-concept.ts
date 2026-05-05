import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

/**
 * Phase 3a: UGC concept analyzer. Mock-mode behavior — sleeps 3 seconds
 * (so the operator clicking through the flow sees the running state),
 * stores a placeholder structured JSON on generation_jobs.metadata, then
 * fans out to generation/ugc.requested.
 *
 * Phase 3b will replace the mock with a real Gemini Vision call using the
 * operator's UGC Deconstructor prompt.
 *
 * Static jobs DO NOT go through this path; the request action sends them
 * straight to generation/static.requested.
 */
export const analyzeConcept = inngest.createFunction(
  {
    id: 'analyze-concept',
    name: 'Analyze concept (UGC vision)',
    retries: 1, // mock failures are rare; one retry is enough
  },
  { event: 'generation/analyze.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;

    // Update status: queued → processing.
    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    // Mock vision-analysis "work". Real Phase 3b call goes here.
    await step.sleep('mock-vision-latency', '3s');

    const mockMetadata = {
      _mock: true,
      analysis_version: 'phase-3a-stub',
      analyzed_at: new Date().toISOString(),
      hooks: [
        { time_seconds: [0, 3], description: 'Mock hook 1 — pattern interrupt' },
        { time_seconds: [3, 6], description: 'Mock hook 2 — direct address' },
      ],
      proof_points: ['Mock proof 1', 'Mock proof 2'],
      cta: 'Mock CTA copy',
    };

    await step.run('store-analysis', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ metadata: mockMetadata })
        .where(eq(schema.generationJobs.id, jobId));
    });

    await step.run('audit', async () => {
      await logAuditEvent({
        userId,
        eventType: 'concept_analyzed',
        eventData: { job_id: jobId, mode, mock: mode === 'mock' },
      });
    });

    // Fan out to UGC variant generation.
    await step.sendEvent('fan-out-ugc', {
      name: 'generation/ugc.requested',
      data: { jobId, userId, mode },
    });

    return { jobId, mode };
  },
);
