import type { Config } from './config.js';
import { inQuietHours } from './config.js';
import { pricePerPersonPerNight, quoteKey } from './matrix.js';
import { lastAlertAt, upsertPrice } from './store.js';
import type { Alert, Quote, TrackedPrice, TrackerState } from './types.js';

/** A price must improve by at least this much to count as a new low (noise guard). */
const NEW_LOW_EPSILON = 0.005;
/** An offer unseen for this long that reappears is treated as newly released. */
const BACK_IN_STOCK_GAP_MS = 48 * 60 * 60 * 1000;

export interface Thresholds {
  dropPct: number;
  targetTotal?: number;
  targetPppn?: number;
}

/** Env defaults, overlaid with anything changed at runtime over Telegram. */
export function resolveThresholds(cfg: Config, state: TrackerState): Thresholds {
  const targetTotal = state.overrides.targetTotal ?? cfg.TRACKER_TARGET_TOTAL;
  const targetPppn = state.overrides.targetPppn ?? cfg.TRACKER_TARGET_PPPN;
  return {
    dropPct: state.overrides.dropPct ?? cfg.TRACKER_DROP_PCT,
    ...(targetTotal !== undefined ? { targetTotal } : {}),
    ...(targetPppn !== undefined ? { targetPppn } : {}),
  };
}

export function isPlausible(cfg: Config, quote: Quote): boolean {
  return (
    Number.isFinite(quote.total) &&
    quote.total >= cfg.TRACKER_MIN_PLAUSIBLE_TOTAL &&
    quote.total <= cfg.TRACKER_MAX_PLAUSIBLE_TOTAL
  );
}

export interface EvaluationResult {
  key: string;
  tracked: TrackedPrice;
  alert?: Alert;
}

/**
 * Folds one observed quote into state and decides whether it is worth
 * waking someone up for.
 *
 * Ordering matters: a quote that hits the target price is reported as a
 * target hit even if it is also an all-time low, because "this is the
 * holiday you said you'd book" beats "this is cheaper than yesterday".
 */
export function evaluateQuote(
  cfg: Config,
  state: TrackerState,
  quote: Quote,
  now = Date.now(),
): EvaluationResult {
  const key = quoteKey(quote);
  const existing = state.prices[key];
  const tracked = { ...upsertPrice(existing, quote), key };
  const pppn = pricePerPersonPerNight(quote.total, quote.nights, cfg.partySize);
  const thresholds = resolveThresholds(cfg, state);

  const base: Omit<Alert, 'reason'> = {
    quote,
    pppn,
    ...(existing ? { previousTotal: existing.lastTotal, previousBest: existing.bestTotal } : {}),
    ...(existing
      ? { changePct: ((quote.total - existing.lastTotal) / existing.lastTotal) * 100 }
      : {}),
  };

  const hitsTarget =
    (thresholds.targetTotal !== undefined && quote.total <= thresholds.targetTotal) ||
    (thresholds.targetPppn !== undefined && pppn <= thresholds.targetPppn);

  // Before the first full sweep completes every offer looks like news, so
  // only a genuine target hit is allowed to fire. Everything else waits.
  const allowNonTargetAlerts = state.baselineComplete && existing !== undefined;

  let reason: Alert['reason'] | undefined;
  if (hitsTarget) {
    reason = 'target_hit';
  } else if (allowNonTargetAlerts && existing) {
    if (quote.total < existing.bestTotal * (1 - NEW_LOW_EPSILON)) {
      reason = 'new_low';
    } else if (quote.total <= existing.lastTotal * (1 - thresholds.dropPct / 100)) {
      reason = 'price_drop';
    } else if (now - existing.lastSeenAt > BACK_IN_STOCK_GAP_MS) {
      reason = 'back_in_stock';
    }
  }

  if (!reason) return { key, tracked };

  const cooldownMs = cfg.TRACKER_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const previous = lastAlertAt(state, key, reason);
  if (previous !== undefined && now - previous < cooldownMs) {
    return { key, tracked };
  }

  return { key, tracked, alert: { ...base, reason } };
}

/**
 * Quiet hours suppress the drip of routine drops but never a target hit —
 * the whole point of setting a target is to catch it before someone else does.
 */
export function shouldDeliver(cfg: Config, alert: Alert, now = new Date()): boolean {
  if (alert.reason === 'target_hit') return true;
  return !inQuietHours(cfg, now);
}

export interface RankedDeal extends TrackedPrice {
  pppn: number;
}

/** Cheapest tracked offers by price per person per night. */
export function bestDeals(cfg: Config, state: TrackerState, limit = 5): RankedDeal[] {
  return Object.values(state.prices)
    .map((price) => ({
      ...price,
      pppn: pricePerPersonPerNight(price.bestTotal, price.nights, cfg.partySize),
    }))
    .sort((a, b) => a.pppn - b.pppn)
    .slice(0, limit);
}

/** Cheapest offers seen in the last `windowMs`, i.e. still bookable-ish. */
export function currentBest(
  cfg: Config,
  state: TrackerState,
  limit = 5,
  windowMs = 36 * 60 * 60 * 1000,
  now = Date.now(),
): RankedDeal[] {
  return Object.values(state.prices)
    .filter((price) => now - price.lastSeenAt <= windowMs)
    .map((price) => ({
      ...price,
      pppn: pricePerPersonPerNight(price.lastTotal, price.nights, cfg.partySize),
    }))
    .sort((a, b) => a.pppn - b.pppn)
    .slice(0, limit);
}
