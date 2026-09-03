/**
 * Polish-29.0.5 Commit 114: end-to-end Seedance credit flow.
 *
 * A self-contained async helper that runs one Seedance generation
 * with proper credit ledger semantics across the multi-step
 * submit → poll → download sequence.
 *
 * This is the reference pattern for wrapping the credit router around
 * a real generation flow. It sits ONE LEVEL BELOW the Inngest worker
 * layer on purpose: the future `generate-polish29-seedance` worker
 * calls this helper inside a single `step.run` (or a small handful of
 * chunked steps for long polls), keeping the credit ↔ generation
 * coupling in one testable function. Admin test-actions call it too,
 * so ops can fire a live end-to-end check without shipping frontend.
 *
 * Contract:
 *   - Reserves credits UP FRONT — throws InsufficientCreditsError
 *     before hitting useapi.net if balance is short.
 *   - Consumes on success, releases on ANY failure (submit reject,
 *     poll timeout, download error).
 *   - Returns a discriminated result so callers don't need try/catch
 *     for the domain-level failures; the InsufficientCreditsError
 *     stays a throw because it's the ONE case where nothing was
 *     even attempted.
 */

import {
  checkUseapiJob,
  submitSeedanceVideo,
  type SubmitSeedanceVideoInput,
  type UseapiJobResult,
} from '@mbb/ai-providers';
import { consumeReservation, releaseReservation, reserveCredits } from '@mbb/db';
import { getCreditModel } from '@mbb/shared';

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export interface RunSeedanceCreditedJobInput {
  userId: string;
  /**
   * Credit-pricing model id. Defaults to 'seedance-2-5-ugc'.
   * Recognized: 'seedance-2-5-ugc' | 'seedance-2-0-ugc' | 'seedance-2-0-fast-ugc'.
   * The corresponding Dreamina-side model string is picked by
   * dreaminaModelForCreditModelId() so callers only specify the
   * credit-pricing id.
   */
  modelId?: string;
  /** Registered Dreamina account (email — see /accounts registration). */
  dreaminaAccount: string;
  prompt: string;
  referenceImage?: SubmitSeedanceVideoInput['referenceImage'];
  durationSeconds?: SubmitSeedanceVideoInput['durationSeconds'];
  aspectRatio?: SubmitSeedanceVideoInput['aspectRatio'];
  resolution?: SubmitSeedanceVideoInput['resolution'];
  /** Optional generation_jobs.id — persisted on the reservation. */
  generationJobId?: string;
  /** Optional generated_creatives.id — persisted on the reservation. */
  generatedCreativeId?: string;
  /**
   * Max polling attempts. Default 60 (5 min at 5s cadence) — Seedance
   * jobs typically finish in 30-90s.
   */
  maxPollAttempts?: number;
  /** Milliseconds between polls. Default 5000. */
  pollIntervalMs?: number;
  /**
   * Custom sleep implementation for tests (so we don't burn 5 min of
   * real wall clock verifying the timeout branch). Default: setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

export type RunSeedanceCreditedJobResult =
  | {
      ok: true;
      videoUrl: string;
      creditsSpent: number;
      pollAttempts: number;
      jobId: string;
    }
  | {
      ok: false;
      /**
       * A discriminated failure category the caller can branch on:
       *   submit_failed   — useapi.net rejected the submission
       *   poll_failed     — job status returned 'failed'
       *   poll_timeout    — exhausted maxPollAttempts before completion
       *   no_video_url    — job reported complete but returned no URL
       */
      reason: 'submit_failed' | 'poll_failed' | 'poll_timeout' | 'no_video_url';
      errorMessage: string;
      creditsReleased: number;
      pollAttempts: number;
      jobId?: string;
    };

// -----------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------

const DEFAULT_MAX_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Polish-29.0.9 Commit 118: map a credit-pricing model id to the
 * Dreamina-side model string that useapi.net expects. Keeping this
 * in one function so a future rename (e.g. dropping "-ugc" suffix)
 * only touches one place.
 */
type DreaminaSeedanceModel = NonNullable<Parameters<typeof submitSeedanceVideo>[0]['model']>;

function dreaminaModelForCreditModelId(creditModelId: string): DreaminaSeedanceModel {
  switch (creditModelId) {
    case 'seedance-2-5-ugc':
      return 'seedance-2.5';
    case 'seedance-2-0-ugc':
      return 'seedance-2.0';
    case 'seedance-2-0-fast-ugc':
      return 'seedance-2.0-fast';
    default:
      // Unknown credit-model id — default to 2.5. The pre-flight
      // getCreditModel() call in runSeedanceCreditedJob already
      // throws for genuinely-unknown ids, so this default only
      // matters for future additions that don't have a mapping yet.
      return 'seedance-2.5';
  }
}

export async function runSeedanceCreditedJob(
  input: RunSeedanceCreditedJobInput,
): Promise<RunSeedanceCreditedJobResult> {
  const modelId = input.modelId ?? 'seedance-2-5-ugc';
  const model = getCreditModel(modelId);
  if (model.mode !== 'credits') {
    throw new Error(
      `runSeedanceCreditedJob expected a credits-mode model, got mode=${model.mode} for id=${modelId}`,
    );
  }

  const sleep = input.sleep ?? defaultSleep;
  const maxPollAttempts = input.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // ------------------------------------------------------------
  // Step 1 — reserve credits UP FRONT. Throws
  // InsufficientCreditsError before we ever hit the provider.
  // ------------------------------------------------------------
  const reservation = await reserveCredits({
    userId: input.userId,
    credits: model.credits,
    modelId: model.id,
    generationJobId: input.generationJobId,
  });

  // From this point on every early-return MUST release the reservation.
  // We use a single try/finally-shaped flow: track releaseReason and
  // release exactly once at the exit boundary.
  let outcome: RunSeedanceCreditedJobResult;
  let pollAttempts = 0;
  let jobId: string | undefined;

  try {
    // ----------------------------------------------------------
    // Step 2 — submit
    // ----------------------------------------------------------
    const submitResult = await submitSeedanceVideo({
      userId: input.userId,
      account: input.dreaminaAccount,
      prompt: input.prompt,
      referenceImage: input.referenceImage,
      model: dreaminaModelForCreditModelId(model.id),
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
    });
    if (!submitResult.ok || !submitResult.jobId) {
      outcome = {
        ok: false,
        reason: 'submit_failed',
        errorMessage: submitResult.errorMessage ?? 'Seedance submission returned no jobId.',
        creditsReleased: model.credits,
        pollAttempts: 0,
      };
    } else {
      jobId = submitResult.jobId;
      // --------------------------------------------------------
      // Step 3 — poll
      // --------------------------------------------------------
      let last: UseapiJobResult | null = null;
      for (let i = 0; i < maxPollAttempts; i++) {
        pollAttempts = i + 1;
        last = await checkUseapiJob({
          userId: input.userId,
          service: 'dreamina',
          jobId,
          generationJobId: input.generationJobId,
          generatedCreativeId: input.generatedCreativeId,
        });
        if (last.status === 'completed' || last.status === 'failed') break;
        // Skip the final sleep on the last attempt so the timeout
        // branch fires immediately rather than wasting another interval.
        if (i < maxPollAttempts - 1) await sleep(pollIntervalMs);
      }

      if (!last || last.status === 'processing') {
        outcome = {
          ok: false,
          reason: 'poll_timeout',
          errorMessage: `Seedance did not complete after ${maxPollAttempts} polls (${(maxPollAttempts * pollIntervalMs) / 1000}s).`,
          creditsReleased: model.credits,
          pollAttempts,
          jobId,
        };
      } else if (last.status === 'failed') {
        outcome = {
          ok: false,
          reason: 'poll_failed',
          errorMessage: last.errorMessage ?? 'Seedance job reported failed.',
          creditsReleased: model.credits,
          pollAttempts,
          jobId,
        };
      } else if (!last.videoUrl) {
        // Polish-29.0.22 Commit 131: dump the raw body when we get a
        // completed job with no videoUrl — that means our parser hasn't
        // seen this response shape yet. The dump shows the exact keys
        // Dreamina used so the next commit fixes normalizeJobBody one-
        // shot. Truncated to 400 chars.
        let bodyHint = '';
        try {
          const s = JSON.stringify(last.raw).slice(0, 400);
          if (s && s !== '{}' && s !== 'null') bodyHint = ` :: body=${s}`;
        } catch {
          /* raw unserializable — skip */
        }
        outcome = {
          ok: false,
          reason: 'no_video_url',
          errorMessage: 'Seedance reported complete but returned no video URL.' + bodyHint,
          creditsReleased: model.credits,
          pollAttempts,
          jobId,
        };
      } else {
        // ----------------------------------------------------
        // Step 4 — success. Consume the reservation and return.
        // ----------------------------------------------------
        await consumeReservation({
          reservationId: reservation.reservationId,
          description: `Seedance generation via useapi.net (${input.dreaminaAccount})`,
          metadata: {
            useapi_job_id: jobId,
            model_id: model.id,
            dreamina_account: input.dreaminaAccount,
            poll_attempts: pollAttempts,
          },
        });
        return {
          ok: true,
          videoUrl: last.videoUrl,
          creditsSpent: model.credits,
          pollAttempts,
          jobId,
        };
      }
    }
  } catch (err) {
    // Provider threw (network reset, timeout inside useapi.net, etc.).
    // Same treatment as any other failure: release + return a
    // structured result. We deliberately do NOT re-throw — the
    // caller wants a discriminated union so they can log / retry /
    // notify without a second try/catch layer.
    outcome = {
      ok: false,
      reason: 'submit_failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      creditsReleased: model.credits,
      pollAttempts,
      jobId,
    };
  }

  // ------------------------------------------------------------
  // Failure exit — release the reservation. Swallow release errors
  // so we don't mask the underlying failure the caller needs to see.
  // ------------------------------------------------------------
  try {
    await releaseReservation({
      reservationId: reservation.reservationId,
      reason: 'released',
      description: 'reason' in outcome ? `Seedance failed: ${outcome.reason}` : undefined,
    });
  } catch {
    // Reservation may have already been released by an expiry sweep;
    // don't mask the real error.
  }
  return outcome;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
