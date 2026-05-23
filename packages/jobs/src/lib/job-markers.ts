import { eq } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';

/**
 * Polish-4: shared lifecycle helpers for variant-generation workers.
 * Both generate-ugc-variants (HeyGen avatar talking head) and
 * generate-cinematic-variants (Kling cinematic voiceover) use the
 * same generation_jobs lifecycle — extract markers so both workers
 * post a consistent audit trail.
 */

export async function markJobFailed(
  jobId: string,
  userId: string,
  error: string,
  costUsd: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.generationJobs)
    .set({
      status: 'failed',
      errorMessage: error,
      actualCostUsd: costUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, jobId));
  await logAuditEvent({
    userId,
    eventType: 'generation_job_completed',
    eventData: { job_id: jobId, ok: false, error, cost_usd: costUsd },
  });
}

export async function markJobCompleted(input: {
  jobId: string;
  userId: string;
  mode: 'mock' | 'live';
  startedAt: number;
  variantCount: number;
  actualCostUsd: number;
  provider: string;
  /** 'ugc' or 'cinematic' — split for audit slicing. */
  path?: string;
  partialFailures?: Array<{ index: number; error?: string }>;
}): Promise<void> {
  const db = getDb();
  const durationMs = Date.now() - input.startedAt;
  await db
    .update(schema.generationJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      generatedCreativeCount: input.variantCount,
      actualCostUsd: input.actualCostUsd.toFixed(4),
    })
    .where(eq(schema.generationJobs.id, input.jobId));

  await logAuditEvent({
    userId: input.userId,
    eventType: 'generation_job_completed',
    eventData: {
      job_id: input.jobId,
      variant_count: input.variantCount,
      mode: input.mode,
      mock: input.mode === 'mock',
      duration_ms: durationMs,
      path: input.path ?? 'ugc',
      provider: input.provider,
      cost_usd: input.actualCostUsd,
      partial_failures: input.partialFailures ?? [],
    },
  });
}
