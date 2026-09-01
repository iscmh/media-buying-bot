/** Odds conversions and de-vigging (removing the bookmaker margin). */

export function americanToDecimal(odds: number): number {
  if (odds === 0 || !Number.isFinite(odds)) {
    throw new Error(`Invalid American odds: ${odds}`);
  }
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new Error(`Invalid decimal odds: ${decimal}`);
  }
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

/** Raw implied probability of a decimal price (includes the vig). */
export function impliedProb(decimal: number): number {
  return 1 / decimal;
}

/** Total book margin (overround) of a market, e.g. 0.045 = 4.5% vig. */
export function overround(decimals: number[]): number {
  return decimals.reduce((sum, d) => sum + 1 / d, 0) - 1;
}

/**
 * Multiplicative de-vig: scale implied probabilities to sum to 1.
 * Simple and robust, but slightly overrates longshots.
 */
export function devigMultiplicative(decimals: number[]): number[] {
  const implied = decimals.map(impliedProb);
  const total = implied.reduce((a, b) => a + b, 0);
  return implied.map((p) => p / total);
}

/**
 * Power de-vig: find k so that sum(p_i^k) = 1 and use p_i^k.
 * Corrects for the favorite-longshot bias better than multiplicative.
 * Solved by bisection on k in (0, ~10].
 */
export function devigPower(decimals: number[]): number[] {
  const implied = decimals.map(impliedProb);
  const sumAt = (k: number): number => implied.reduce((sum, p) => sum + Math.pow(p, k), 0);

  // sum p_i^k is decreasing in k; find k where it crosses 1.
  let lo = 0.5;
  let hi = 10;
  if (sumAt(lo) < 1) {
    // Degenerate market (underround); fall back to multiplicative.
    return devigMultiplicative(decimals);
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return implied.map((p) => Math.pow(p, k));
}

/**
 * Default de-vig used by the consensus engine: average of the
 * multiplicative and power estimates.
 */
export function devig(decimals: number[]): number[] {
  const mult = devigMultiplicative(decimals);
  const pow = devigPower(decimals);
  return mult.map((p, i) => {
    const pw = pow[i];
    return pw === undefined ? p : (p + pw) / 2;
  });
}
