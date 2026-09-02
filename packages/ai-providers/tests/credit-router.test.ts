/**
 * Polish-29.0.2 Commit 112: credit-router unit tests.
 *
 * The router gates every credit ledger action around a model call.
 * These tests lock down the four legs of the state machine:
 *   BYOK        → call runs, no ledger action.
 *   OK success  → reserve → consume.
 *   OK returns falsy/ok:false → reserve → release.
 *   OK throws   → reserve → release, then re-throw.
 *
 * `@mbb/db` is fully mocked here — the router is pure orchestration
 * logic, DB internals are covered by their own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reserveCredits = vi.fn();
const consumeReservation = vi.fn();
const releaseReservation = vi.fn();

vi.mock('@mbb/db', () => {
  // Defined inside the factory because vi.mock hoists to the top of
  // the file — a class declared at module top-level isn't available
  // yet when the factory runs.
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

 
const { InsufficientCreditsError } = await import('@mbb/db');

import {
  defaultResultOk,
  getModelCostPreview,
  withCreditReservation,
  type CreditRouterOutcome,
} from '../src/credit-router';

beforeEach(() => {
  reserveCredits.mockReset();
  consumeReservation.mockReset();
  releaseReservation.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// -----------------------------------------------------------------
// getModelCostPreview
// -----------------------------------------------------------------

describe('getModelCostPreview', () => {
  it('returns credits + dollar cost for a credits-billed model', () => {
    const preview = getModelCostPreview('seedance-2-5-ugc');
    expect(preview).not.toBeNull();
    expect(preview?.mode).toBe('credits');
    expect(preview?.credits).toBe(40);
    expect(preview?.userDollarCost).toBe(0.8); // 40 * $0.02
    expect(preview?.retailUsdPerAction).toBe(4.5);
  });

  it('returns credits=0 and cost=0 for a BYOK model', () => {
    const preview = getModelCostPreview('heygen-avatar-iv');
    expect(preview?.mode).toBe('byok');
    expect(preview?.credits).toBe(0);
    expect(preview?.userDollarCost).toBe(0);
    expect(preview?.retailUsdPerAction).toBeNull();
  });

  it('returns null for an unknown model id (never throws — UI hides the badge)', () => {
    expect(getModelCostPreview('does-not-exist')).toBeNull();
  });
});

// -----------------------------------------------------------------
// defaultResultOk
// -----------------------------------------------------------------

describe('defaultResultOk', () => {
  it('treats null/undefined as failure', () => {
    expect(defaultResultOk(null)).toBe(false);
    expect(defaultResultOk(undefined)).toBe(false);
  });

  it('treats an { ok: false } discriminated result as failure', () => {
    expect(defaultResultOk({ ok: false, errorMessage: 'nope' })).toBe(false);
  });

  it('treats an { ok: true } discriminated result as success', () => {
    expect(defaultResultOk({ ok: true, videoUrl: 'https://x' })).toBe(true);
  });

  it('treats anything else (string, number, plain object) as success', () => {
    expect(defaultResultOk('some-video-url')).toBe(true);
    expect(defaultResultOk(42)).toBe(true);
    expect(defaultResultOk({ videoUrl: 'https://x' })).toBe(true);
  });
});

// -----------------------------------------------------------------
// withCreditReservation — BYOK path
// -----------------------------------------------------------------

describe('withCreditReservation — BYOK', () => {
  it('runs the call and never touches the ledger', async () => {
    const call = vi.fn(async () => ({ ok: true, taskId: 't1' }));
    const result = await withCreditReservation({ userId: 'u1', modelId: 'heygen-avatar-iv' }, call);
    expect(result).toEqual({ ok: true, taskId: 't1' });
    expect(call).toHaveBeenCalledOnce();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(consumeReservation).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it('emits a byok outcome so callers can log without a ledger read', async () => {
    const outcomes: CreditRouterOutcome[] = [];
    await withCreditReservation(
      { userId: 'u1', modelId: 'openai-gpt-image-2' },
      async () => ({ ok: true }),
      { onOutcome: (o) => void outcomes.push(o) },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: 'byok', credits: 0 });
  });
});

// -----------------------------------------------------------------
// withCreditReservation — credits path, happy case
// -----------------------------------------------------------------

describe('withCreditReservation — credits path (success)', () => {
  it('reserves, runs the call, then consumes on success', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_1', balanceAfter: 2460 });
    consumeReservation.mockResolvedValueOnce(undefined);

    const call = vi.fn(async () => ({ ok: true, jobId: 'seedance_job_x' }));
    const outcomes: CreditRouterOutcome[] = [];

    const result = await withCreditReservation(
      { userId: 'u1', modelId: 'seedance-2-5-ugc', generationJobId: 'gj_1' },
      call,
      { onOutcome: (o) => void outcomes.push(o) },
    );

    expect(result).toEqual({ ok: true, jobId: 'seedance_job_x' });
    expect(reserveCredits).toHaveBeenCalledWith({
      userId: 'u1',
      credits: 40,
      modelId: 'seedance-2-5-ugc',
      generationJobId: 'gj_1',
      ttlMinutes: undefined,
    });
    expect(call).toHaveBeenCalledOnce();
    expect(consumeReservation).toHaveBeenCalledWith({
      reservationId: 'res_1',
      description: undefined,
      metadata: undefined,
    });
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ kind: 'spent', credits: 40 });
  });

  it('forwards description + metadata to the consumeReservation audit row', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_2', balanceAfter: 100 });
    consumeReservation.mockResolvedValueOnce(undefined);
    await withCreditReservation(
      {
        userId: 'u1',
        modelId: 'seedance-2-5-ugc',
        description: 'Job gj_1 — seedance clip',
        metadata: { ad_id: 'ad_42' },
      },
      async () => ({ ok: true }),
    );
    expect(consumeReservation).toHaveBeenCalledWith({
      reservationId: 'res_2',
      description: 'Job gj_1 — seedance clip',
      metadata: { ad_id: 'ad_42' },
    });
  });
});

// -----------------------------------------------------------------
// withCreditReservation — credits path, provider returns failure
// -----------------------------------------------------------------

describe('withCreditReservation — credits path (result-ok=false)', () => {
  it('releases credits when the call returns { ok: false }, and still returns the result to the caller', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_3', balanceAfter: 100 });
    releaseReservation.mockResolvedValueOnce(undefined);

    const failResult = { ok: false, errorMessage: 'provider quota exhausted' };
    const result = await withCreditReservation(
      { userId: 'u1', modelId: 'seedance-2-5-ugc' },
      async () => failResult,
    );

    expect(result).toBe(failResult);
    expect(releaseReservation).toHaveBeenCalledWith({
      reservationId: 'res_3',
      reason: 'released',
    });
    expect(consumeReservation).not.toHaveBeenCalled();
  });

  it('treats a null result as failure and releases credits', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_4', balanceAfter: 60 });
    releaseReservation.mockResolvedValueOnce(undefined);

    await withCreditReservation(
      { userId: 'u1', modelId: 'seedance-2-5-ugc' },
      async () => null as unknown as { ok: boolean },
    );
    expect(releaseReservation).toHaveBeenCalled();
  });

  it('honors a custom resultOk predicate', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_5', balanceAfter: 60 });
    consumeReservation.mockResolvedValueOnce(undefined);

    // Domain-specific success: string is only OK when it starts with 'https://'.
    const result = await withCreditReservation(
      { userId: 'u1', modelId: 'seedance-2-5-ugc' },
      async () => 'https://cdn.example/output.mp4',
      { resultOk: (r) => typeof r === 'string' && r.startsWith('https://') },
    );
    expect(result).toBe('https://cdn.example/output.mp4');
    expect(consumeReservation).toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// withCreditReservation — credits path, call throws
// -----------------------------------------------------------------

describe('withCreditReservation — credits path (thrown error)', () => {
  it('releases the reservation and re-throws so the caller sees the original error', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_6', balanceAfter: 20 });
    releaseReservation.mockResolvedValueOnce(undefined);

    const bang = new Error('network reset');
    await expect(
      withCreditReservation({ userId: 'u1', modelId: 'seedance-2-5-ugc' }, async () => {
        throw bang;
      }),
    ).rejects.toBe(bang);

    expect(releaseReservation).toHaveBeenCalledWith({
      reservationId: 'res_6',
      reason: 'released',
    });
  });

  it('propagates InsufficientCreditsError up-front without ever running the call', async () => {
    const call = vi.fn();
    reserveCredits.mockRejectedValueOnce(new InsufficientCreditsError(40, 5));

    await expect(
      withCreditReservation({ userId: 'u1', modelId: 'seedance-2-5-ugc' }, call),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(call).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(consumeReservation).not.toHaveBeenCalled();
  });

  it('does not mask the caller error when releaseReservation itself throws', async () => {
    reserveCredits.mockResolvedValueOnce({ reservationId: 'res_7', balanceAfter: 20 });
    releaseReservation.mockRejectedValueOnce(new Error('db offline'));

    const bang = new Error('provider 500');
    await expect(
      withCreditReservation({ userId: 'u1', modelId: 'seedance-2-5-ugc' }, async () => {
        throw bang;
      }),
    ).rejects.toBe(bang);
  });
});
