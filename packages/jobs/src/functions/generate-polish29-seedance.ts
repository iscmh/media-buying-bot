/**
 * Polish-29.0.6 Commit 115: Seedance credit-backed generation worker.
 *
 * Listens for  generation/polish29-seedance.requested  and runs
 * `runSeedanceCreditedJob` — the reference credit flow from Commit 114
 * (reserve → submit → poll → consume/release). Persists the resulting
 * video URL on the generation_jobs.metadata + marks the job status,
 * so the admin test-actions page and any future user-facing form can
 * fire this and check completion the standard way.
 *
 * Event payload shape:
 *   {
 *     jobId:           uuid of the generation_jobs row (pre-created
 *                       by the sender so status transitions are visible
 *                       in the runs list immediately)
 *     userId:          uuid of the owner
 *     dreaminaAccount: registered Dreamina account key from
 *                       GET /dreamina/accounts (e.g.
 *                       'US:isaacisverygoatedtho@gmail.com')
 *     prompt:          the Seedance prompt text
 *     modelId?:        credit-pricing model id, defaults to
 *                       'seedance-2-5-ugc'
 *     durationSeconds? aspectRatio? resolution?
 *   }
 *
 * The worker itself is intentionally thin — the credit + provider
 * orchestration lives in seedance-credit-flow.ts (unit-tested in
 * isolation). All this file adds is:
 *   - Inngest step wrapping (single step.run because the flow is
 *     already resumable via useapi.net job ids if we ever move to
 *     step.sleep+recheck).
 *   - Job-status lifecycle (queued → in_progress → completed/failed).
 *   - Metadata write with the useapi.net job id + resulting video URL.
 *
 * Registered in packages/jobs/src/functions/index.ts.
 */
import { eq } from 'drizzle-orm';
import { getDb, InsufficientCreditsError, schema } from '@mbb/db';
import { POLISH_VERSION } from '@mbb/shared';
import { inngest } from '../client';
import { logInngestFailure } from '../error-hook';
import { markJobFailed } from '../lib/job-markers';
import { runSeedanceCreditedJob } from '../lib/seedance-credit-flow';

console.log(`[jobs.generate-polish29-seedance] cold start — POLISH_VERSION=${POLISH_VERSION}`);

export interface Polish29SeedanceEventPayload {
  jobId: string;
  userId: string;
  dreaminaAccount: string;
  prompt: string;
  modelId?: string;
  durationSeconds?: 5 | 8;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  resolution?: '720p' | '1080p' | '4k';
}

export const generatePolish29Seedance = inngest.createFunction(
  {
    id: 'generate-polish29-seedance',
    name: 'Polish-29: Seedance credit-backed generation (useapi.net → Dreamina)',
    retries: 1,
    onFailure: logInngestFailure,
  },
  { event: 'generation/polish29-seedance.requested' },
  async ({ event, step }) => {
    const data = event.data as Polish29SeedanceEventPayload;
    const startedAt = Date.now();

    // ------------------------------------------------------------
    // Mark in_progress up-front so the runs list flips visibly.
    // Failure here is a hard fail — no point running the generation
    // if we can't record its state.
    // ------------------------------------------------------------
    await step.run('mark-in-progress', async () => {
      const db = getDb();
      await db
        .update(schema.generationJobs)
        .set({ status: 'processing' })
        .where(eq(schema.generationJobs.id, data.jobId));
    });

    // ------------------------------------------------------------
    // Run the credit-guarded generation. The helper handles every
    // reserve/consume/release path — we just translate the result
    // into job-lifecycle terms.
    // ------------------------------------------------------------
    const outcome = await step.run('run-seedance', async () => {
      try {
        const result = await runSeedanceCreditedJob({
          userId: data.userId,
          modelId: data.modelId,
          dreaminaAccount: data.dreaminaAccount,
          prompt: data.prompt,
          durationSeconds: data.durationSeconds,
          aspectRatio: data.aspectRatio,
          resolution: data.resolution,
          generationJobId: data.jobId,
        });
        return { kind: 'result' as const, result };
      } catch (err) {
        // The one throw the helper reserves for is
        // InsufficientCreditsError — nothing was reserved, so no
        // release needed. Bubble it through as a job-failed with a
        // human-readable message.
        if (err instanceof InsufficientCreditsError) {
          return {
            kind: 'insufficient_credits' as const,
            required: err.required,
            available: err.available,
          };
        }
        // Any other throw here is a bug in the helper (or an env
        // misconfig — e.g. missing USEAPI_NET_API_TOKEN). Surface it
        // as a job failure with the raw message.
        return {
          kind: 'internal_error' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });

    // ------------------------------------------------------------
    // Success — stamp completed_at, video URL, credit cost.
    // ------------------------------------------------------------
    if (outcome.kind === 'result' && outcome.result.ok === true) {
      const success = outcome.result;
      await step.run('mark-completed', async () => {
        const db = getDb();
        const existing = await db.query.generationJobs.findFirst({
          where: eq(schema.generationJobs.id, data.jobId),
          columns: { metadata: true },
        });
        const meta = (existing?.metadata as Record<string, unknown> | null) ?? {};
        await db
          .update(schema.generationJobs)
          .set({
            status: 'completed',
            completedAt: new Date(),
            generatedCreativeCount: 1,
            metadata: {
              ...meta,
              polish29_seedance: {
                video_url: success.videoUrl,
                useapi_job_id: success.jobId,
                poll_attempts: success.pollAttempts,
                credits_spent: success.creditsSpent,
                dreamina_account: data.dreaminaAccount,
                completed_at: new Date().toISOString(),
                duration_ms: Date.now() - startedAt,
              },
            },
          })
          .where(eq(schema.generationJobs.id, data.jobId));
      });
      return {
        ok: true,
        videoUrl: success.videoUrl,
        creditsSpent: success.creditsSpent,
      };
    }

    // ------------------------------------------------------------
    // Failure branches — mark job failed with a caller-friendly
    // errorMessage. Credits are already released by the helper (or
    // never reserved in the insufficient_credits case).
    // ------------------------------------------------------------
    const failMessage = failureMessage(outcome);
    await step.run('mark-failed', async () => {
      await markJobFailed(data.jobId, data.userId, failMessage, 0);
    });
    return { ok: false, errorMessage: failMessage };
  },
);

function failureMessage(
  outcome:
    | { kind: 'result'; result: Awaited<ReturnType<typeof runSeedanceCreditedJob>> }
    | { kind: 'insufficient_credits'; required: number; available: number }
    | { kind: 'internal_error'; message: string },
): string {
  if (outcome.kind === 'insufficient_credits') {
    return `Not enough credits — this generation needs ${outcome.required}, you have ${outcome.available}. Top up on /settings/credits and try again.`;
  }
  if (outcome.kind === 'internal_error') {
    return `Internal error: ${outcome.message}`;
  }
  if (outcome.result.ok) {
    // Guarded by the success branch above; here for exhaustiveness.
    return '';
  }
  switch (outcome.result.reason) {
    case 'submit_failed':
      return `Dreamina rejected the request: ${outcome.result.errorMessage}`;
    case 'poll_failed':
      return `Dreamina reported the job failed: ${outcome.result.errorMessage}`;
    case 'poll_timeout':
      return `Dreamina did not finish in time: ${outcome.result.errorMessage} (credits refunded)`;
    case 'no_video_url':
      return 'Dreamina reported success but returned no video URL. Credits refunded — please retry.';
    default:
      return outcome.result.errorMessage;
  }
}
