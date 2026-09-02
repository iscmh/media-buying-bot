/**
 * Polish-29.0.2 Commit 112: credit router.
 *
 * A single primitive every credit-billed model call wraps around:
 *
 *   const result = await withCreditReservation(
 *     { userId, modelId, generationJobId },
 *     async () => submitSeedanceVideo({ ... }),
 *   );
 *
 * What it does per call:
 *   1. Look up the model in the shared credit-pricing catalog.
 *   2. If mode === 'byok'                 → just call the function, no
 *                                            ledger action. User pays
 *                                            their provider directly.
 *   3. If mode === 'credits' → reserve the credits (throws
 *      InsufficientCreditsError up-front if balance too low), run the
 *      call, then:
 *        - success  → consumeReservation (spend row written)
 *        - throw    → releaseReservation (credits returned)
 *        - returned falsy or `{ ok: false }` → releaseReservation
 *          (worker convention: falsy result means the provider
 *          rejected — user should not pay).
 *
 * The router NEVER decides WHICH provider to call — the caller
 * already picked the model. It only gates the credit ledger around
 * the call. That keeps the existing generation workers intact and
 * lets each worker adopt it without a rewrite.
 *
 * On the read side, `getModelCostPreview(modelId)` returns the number
 * of credits a call would burn (0 for BYOK) so the frontend can
 * render the "This will cost 40 credits" preview before submission.
 */

import { getCreditModel, userDollarCost, type CreditModel } from '@mbb/shared';
import { consumeReservation, releaseReservation, reserveCredits } from '@mbb/db';

// -----------------------------------------------------------------
// Public preview helpers (safe to import from any surface)
// -----------------------------------------------------------------

export interface ModelCostPreview {
  modelId: string;
  displayName: string;
  mode: CreditModel['mode'];
  /** 0 when BYOK. */
  credits: number;
  /** 0 when BYOK. */
  userDollarCost: number;
  retailUsdPerAction: number | null;
}

/**
 * Cost preview for a single call of the given model. Used by the
 * frontend to render "Costs 40 credits ($0.80)" and gate submission
 * on balance. Never throws — an unknown model id returns null so the
 * UI can hide the badge instead of crashing.
 */
export function getModelCostPreview(modelId: string): ModelCostPreview | null {
  try {
    const model = getCreditModel(modelId);
    return {
      modelId: model.id,
      displayName: model.displayName,
      mode: model.mode,
      credits: model.mode === 'credits' ? model.credits : 0,
      userDollarCost: userDollarCost(model),
      retailUsdPerAction: model.retailUsdPerAction,
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// Router — gates credit spend around an actual model call
// -----------------------------------------------------------------

export interface WithCreditReservationOptions {
  userId: string;
  modelId: string;
  /** Optional generation job id — persisted on the reservation for auditability. */
  generationJobId?: string;
  /**
   * Reservation TTL in minutes; defaults to the credits-package default (30).
   * Bump for workers that legitimately take longer than 30 min end-to-end.
   */
  ttlMinutes?: number;
  /** Optional description shown in the user's credit history. */
  description?: string;
  /** Optional metadata forwarded to the consume/release audit row. */
  metadata?: Record<string, unknown>;
}

/**
 * A result the router should treat as "successful" (charge the user)
 * vs "failed" (release the reservation). Workers that return
 * discriminated union results should implement `resultOk` accordingly.
 */
export type ResultOk<T> = (result: T) => boolean;

/**
 * Default success predicate: `null` / `undefined` are failures;
 * an object with `ok: false` is a failure; anything else is a success.
 * Matches the shape of every provider client in this package
 * (kie-ai, useapi.net, HeyGen, etc.).
 */
export function defaultResultOk<T>(result: T): boolean {
  if (result == null) return false;
  if (typeof result === 'object' && result !== null && 'ok' in result) {
    return (result as { ok: unknown }).ok === true;
  }
  return true;
}

/**
 * Wrap a credit-billed model call with reservation semantics. Returns
 * the caller's result. Callers that want to know how many credits
 * were spent / refunded can inspect the CreditRouterOutcome via the
 * onOutcome callback (all optional).
 */
export async function withCreditReservation<T>(
  opts: WithCreditReservationOptions,
  call: () => Promise<T>,
  {
    resultOk = defaultResultOk,
    onOutcome,
  }: {
    resultOk?: ResultOk<T>;
    onOutcome?: (o: CreditRouterOutcome) => void | Promise<void>;
  } = {},
): Promise<T> {
  const model = getCreditModel(opts.modelId);

  // BYOK path — do nothing to the ledger. Caller-supplied api keys
  // handle billing on their side; we neither reserve nor spend.
  if (model.mode === 'byok') {
    const result = await call();
    if (onOutcome) {
      await onOutcome({
        kind: 'byok',
        modelId: model.id,
        credits: 0,
      });
    }
    return result;
  }

  // Credits path — reserve up-front. reserveCredits throws
  // InsufficientCreditsError before the call even fires when balance
  // is too low, so we never make a provider request the user can't
  // pay for.
  const reservation = await reserveCredits({
    userId: opts.userId,
    credits: model.credits,
    modelId: model.id,
    generationJobId: opts.generationJobId,
    ttlMinutes: opts.ttlMinutes,
  });

  let result: T;
  try {
    result = await call();
  } catch (err) {
    // Provider threw — return the credits, then re-throw so the
    // caller sees the same error as if the router weren't here.
    await safeRelease(reservation.reservationId, 'released');
    if (onOutcome) {
      await onOutcome({
        kind: 'released_on_error',
        modelId: model.id,
        credits: model.credits,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  if (!resultOk(result)) {
    // Provider returned a discriminated-union failure. Same treatment
    // as a thrown error: release credits, propagate the result.
    await safeRelease(reservation.reservationId, 'released');
    if (onOutcome) {
      await onOutcome({
        kind: 'released_on_failure',
        modelId: model.id,
        credits: model.credits,
      });
    }
    return result;
  }

  // Success — convert reservation to permanent spend.
  await consumeReservation({
    reservationId: reservation.reservationId,
    description: opts.description,
    metadata: opts.metadata,
  });
  if (onOutcome) {
    await onOutcome({
      kind: 'spent',
      modelId: model.id,
      credits: model.credits,
    });
  }
  return result;
}

async function safeRelease(reservationId: string, reason: 'released' | 'expired'): Promise<void> {
  try {
    await releaseReservation({ reservationId, reason });
  } catch {
    // The reservation might have already been released (double-fire
    // from an outer retry) — swallow so we don't mask the underlying
    // caller error.
  }
}

// -----------------------------------------------------------------
// Observability shape
// -----------------------------------------------------------------

export type CreditRouterOutcome =
  | { kind: 'byok'; modelId: string; credits: 0 }
  | { kind: 'spent'; modelId: string; credits: number }
  | { kind: 'released_on_failure'; modelId: string; credits: number }
  | { kind: 'released_on_error'; modelId: string; credits: number; errorMessage: string };
