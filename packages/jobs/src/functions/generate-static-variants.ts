import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { inngest } from '../client';

const MOCK_SIZES = ['1080x1080', '1080x1350', '1080x1920'] as const;

/**
 * Phase 3a: static variant generator (Gemini image + Claude copy in 3b).
 *
 * Mock-mode behavior:
 *   1. Mark job processing.
 *   2. Sleep 5 seconds total (split across "image gen" and "copy" steps
 *      for realism in the UI's loading state).
 *   3. Insert N generated_creatives rows with placehold.co URLs.
 *   4. Mark job completed; audit log.
 *
 * Phase 3b: replaces step.sleep + placehold.co with real Claude/Gemini
 * calls using the operator's prompts.
 */
export const generateStaticVariants = inngest.createFunction(
  {
    id: 'generate-static-variants',
    name: 'Generate static variants',
    retries: 1,
  },
  { event: 'generation/static.requested' },
  async ({ event, step }) => {
    const { jobId, userId, mode } = event.data;
    const startedAt = Date.now();

    const job = await step.run('load-job', async () => {
      const db = getDb();
      return db.query.generationJobs.findFirst({
        where: eq(schema.generationJobs.id, jobId),
        columns: { variantCount: true },
      });
    });
    const variantCount = job?.variantCount ?? 0;
    if (variantCount <= 0) {
      // Defensive — the request action validates this. If we land here,
      // mark failed and stop.
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

    await step.sleep('mock-image-gen', '3s');
    await step.sleep('mock-copy-gen', '2s');

    await step.run('insert-creatives', async () => {
      const db = getDb();
      const rows = Array.from({ length: variantCount }, (_, i) => {
        const size = MOCK_SIZES[i % MOCK_SIZES.length]!;
        const aspectRatio = size === '1080x1080' ? '1:1' : size === '1080x1350' ? '4:5' : '9:16';
        return {
          userId,
          generationJobId: jobId,
          fileUrl: `https://placehold.co/${size}/png?text=Variant+${i + 1}`,
          aspectRatio: aspectRatio as '1:1' | '4:5' | '9:16',
          status: 'ready_for_review' as const,
        };
      });
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
          path: 'static',
        },
      });
    });

    return { jobId, mode, generated: variantCount };
  },
);
