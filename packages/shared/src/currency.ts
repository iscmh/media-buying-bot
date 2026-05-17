/**
 * Polish-3.5: Meta ad-account currency handling.
 *
 * Why this exists: Meta's daily_budget API field is denominated in the
 * ad account's currency, in MINOR units (cents, bani, pence, etc.).
 * The bot collects budgets from the user in USD; sending 1000 to a
 * RON-denominated account is interpreted as 1000 bani = 10 RON ≈ $2.20,
 * which is below Meta's minimum daily budget for most objectives.
 *
 * This module owns:
 *   - The exchange-rate map (rough 2026 USD-anchored rates; precision
 *     not required for the MVP — Meta's minimums are coarse and our
 *     budgets are small).
 *   - The MINOR_FACTOR map (10^N exponent per ISO currency).
 *   - The default per-currency Meta minimum daily budget in MINOR
 *     units (used as the fallback when we don't have a connection-
 *     specific value).
 *   - convertUsdToAccount(usdAmount, currency) — returns major-unit
 *     amount in the target currency.
 *   - toMinorUnits(majorAmount, currency) — rounds-down to int minor.
 *   - The combined helper computeAccountBudgetMinor(usd, currency)
 *     that the launch path actually calls.
 *
 * Pure functions, no side effects, fully testable.
 */

/**
 * Rough USD-anchored exchange rates (1 USD = X currency). Hardcoded
 * for the MVP — the budgets in question are small enough that drift
 * between this snapshot and reality doesn't push anyone past Meta's
 * minimums. If precision becomes important later, swap for a daily
 * cron pulling from openexchangerates.org or similar.
 *
 * Snapshot: rough 2026 levels — review yearly.
 */
export const USD_EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.78,
  CAD: 1.36,
  AUD: 1.5,
  RON: 4.55, // Romanian lei
  PLN: 4.0, // Polish zloty
  CZK: 23.0, // Czech koruna
  HUF: 360.0, // Hungarian forint
  BGN: 1.8, // Bulgarian lev
  JPY: 150.0, // Japanese yen
  MXN: 17.0, // Mexican peso
  BRL: 5.0, // Brazilian real
};

/**
 * Major → minor unit exponent. Most currencies use 10^2 (cents); a few
 * (JPY, HUF) use 10^0 (no fractional unit on the API side).
 */
const MINOR_EXPONENT: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  RON: 2,
  PLN: 2,
  CZK: 2,
  BGN: 2,
  BRL: 2,
  MXN: 2,
  // JPY + HUF have no fractional minor unit at the Meta API layer.
  JPY: 0,
  HUF: 0,
};

/**
 * Per-currency default Meta minimum daily budget in MINOR units.
 * Sourced from Meta's documented minimums (subject to objective —
 * these are the conversion-objective floors, which are the worst case).
 * Stored on the connection so a future migration can override; this
 * map is the fallback when we don't have a per-connection value yet.
 */
export const META_MIN_DAILY_BUDGET_MINOR: Record<string, number> = {
  USD: 100, // $1.00
  EUR: 100, // €1.00
  GBP: 80, // £0.80
  CAD: 100, // CA$1.00
  AUD: 100, // AU$1.00
  RON: 450, // 4.50 lei (Meta requires noticeably higher for RON)
  PLN: 200, // 2.00 zł
  CZK: 1500, // 15 Kč
  HUF: 300, // 300 Ft (HUF has no minor unit)
  BGN: 200, // 2.00 лв
  JPY: 100, // ¥100 (no minor unit — value in whole yen)
  MXN: 2000, // MX$20
  BRL: 500, // R$5.00
};

const DEFAULT_MIN_MINOR = 100;

/**
 * Convert a USD amount to the target currency's major units.
 *  - Unknown currency → treat as USD (no-op + warn-worthy).
 *  - Rounds to the currency's natural precision (2 decimal places for
 *    most, 0 for JPY/HUF).
 */
export function convertUsdToAccount(usdAmount: number, currency: string): number {
  const code = currency.toUpperCase();
  const rate = USD_EXCHANGE_RATES[code] ?? 1.0;
  const exponent = MINOR_EXPONENT[code] ?? 2;
  const raw = usdAmount * rate;
  const precision = Math.pow(10, exponent);
  return Math.round(raw * precision) / precision;
}

/**
 * Major-unit amount → MINOR units (int). Rounds DOWN so we never
 * accidentally bump above the user's intended budget by 1 cent.
 */
export function toMinorUnits(majorAmount: number, currency: string): number {
  const exponent = MINOR_EXPONENT[currency.toUpperCase()] ?? 2;
  return Math.floor(majorAmount * Math.pow(10, exponent));
}

/**
 * One-shot helper for the launch path: USD input → minor-unit int
 * ready for Meta's daily_budget field. Returns the major-unit value
 * too for UI display ("USD $10 → RON 45.50").
 */
export function computeAccountBudgetMinor(
  usdAmount: number,
  currency: string,
): { minor: number; major: number; currency: string } {
  const code = currency.toUpperCase();
  const major = convertUsdToAccount(usdAmount, code);
  return {
    minor: toMinorUnits(major, code),
    major,
    currency: code,
  };
}

/**
 * Look up Meta's documented minimum daily budget for a given currency,
 * preferring a connection-specific value when provided. Returned in
 * MINOR units to match the launch path.
 */
export function metaMinimumMinor(currency: string, connectionMin?: number | null): number {
  if (typeof connectionMin === 'number' && connectionMin > 0) return connectionMin;
  return META_MIN_DAILY_BUDGET_MINOR[currency.toUpperCase()] ?? DEFAULT_MIN_MINOR;
}

/**
 * Pre-flight check: would the converted budget clear Meta's minimum?
 *  ok=true  → safe to send to Meta
 *  ok=false → human-friendly reason + the numbers needed to fix it
 */
export function checkBudgetMeetsMetaMinimum(input: {
  usdAmount: number;
  currency: string;
  connectionMin?: number | null;
}): { ok: true; minor: number; major: number } | { ok: false; reason: string } {
  const { minor, major, currency } = computeAccountBudgetMinor(input.usdAmount, input.currency);
  const min = metaMinimumMinor(currency, input.connectionMin);
  if (minor >= min) return { ok: true, minor, major };
  const minMajor = min / Math.pow(10, MINOR_EXPONENT[currency] ?? 2);
  // Walk the USD value upward to find the minimum acceptable input.
  // Cheaper than a full inverse — currencies are cheap to compare.
  const rate = USD_EXCHANGE_RATES[currency] ?? 1.0;
  const requiredUsd = minMajor / rate;
  return {
    ok: false,
    reason:
      `Budget below Meta minimum for ${currency}: account requires at least ${minMajor.toFixed(2)} ${currency} ` +
      `(≈ $${requiredUsd.toFixed(2)} USD). You entered $${input.usdAmount.toFixed(2)} USD → ` +
      `${major.toFixed(2)} ${currency}.`,
  };
}
