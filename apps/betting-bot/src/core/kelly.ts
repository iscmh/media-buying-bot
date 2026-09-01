/** Kelly-criterion stake sizing. */

/**
 * Full-Kelly fraction of bankroll for a bet at decimal odds `decimal`
 * with true win probability `p`. Negative when the bet is -EV.
 */
export function kellyFraction(p: number, decimal: number): number {
  const b = decimal - 1;
  if (b <= 0) return 0;
  return (p * b - (1 - p)) / b;
}

export interface StakeParams {
  bankroll: number;
  /** Kelly multiplier, e.g. 0.25 for quarter Kelly. */
  kellyMultiplier: number;
  /** Hard cap as fraction of bankroll, e.g. 0.02. */
  maxStakePct: number;
}

/** Recommended stake (currency units), never negative, always capped. */
export function recommendedStake(p: number, decimal: number, params: StakeParams): number {
  const kelly = kellyFraction(p, decimal);
  if (kelly <= 0) return 0;
  const fraction = Math.min(kelly * params.kellyMultiplier, params.maxStakePct);
  return Math.round(params.bankroll * fraction * 100) / 100;
}

/** Expected value per unit staked: p * (decimal - 1) - (1 - p). */
export function expectedValue(p: number, decimal: number): number {
  return p * (decimal - 1) - (1 - p);
}
