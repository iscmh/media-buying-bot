/**
 * Polish-3.5: currency conversion math.
 *
 * The actual bug Denis hit: bot sends 1000 USD-cents (=$10) to a
 * RON-denominated Meta account; Meta interprets it as 1000 bani (=10
 * RON ≈ $2.20), which is below the RON daily-budget minimum, so the
 * ad rejects with an opaque "Invalid parameter". These tests lock the
 * conversion math + minimum-enforcement behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBudgetMeetsMetaMinimum,
  computeAccountBudgetMinor,
  convertUsdToAccount,
  metaMinimumMinor,
  toMinorUnits,
  USD_EXCHANGE_RATES,
} from '../src/currency';

describe('convertUsdToAccount', () => {
  it('is a no-op for USD', () => {
    expect(convertUsdToAccount(10, 'USD')).toBe(10);
    expect(convertUsdToAccount(0.01, 'USD')).toBe(0.01);
  });

  it('uses the documented rate for RON (the actual bug)', () => {
    // $10 USD × 4.55 RON/USD = 45.50 RON
    expect(convertUsdToAccount(10, 'RON')).toBeCloseTo(45.5, 2);
  });

  it('rounds to 2 decimals for fractional-minor currencies', () => {
    const result = convertUsdToAccount(1.234, 'EUR');
    expect(Number.isFinite(result)).toBe(true);
    expect(result.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('rounds to 0 decimals for whole-minor currencies (JPY)', () => {
    const result = convertUsdToAccount(10.5, 'JPY');
    expect(result % 1).toBe(0);
  });

  it('treats unknown currency as USD (defensive)', () => {
    expect(convertUsdToAccount(10, 'ZZZ')).toBe(10);
  });

  it('is case-insensitive on currency codes', () => {
    expect(convertUsdToAccount(10, 'ron')).toBeCloseTo(45.5, 2);
    expect(convertUsdToAccount(10, 'Ron')).toBeCloseTo(45.5, 2);
  });
});

describe('toMinorUnits', () => {
  it('multiplies by 100 for cent-currencies', () => {
    expect(toMinorUnits(10, 'USD')).toBe(1000);
    expect(toMinorUnits(45.5, 'RON')).toBe(4550);
  });

  it('floors instead of rounds (never over-budget)', () => {
    expect(toMinorUnits(10.999, 'USD')).toBe(1099);
    expect(toMinorUnits(45.999, 'RON')).toBe(4599);
  });

  it('passes through for whole-minor currencies', () => {
    expect(toMinorUnits(1500, 'JPY')).toBe(1500);
    expect(toMinorUnits(360, 'HUF')).toBe(360);
  });
});

describe('computeAccountBudgetMinor', () => {
  it('USD $10 → 1000 cents (the baseline)', () => {
    const r = computeAccountBudgetMinor(10, 'USD');
    expect(r.minor).toBe(1000);
    expect(r.major).toBe(10);
    expect(r.currency).toBe('USD');
  });

  it('RON $10 → 4550 bani (the bug Denis hit)', () => {
    const r = computeAccountBudgetMinor(10, 'RON');
    expect(r.minor).toBe(4550);
    expect(r.major).toBeCloseTo(45.5, 2);
    expect(r.currency).toBe('RON');
  });

  it('JPY $10 → 1500 yen (no minor unit)', () => {
    const r = computeAccountBudgetMinor(10, 'JPY');
    expect(r.minor).toBe(1500);
    expect(r.major).toBe(1500);
  });
});

describe('metaMinimumMinor', () => {
  it('returns the documented RON minimum (450 bani)', () => {
    expect(metaMinimumMinor('RON')).toBe(450);
  });

  it('returns 100 cents for USD', () => {
    expect(metaMinimumMinor('USD')).toBe(100);
  });

  it('prefers connection-specific override when provided', () => {
    expect(metaMinimumMinor('USD', 500)).toBe(500);
    expect(metaMinimumMinor('RON', 1000)).toBe(1000);
  });

  it('ignores zero or negative connection overrides', () => {
    expect(metaMinimumMinor('USD', 0)).toBe(100);
    expect(metaMinimumMinor('USD', -50)).toBe(100);
  });

  it('falls back to 100 minor for unknown currency', () => {
    expect(metaMinimumMinor('ZZZ')).toBe(100);
  });
});

describe('checkBudgetMeetsMetaMinimum', () => {
  it('USD $10 → ok (clears $1 minimum)', () => {
    const r = checkBudgetMeetsMetaMinimum({ usdAmount: 10, currency: 'USD' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.minor).toBe(1000);
      expect(r.major).toBe(10);
    }
  });

  it('RON $10 → ok (4550 bani clears 450 minimum)', () => {
    const r = checkBudgetMeetsMetaMinimum({ usdAmount: 10, currency: 'RON' });
    expect(r.ok).toBe(true);
  });

  it('USD $0.50 → ok=false with actionable reason', () => {
    const r = checkBudgetMeetsMetaMinimum({ usdAmount: 0.5, currency: 'USD' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/USD/);
      expect(r.reason).toMatch(/\$0\.50/);
      expect(r.reason).toMatch(/1\.00 USD/);
    }
  });

  it('respects connection-specific minimum overrides', () => {
    const r = checkBudgetMeetsMetaMinimum({
      usdAmount: 2,
      currency: 'USD',
      connectionMin: 500, // $5 minimum on this account
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/5\.00 USD/);
    }
  });

  it('produces a USD-equivalent hint in the reason', () => {
    const r = checkBudgetMeetsMetaMinimum({ usdAmount: 0.01, currency: 'RON' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Reason should mention the USD floor (4.50 / 4.55 ≈ $0.99).
      expect(r.reason).toMatch(/\$0?\.\d{2} USD/);
    }
  });
});

describe('rate map sanity', () => {
  it('every rate is a positive finite number', () => {
    for (const [code, rate] of Object.entries(USD_EXCHANGE_RATES)) {
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThan(0);
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('USD is anchored at 1.0', () => {
    expect(USD_EXCHANGE_RATES.USD).toBe(1.0);
  });
});
