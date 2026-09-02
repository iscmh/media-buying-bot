/**
 * Polish-29.0.5 Commit 114: seedance-credit-flow.
 *
 * Covers the five state-machine legs across submit → poll → complete:
 *   1. Happy path        → reserve, submit, poll-complete, consume.
 *   2. Submit fails      → reserve, release.
 *   3. Poll returns fail → reserve, poll-failed, release.
 *   4. Poll times out    → reserve, exhaust maxPollAttempts, release.
 *   5. Complete but no url → reserve, release.
 *
 * @mbb/db + @mbb/ai-providers are fully mocked — this is pure
 * orchestration logic, and the DB / provider clients have their own
 * suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reserveCredits = vi.fn();
const consumeReservation = vi.fn();
const releaseReservation = vi.fn();
const submitSeedanceVideo = vi.fn();
const checkUseapiJob = vi.fn();

vi.mock('@mbb/db', () => {
  class InsufficientCreditsError extends Error {
    readonly kind = 'insufficient_credits' as const;
    constructor(
      public required: number,
      public available: number,
    ) {
      super(`Insufficient credits: need ${required}, have ${available}`);
    }
  }
  return {
    reserveCredits: (...args: unknown[]) => reserveCredits(...args),
    consumeReservation: (...args: unknown[]) => consumeReservation(...args),
    releaseReservation: (...args: unknown[]) => releaseReservation(...args),
    InsufficientCreditsError,
  };
});

vi.mock('@mbb/ai-providers', () => ({
  submitSeedanceVideo: (...args: unknown[]) => submitSeedanceVideo(...args),
  checkUseapiJob: (...args: unknown[]) => checkUseapiJob(...args),
}));

import { runSeedanceCreditedJob } from '../src/lib/seedance-credit-flow';

const zeroSleep = () => Promise.resolve();

beforeEach(() => {
  reserveCredits.mockReset();
  consumeReservation.mockReset();
  releaseReservation.mockReset();
  submitSeedanceVideo.mockReset();
  checkUseapiJob.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// -----------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------

describe('runSeedanceCreditedJob — happy path', () => {
  it('reserves, submits, polls until complete, then consumes the reservation', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_1', balanceAfter: 2460 });
    submitSeedanceVideo.mockResolvedValueOnce({
      ok: true,
      jobId: 'seedance_job_x',
      latencyMs: 200,
    });
    checkUseapiJob
      .mockResolvedValueOnce({ status: 'processing', rawStatus: 'queued' })
      .mockResolvedValueOnce({ status: 'processing', rawStatus: 'running' })
      .mockResolvedValueOnce({
        status: 'completed',
        rawStatus: 'completed',
        videoUrl: 'https://cdn.example/out.mp4',
        raw: {},
      });
    consumeReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'A cinematic 5-second product hero shot.',
      sleep: zeroSleep,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videoUrl).toBe('https://cdn.example/out.mp4');
      expect(result.creditsSpent).toBe(40); // seedance-2-5-ugc = 40 credits
      expect(result.pollAttempts).toBe(3);
      expect(result.jobId).toBe('seedance_job_x');
    }
    expect(reserveCredits).toHaveBeenCalledOnce();
    expect(consumeReservation).toHaveBeenCalledOnce();
    expect(releaseReservation).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Submit fails
// -----------------------------------------------------------------

describe('runSeedanceCreditedJob — submit fails', () => {
  it('releases the reservation and returns submit_failed', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_2', balanceAfter: 2460 });
    submitSeedanceVideo.mockResolvedValueOnce({
      ok: false,
      latencyMs: 100,
      errorMessage: 'Dreamina rejected: prompt violates policy',
    });
    releaseReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'blocked content',
      sleep: zeroSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('submit_failed');
      expect(result.errorMessage).toContain('policy');
      expect(result.creditsReleased).toBe(40);
    }
    expect(consumeReservation).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledOnce();
    expect(checkUseapiJob).not.toHaveBeenCalled();
  });

  it('treats a thrown submit as submit_failed and still releases', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_2b', balanceAfter: 2460 });
    submitSeedanceVideo.mockRejectedValueOnce(new Error('network reset'));
    releaseReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'x',
      sleep: zeroSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('submit_failed');
      expect(result.errorMessage).toBe('network reset');
    }
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});

// -----------------------------------------------------------------
// Poll-level failures
// -----------------------------------------------------------------

describe('runSeedanceCreditedJob — poll returns failed', () => {
  it('releases and returns poll_failed with the upstream message', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_3', balanceAfter: 2460 });
    submitSeedanceVideo.mockResolvedValueOnce({
      ok: true,
      jobId: 'seedance_job_y',
      latencyMs: 200,
    });
    checkUseapiJob
      .mockResolvedValueOnce({ status: 'processing', rawStatus: 'running' })
      .mockResolvedValueOnce({
        status: 'failed',
        rawStatus: 'error',
        errorMessage: 'Content policy rejection',
        raw: {},
      });
    releaseReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'x',
      sleep: zeroSleep,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('poll_failed');
      expect(result.errorMessage).toBe('Content policy rejection');
      expect(result.pollAttempts).toBe(2);
    }
    expect(consumeReservation).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});

describe('runSeedanceCreditedJob — poll times out', () => {
  it('exhausts maxPollAttempts then releases with poll_timeout', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_4', balanceAfter: 2460 });
    submitSeedanceVideo.mockResolvedValueOnce({
      ok: true,
      jobId: 'seedance_job_z',
      latencyMs: 200,
    });
    checkUseapiJob.mockResolvedValue({ status: 'processing', rawStatus: 'running' });
    releaseReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'x',
      sleep: zeroSleep,
      maxPollAttempts: 4,
      pollIntervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('poll_timeout');
      expect(result.pollAttempts).toBe(4);
    }
    expect(checkUseapiJob).toHaveBeenCalledTimes(4);
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});

describe('runSeedanceCreditedJob — complete but no videoUrl', () => {
  it('releases and returns no_video_url', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_5', balanceAfter: 2460 });
    submitSeedanceVideo.mockResolvedValueOnce({
      ok: true,
      jobId: 'seedance_job_w',
      latencyMs: 200,
    });
    checkUseapiJob.mockResolvedValueOnce({ status: 'completed', rawStatus: 'completed', raw: {} });
    releaseReservation.mockResolvedValueOnce(undefined);

    const result = await runSeedanceCreditedJob({
      userId: 'u1',
      dreaminaAccount: 'isaac@example.com',
      prompt: 'x',
      sleep: zeroSleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_video_url');
    expect(consumeReservation).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledOnce();
  });
});

// -----------------------------------------------------------------
// Reserve throws (balance too low) — never touches the provider
// -----------------------------------------------------------------

describe('runSeedanceCreditedJob — reserve throws (balance too low)', () => {
  it('propagates InsufficientCreditsError without ever hitting the provider', async () => {
    const { InsufficientCreditsError } = await import('@mbb/db');
    reserveCredits.mockRejectedValueOnce(new InsufficientCreditsError(40, 5));

    await expect(
      runSeedanceCreditedJob({
        userId: 'u1',
        dreaminaAccount: 'isaac@example.com',
        prompt: 'x',
        sleep: zeroSleep,
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(submitSeedanceVideo).not.toHaveBeenCalled();
    expect(checkUseapiJob).not.toHaveBeenCalled();
    expect(consumeReservation).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Wrong-mode model
// -----------------------------------------------------------------

describe('runSeedanceCreditedJob — wrong-mode model', () => {
  it('throws before reserving when the modelId points at a BYOK model', async () => {
    await expect(
      runSeedanceCreditedJob({
        userId: 'u1',
        modelId: 'heygen-avatar-iv', // byok
        dreaminaAccount: 'isaac@example.com',
        prompt: 'x',
        sleep: zeroSleep,
      }),
    ).rejects.toThrow(/expected a credits-mode model/);

    expect(reserveCredits).not.toHaveBeenCalled();
  });
});
