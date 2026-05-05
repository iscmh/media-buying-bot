import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

const MOCK_VIDEO_URL = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

/**
 * Phase 3a: UGC variant generator. Triggered by analyze-concept's fan-out
 * (so this job runs AFTER vision deconstruction completes). Mock-mode
 * behavior:
 *
 *   1. Mark processing.
 *   2. Sleep 5 seconds (mock prompt-refinement + video-gen).
 *   3. Insert N generated_creatives rows pointing at a public sample mp4.
 *   4. Mark completed; audit log.
 *
 * Phase 3b replaces step.sleep + sample mp4 with real Claude prompt
 * refinement + provider video generation (Kie.ai/HeyGen/Arcads).
 */
export const generateUgcVariants = inngest.createFunction(
  {
    id: 'generate-ugc-variants',
    name: 'Generate UGC variants',
    retries: 1,
  },
  { event: 'generation/ugc.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true, providerChoice: true },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    if (variantCount <= 0) {
      await step.run('mark-failed', async () => {
        const db = getDb();
        await db
          .update(schema.generationJobs)
          .set({ status: 'failed', errorMessage: 'variant_count missing or non-positive' })
          .where(eq(schema.generationJobs.id, jobId));
      });
      return { jobId, mode, generated: 0 };
    }

    await step.run('mark-processing', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, jobId));
    });

    await step.sleep('mock-prompt-refinement', '2s');
    await step.sleep('mock-video-gen', '3s');

    await step.run('insert-creatives', async () => {
      const db = getDb();
      const rows = Array.from({ length: variantCount }, () => ({
        userId,
        generationJobId: jobId,
        fileUrl: MOCK_VIDEO_URL,
        aspectRatio: '9:16' as const,
        status: 'ready_for_review' as const,
      }));
      await db.insert(schema.generatedCreatives).values(rows);
    });

    const durationMs = Date.now() - startedAt;
    await step.run('mark-completed', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          generatedCreativeCount: variantCount,
        })
        .where(eq(schema.generationJobs.id, jobId));
    });

    await step.run('audit', async () => {
      await logAuditEvent({
        userId,
        eventType: 'generation_job_completed',
        eventData: {
          job_id: jobId,
          variant_count: variantCount,
          mode,
          mock: mode === 'mock',
          duration_ms: durationMs,
          path: 'ugc',
          provider: job?.providerChoice ?? null,
        },
      });
    });

    return { jobId, mode, generated: variantCount };
  },
);
