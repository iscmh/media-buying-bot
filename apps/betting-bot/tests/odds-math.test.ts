import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  decimalToAmerican,
  devig,
  devigMultiplicative,
  devigPower,
  overround,
} from '../src/core/odds-math.js';

describe('odds conversions', () => {
  it('converts American to decimal', () => {
    expect(americanToDecimal(+100)).toBeCloseTo(2.0);
    expect(americanToDecimal(-110)).toBeCloseTo(1.9091, 3);
    expect(americanToDecimal(+250)).toBeCloseTo(3.5);
    expect(americanToDecimal(-400)).toBeCloseTo(1.25);
  });

  it('round-trips decimal ↔ American', () => {
    for (const odds of [-450, -110, +105, +320]) {
      expect(decimalToAmerican(americanToDecimal(odds))).toBe(odds);
    }
  });

  it('rejects invalid odds', () => {
    expect(() => americanToDecimal(0)).toThrow();
    expect(() => decimalToAmerican(1)).toThrow();
  });
});

describe('overround', () => {
  it('measures the vig on a standard -110/-110 market', () => {
    const decimals = [americanToDecimal(-110), americanToDecimal(-110)];
    expect(overround(decimals)).toBeCloseTo(0.0476, 3);
  });
});

describe('de-vigging', () => {
  it('multiplicative probabilities sum to 1', () => {
    const probs = devigMultiplicative([1.9091, 1.9091]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(probs[0]).toBeCloseTo(0.5);
  });

  it('power probabilities sum to 1 on lopsided markets', () => {
    const probs = devigPower([1.25, 4.2]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('power de-vig gives the favorite more than multiplicative', () => {
    const decimals = [1.2, 5.0];
    const mult = devigMultiplicative(decimals);
    const pow = devigPower(decimals);
    expect(pow[0]).toBeGreaterThan(mult[0] ?? 0);
  });

  it('blended de-vig sums to ~1', () => {
    const probs = devig([1.5, 3.1, 8.0]);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
  });
});
