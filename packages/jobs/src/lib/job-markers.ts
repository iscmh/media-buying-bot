import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, logAuditEvent, schema } from '@mbb/db';
import { type FailoverReadyState } from './failover';

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

/**
 * Polish-4: which providers the user has active connections for. Used
 * by the failover decision tree at the end of each variant worker.
 */
export async function loadFailoverReadyState(userId: string): Promise<FailoverReadyState> {
  const db = getDb();
  const rows = await db.query.aiProviderConnections.findMany({
    where: and(
      eq(schema.aiProviderConnections.userId, userId),
      eq(schema.aiProviderConnections.status, 'active'),
      isNull(schema.aiProviderConnections.deletedAt),
      inArray(schema.aiProviderConnections.provider, ['heygen', 'kling', 'elevenlabs']),
    ),
    columns: { provider: true },
  });
  const present = new Set(rows.map((r) => r.provider));
  return {
    heygen: present.has('heygen'),
    klingAndElevenLabs: present.has('kling') && present.has('elevenlabs'),
  };
}

/**
 * Polish-4: append a failover attempt to generation_jobs.metadata. The
 * field is jsonb; we read-modify-write with a single-row select to keep
 * the shape stable across reruns.
 */
export async function recordFailoverAttempt(input: {
  jobId: string;
  fromFormat: string;
  toFormat: string;
  reason: string;
}): Promise<void> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, input.jobId),
    columns: { metadata: true },
  });
  const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
  const log = Array.isArray(meta.failover_log) ? (meta.failover_log as unknown[]) : [];
  log.push({
    at: new Date().toISOString(),
    from_format: input.fromFormat,
    to_format: input.toFormat,
    reason: input.reason,
  });
  await db
    .update(schema.generationJobs)
    .set({
      metadata: { ...meta, failover_attempted: true, failover_log: log },
      // Mirror the new format on the row so the next worker reads the
      // right routing target if it re-checks.
      format: input.toFormat,
    })
    .where(eq(schema.generationJobs.id, input.jobId));
}

/**
 * Polish-4: has this job already used its one failover? Workers check
 * before dispatching to prevent a ping-pong loop between the two
 * variant generators.
 */
export async function jobAlreadyFailedOver(jobId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.query.generationJobs.findFirst({
    where: eq(schema.generationJobs.id, jobId),
    columns: { metadata: true },
  });
  const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
  return meta.failover_attempted === true;
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
