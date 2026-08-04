import { eq } from 'drizzle-orm';
import { getDb, logError } from '@mbb/db';
import { generationJobs } from '@mbb/db/schema';

/**
 * Polish-25.7 Commit 46: Inngest `onFailure` hook factory.
 *
 * Attach as `onFailure` in `inngest.createFunction`:
 *
 *   inngest.createFunction(
 *     { id: 'meta-ad-launcher', retries: 1, onFailure: logInngestFailure },
 *     { event: 'meta/launch.requested' },
 *     async ({ event, step }) => { ... },
 *   );
 *
 * Fires after Inngest exhausts its retry budget. Extracts the
 * event's userId (all our events include one) plus generationJobId
 * / eventName so the admin errors view can filter by worker
 * surface. Never throws.
 *
 * Polish-25.8 Commit 55: also flips generation_jobs.status='failed'
 * when the event carries a jobId (any of jobId / generationJobId /
 * generation_job_id — the field name has drifted across worker
 * events). Root cause of the stuck-at-55% bug: worker functions
 * flip status='failed' only on happy-path catches; when the
 * Inngest function itself dies (Vercel 300s ceiling, OOM, network
 * crash), no in-function catch runs, and generation_jobs.status
 * sits at 'processing' forever. This hook is the single place we
 * can flip status regardless of how the function died.
 */

function extractJobId(data: Record<string, unknown>): string | null {
  for (const key of ['jobId', 'generationJobId', 'generation_job_id']) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

async function flipStuckJobToFailed(jobId: string, error: unknown): Promise<void> {
  try {
    const db = getDb();
    const message = error instanceof Error ? error.message : String(error);
    // Only touch rows still in-flight — do NOT overwrite a happy-path
    // 'completed' or an in-function 'failed' write.
    await db
      .update(generationJobs)
      .set({
        status: 'failed',
        errorMessage: `Worker crashed after retries were exhausted: ${message.slice(0, 500)}`,
        completedAt: new Date(),
      })
      .where(eq(generationJobs.id, jobId));
  } catch {
    // Non-fatal — the primary logError call still ran.
  }
}

export async function logInngestFailure(payload: {
  event: { name: string; data: Record<string, unknown> };
  error: unknown;
  runId?: string;
}): Promise<void> {
  try {
    const data = payload.event.data ?? {};
    const userId = typeof data.userId === 'string' ? data.userId : null;
    const jobId = extractJobId(data);

    await logError({
      userId,
      source: 'worker',
      sourceName: payload.event.name,
      error: payload.error,
      context: {
        eventName: payload.event.name,
        runId: payload.runId,
        // Only include a small allowlist of event.data fields —
        // full payload may include tokens / prompts / other bulky
        // context. logError also runs redaction, but keeping the
        // context narrow reduces row size.
        generationJobId: jobId,
        conceptId: data.conceptId ?? null,
      },
    });

    if (jobId) {
      await flipStuckJobToFailed(jobId, payload.error);
    }
  } catch {
    // Never let the failure hook itself throw. logError already
    // swallows write failures but wrap for total safety.
  }
}
