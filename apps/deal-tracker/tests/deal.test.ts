import { describe, expect, it } from 'vitest';
import { bestDeals, currentBest, evaluateQuote, isPlausible, shouldDeliver } from '../src/deal.js';
import { emptyState, recordAlert } from '../src/store.js';
import type { TrackerState } from '../src/types.js';
import { quote, testConfig } from './helpers.js';

function seeded(): TrackerState {
  const state = emptyState();
  state.baselineComplete = true;
  return state;
}

describe('evaluateQuote', () => {
  it('stays silent on the first sighting while the baseline is still building', () => {
    const state = emptyState();
    const { alert, tracked } = evaluateQuote(testConfig(), state, quote());
    expect(alert).toBeUndefined();
    expect(tracked.bestTotal).toBe(3000);
  });

  it('fires a target hit even before the baseline completes', () => {
    const state = emptyState();
    const cfg = testConfig({ TRACKER_TARGET_TOTAL: 3100 });
    const { alert } = evaluateQuote(cfg, state, quote({ total: 3000 }));
    expect(alert?.reason).toBe('target_hit');
  });

  it('fires a target hit on price per person per night', () => {
    const state = emptyState();
    // 2800 / (7 nights × 4 people) = 100 pp/night
    const cfg = testConfig({ TRACKER_TARGET_PPPN: 100 });
    const { alert } = evaluateQuote(cfg, state, quote({ total: 2800 }));
    expect(alert?.reason).toBe('target_hit');
    expect(alert?.pppn).toBe(100);
  });

  it('reports a new all-time low', () => {
    const cfg = testConfig();
    const state = seeded();
    const first = evaluateQuote(cfg, state, quote({ total: 3000 }));
    state.prices[first.key] = first.tracked;

    const { alert } = evaluateQuote(cfg, state, quote({ total: 2800 }));
    expect(alert?.reason).toBe('new_low');
    expect(alert?.previousBest).toBe(3000);
    expect(alert?.changePct).toBeCloseTo(-6.67, 1);
  });

  it('ignores a sub-noise "drop" that is not really a new low', () => {
    const cfg = testConfig({ TRACKER_DROP_PCT: 5 });
    const state = seeded();
    const first = evaluateQuote(cfg, state, quote({ total: 3000 }));
    state.prices[first.key] = first.tracked;

    const { alert } = evaluateQuote(cfg, state, quote({ total: 2999 }));
    expect(alert).toBeUndefined();
  });

  it('reports a drop from the last price even when an older low was cheaper', () => {
    const cfg = testConfig({ TRACKER_DROP_PCT: 5 });
    const state = seeded();
    let result = evaluateQuote(cfg, state, quote({ total: 2500 })); // old low
    state.prices[result.key] = result.tracked;
    result = evaluateQuote(cfg, state, quote({ total: 3200 })); // went back up
    state.prices[result.key] = result.tracked;

    const { alert } = evaluateQuote(cfg, state, quote({ total: 2900 }));
    expect(alert?.reason).toBe('price_drop');
    expect(alert?.previousTotal).toBe(3200);
  });

  it('suppresses a repeat alert inside the cooldown window', () => {
    const cfg = testConfig({ TRACKER_ALERT_COOLDOWN_HOURS: 6 });
    const state = seeded();
    const first = evaluateQuote(cfg, state, quote({ total: 3000 }));
    state.prices[first.key] = first.tracked;

    const second = evaluateQuote(cfg, state, quote({ total: 2800 }));
    expect(second.alert?.reason).toBe('new_low');
    state.prices[second.key] = second.tracked;
    recordAlert(state, { key: second.key, reason: 'new_low', at: Date.now(), total: 2800 });

    const third = evaluateQuote(cfg, state, quote({ total: 2700 }));
    expect(third.alert).toBeUndefined();

    // …and speaks again once the cooldown has elapsed.
    const later = Date.now() + 7 * 60 * 60 * 1000;
    const fourth = evaluateQuote(cfg, state, quote({ total: 2600 }), later);
    expect(fourth.alert?.reason).toBe('new_low');
  });

  it('flags an offer that reappears after a long absence', () => {
    const cfg = testConfig();
    const state = seeded();
    const observedAt = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const first = evaluateQuote(cfg, state, quote({ total: 3000, observedAt }), observedAt);
    state.prices[first.key] = first.tracked;

    const { alert } = evaluateQuote(cfg, state, quote({ total: 3000 }));
    expect(alert?.reason).toBe('back_in_stock');
  });

  it('lets a Telegram override beat the env default', () => {
    const cfg = testConfig({ TRACKER_TARGET_TOTAL: 1000 });
    const state = seeded();
    state.overrides.targetTotal = 3100;
    const { alert } = evaluateQuote(cfg, state, quote({ total: 3000 }));
    expect(alert?.reason).toBe('target_hit');
  });
});

describe('isPlausible', () => {
  const cfg = testConfig({ TRACKER_MIN_PLAUSIBLE_TOTAL: 150, TRACKER_MAX_PLAUSIBLE_TOTAL: 30_000 });

  it('rejects a per-night figure scraped as if it were a total', () => {
    expect(isPlausible(cfg, quote({ total: 89 }))).toBe(false);
  });

  it('rejects a wrong-currency outlier', () => {
    expect(isPlausible(cfg, quote({ total: 58_000 }))).toBe(false);
  });

  it('accepts a sane total', () => {
    expect(isPlausible(cfg, quote({ total: 2980 }))).toBe(true);
  });
});

describe('shouldDeliver', () => {
  const cfg = testConfig({ TRACKER_QUIET_HOURS: '23-8', quietHours: { from: 23, to: 8 } });
  const at = (hour: number): Date => new Date(2027, 0, 1, hour, 0, 0);

  it('holds routine alerts during quiet hours', () => {
    const alert = { reason: 'price_drop' as const, quote: quote(), pppn: 100 };
    expect(shouldDeliver(cfg, alert, at(2))).toBe(false);
    expect(shouldDeliver(cfg, alert, at(12))).toBe(true);
  });

  it('always delivers a target hit', () => {
    const alert = { reason: 'target_hit' as const, quote: quote(), pppn: 100 };
    expect(shouldDeliver(cfg, alert, at(2))).toBe(true);
  });
});

describe('leaderboards', () => {
  it('ranks by price per person per night, not raw total', () => {
    const cfg = testConfig();
    const state = seeded();
    for (const q of [
      quote({ checkIn: '2027-06-05', nights: 7, label: 'A', total: 2800 }), // 100 pp/n
      quote({ checkIn: '2027-06-12', nights: 14, label: 'B', total: 4480 }), // 80 pp/n
    ]) {
      const result = evaluateQuote(cfg, state, q);
      state.prices[result.key] = result.tracked;
    }
    expect(bestDeals(cfg, state).map((d) => d.label)).toEqual(['B', 'A']);
  });

  it('drops stale offers from the "on sale now" list', () => {
    const cfg = testConfig();
    const state = seeded();
    const stale = evaluateQuote(cfg, state, quote({ label: 'stale', observedAt: 1_000 }), 1_000);
    state.prices[stale.key] = stale.tracked;
    const fresh = evaluateQuote(cfg, state, quote({ label: 'fresh', checkIn: '2027-07-01' }));
    state.prices[fresh.key] = fresh.tracked;

    expect(currentBest(cfg, state).map((d) => d.label)).toEqual(['fresh']);
  });
});
