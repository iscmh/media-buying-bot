import {
  ASSUMED_CONVERSION_VALUE_USD,
  FIRST_SCALES_GRACE_COUNT,
  FIRST_SCALES_INCREMENT_PCT_CAP,
  SCALE_HARD_MULTIPLIER_CAP,
} from './safety';

/**
 * Phase 5 decision engine. Pure function — takes an ad's current state +
 * its latest insights + the user's thresholds, returns a single
 * recommendation. The polling cron treats `action !== 'no_action'` as
 * "post a Telegram prompt and create a pending_approvals row".
 *
 * Rule order (first match wins):
 *   0. hasPendingApproval → no_action (don't double-prompt)
 *   1. spend ≥ kill_no_conv_spend_usd AND conversions == 0 → kill
 *   2. cpc > kill_max_cpc_usd AND spend ≥ MIN_SPEND_FOR_CPC_RULE → kill
 *   3. ctr < kill_min_ctr_pct AND impressions ≥ MIN_IMPR_FOR_CTR_RULE → kill
 *   4. conversions > 0
 *        AND spend ≥ scale_min_spend_usd
 *        AND impliedRoas ≥ scale_min_roas
 *      → scale
 *   5. else no_action
 *
 * ROAS heuristic: spec deliberately punts real per-conversion-value
 * tracking to Phase 6. Until then, every conversion is treated as worth
 * ASSUMED_CONVERSION_VALUE_USD. This is a knob, not a truth.
 */

const MIN_SPEND_FOR_CPC_RULE_USD = 3;
const MIN_IMPRESSIONS_FOR_CTR_RULE = 1000;

export type DecisionAction = 'kill' | 'scale' | 'no_action';

export interface DecisionInput {
  /** Per-ad current daily budget (from launched_ads.daily_budget_usd). */
  currentDailyBudgetUsd: number;
  /** Insights snapshot. spend in USD, ctr in %, cpc in USD. */
  metrics: {
    spendUsd: number;
    impressions: number;
    clicks: number;
    conversions: number;
    ctrPct: number;
    cpcUsd: number;
  };
  /** True if a pending approval already exists for this ad. */
  hasPendingApproval: boolean;
  /** User-side thresholds + counters. */
  settings: {
    killMaxCpcUsd: number;
    killNoConvSpendUsd: number;
    killMinCtrPct: number;
    scaleMinRoas: number;
    scaleMinSpendUsd: number;
    scaleIncrementPct: number;
    scaleMaxDailyBudgetUsd: number;
    /** Per-user counter for the first-N-scales +25% hardcoded cap. */
    scaleSuccessCount: number;
    /** Existing Phase-4a daily launch cap (committed today). */
    remainingDailyLaunchBudgetUsd: number;
  };
}

export interface DecisionResult {
  action: DecisionAction;
  reason: string;
  /** Only set for action='scale'. The post-cap proposed budget. */
  proposedBudgetUsd?: number;
  /**
   * For scale: which clamp landed (if any). Useful for the Telegram
   * prompt: "scaled to $5 (capped by first-launch +25%)".
   */
  scaleCapApplied?:
    | 'first_scales_grace'
    | 'hard_2x'
    | 'settings_max'
    | 'remaining_daily_launch_cap'
    | null;
}

export function evaluatePerformance(input: DecisionInput): DecisionResult {
  if (input.hasPendingApproval) {
    return { action: 'no_action', reason: 'pending approval already exists' };
  }

  const { metrics, settings } = input;

  // --- Kill rules ---
  if (metrics.spendUsd >= settings.killNoConvSpendUsd && metrics.conversions === 0) {
    return {
      action: 'kill',
      reason: `Spent $${metrics.spendUsd.toFixed(2)} with 0 conversions (threshold $${settings.killNoConvSpendUsd.toFixed(
        2,
      )}).`,
    };
  }
  if (metrics.cpcUsd > settings.killMaxCpcUsd && metrics.spendUsd >= MIN_SPEND_FOR_CPC_RULE_USD) {
    return {
      action: 'kill',
      reason: `CPC $${metrics.cpcUsd.toFixed(2)} above max $${settings.killMaxCpcUsd.toFixed(
        2,
      )} (after $${MIN_SPEND_FOR_CPC_RULE_USD} spent).`,
    };
  }
  if (
    metrics.ctrPct < settings.killMinCtrPct &&
    metrics.impressions >= MIN_IMPRESSIONS_FOR_CTR_RULE
  ) {
    return {
      action: 'kill',
      reason: `CTR ${metrics.ctrPct.toFixed(2)}% below min ${settings.killMinCtrPct.toFixed(
        2,
      )}% (after ${MIN_IMPRESSIONS_FOR_CTR_RULE} impressions).`,
    };
  }

  // --- Scale rule ---
  if (metrics.conversions > 0 && metrics.spendUsd >= settings.scaleMinSpendUsd) {
    const impliedRoas = computeImpliedRoas(metrics.conversions, metrics.spendUsd);
    if (impliedRoas >= settings.scaleMinRoas) {
      const { proposedBudgetUsd, capApplied } = computeProposedScale({
        currentDailyBudgetUsd: input.currentDailyBudgetUsd,
        settings,
      });
      // Edge case: every cap collapses the proposed budget below the
      // current one. Don't propose a no-op scale.
      if (proposedBudgetUsd <= input.currentDailyBudgetUsd) {
        return {
          action: 'no_action',
          reason: `Scale signal hit but caps left no headroom (current $${input.currentDailyBudgetUsd.toFixed(
            2,
          )}, max headroom $${proposedBudgetUsd.toFixed(2)}).`,
        };
      }
      return {
        action: 'scale',
        reason: `ROAS ${impliedRoas.toFixed(2)} ≥ ${settings.scaleMinRoas.toFixed(
          2,
        )} after $${metrics.spendUsd.toFixed(2)} spend (${metrics.conversions} conversions).`,
        proposedBudgetUsd,
        scaleCapApplied: capApplied,
      };
    }
  }

  return { action: 'no_action', reason: 'metrics within thresholds' };
}

/** Implied ROAS uses ASSUMED_CONVERSION_VALUE_USD until Phase 6 wires Pixel. */
export function computeImpliedRoas(conversions: number, spendUsd: number): number {
  if (spendUsd <= 0) return 0;
  return (conversions * ASSUMED_CONVERSION_VALUE_USD) / spendUsd;
}

/**
 * Compute the proposed new daily budget after the user's chosen
 * increment is clamped through every safety: user's max, hard 2× per
 * scale event, first-N-scales +25% grace, and the launch cap's
 * remaining headroom today.
 */
export function computeProposedScale(input: {
  currentDailyBudgetUsd: number;
  settings: {
    scaleIncrementPct: number;
    scaleMaxDailyBudgetUsd: number;
    scaleSuccessCount: number;
    remainingDailyLaunchBudgetUsd: number;
  };
}): { proposedBudgetUsd: number; capApplied: DecisionResult['scaleCapApplied'] } {
  const { currentDailyBudgetUsd, settings } = input;
  const userIncrementPct = settings.scaleIncrementPct;
  const inGrace = settings.scaleSuccessCount < FIRST_SCALES_GRACE_COUNT;
  const effectiveIncrementPct = inGrace
    ? Math.min(userIncrementPct, FIRST_SCALES_INCREMENT_PCT_CAP)
    : userIncrementPct;

  const rawProposed = currentDailyBudgetUsd * (1 + effectiveIncrementPct / 100);
  const hardCapByMultiplier = currentDailyBudgetUsd * SCALE_HARD_MULTIPLIER_CAP;

  // Track which clamp wins so the UI can explain it.
  let capApplied: DecisionResult['scaleCapApplied'] = null;
  let clamped = rawProposed;
  if (clamped > hardCapByMultiplier) {
    clamped = hardCapByMultiplier;
    capApplied = 'hard_2x';
  }
  if (clamped > settings.scaleMaxDailyBudgetUsd) {
    clamped = settings.scaleMaxDailyBudgetUsd;
    capApplied = 'settings_max';
  }
  const launchHeadroom = currentDailyBudgetUsd + settings.remainingDailyLaunchBudgetUsd;
  if (clamped > launchHeadroom) {
    clamped = launchHeadroom;
    capApplied = 'remaining_daily_launch_cap';
  }
  if (inGrace && rawProposed > clamped && capApplied === null) {
    capApplied = 'first_scales_grace';
  }
  // If we trimmed because of the grace cap specifically (i.e. user
  // wanted 50% but we capped at 25%), credit the grace tag too.
  if (inGrace && userIncrementPct > FIRST_SCALES_INCREMENT_PCT_CAP && capApplied === null) {
    capApplied = 'first_scales_grace';
  }

  return { proposedBudgetUsd: round2(Math.max(0, clamped)), capApplied };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
