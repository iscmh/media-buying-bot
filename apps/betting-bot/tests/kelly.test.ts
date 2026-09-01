import { describe, expect, it } from 'vitest';
import { expectedValue, kellyFraction, recommendedStake } from '../src/core/kelly.js';

describe('kelly', () => {
  it('is zero for a fair coin at fair odds', () => {
    expect(kellyFraction(0.5, 2.0)).toBeCloseTo(0);
  });

  it('computes the classic example: 55% at evens → 10% of bankroll', () => {
    expect(kellyFraction(0.55, 2.0)).toBeCloseTo(0.1);
  });

  it('is negative for -EV bets', () => {
    expect(kellyFraction(0.45, 2.0)).toBeLessThan(0);
  });

  it('never recommends a stake on a -EV bet', () => {
    const stake = recommendedStake(0.45, 2.0, {
      bankroll: 1000,
      kellyMultiplier: 0.25,
      maxStakePct: 0.02,
    });
    expect(stake).toBe(0);
  });

  it('caps stakes at maxStakePct', () => {
    const stake = recommendedStake(0.7, 2.0, {
      bankroll: 1000,
      kellyMultiplier: 1,
      maxStakePct: 0.02,
    });
    expect(stake).toBe(20);
  });

  it('applies the fractional multiplier', () => {
    const stake = recommendedStake(0.55, 2.0, {
      bankroll: 1000,
      kellyMultiplier: 0.25,
      maxStakePct: 0.5,
    });
    expect(stake).toBeCloseTo(25);
  });
});

describe('expectedValue', () => {
  it('is zero at fair odds', () => {
    expect(expectedValue(0.5, 2.0)).toBeCloseTo(0);
  });

  it('matches hand calculation', () => {
    // 52% to win at +100: 0.52*1 - 0.48 = 0.04
    expect(expectedValue(0.52, 2.0)).toBeCloseTo(0.04);
  });
});
