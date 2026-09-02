/**
 * Polish-29.0.3 Commit 113: balance-tone thresholds. The pill's
 * color transitions are the single most user-visible signal that
 * they need to top up — pin them down so a stray refactor can't
 * silently downgrade the "you're about to run out" cue.
 */
import { describe, expect, it } from 'vitest';
import {
  CRITICAL_BALANCE_THRESHOLD,
  LOW_BALANCE_THRESHOLD,
  isCriticalBalance,
  isLowBalance,
} from '../balance-pill';

describe('balance thresholds', () => {
  it('critical fires at or below 20 credits', () => {
    expect(CRITICAL_BALANCE_THRESHOLD).toBe(20);
    expect(isCriticalBalance(0)).toBe(true);
    expect(isCriticalBalance(20)).toBe(true);
    expect(isCriticalBalance(21)).toBe(false);
  });

  it('low fires at or below 200 credits', () => {
    expect(LOW_BALANCE_THRESHOLD).toBe(200);
    expect(isLowBalance(200)).toBe(true);
    expect(isLowBalance(199)).toBe(true);
    expect(isLowBalance(201)).toBe(false);
  });

  it('critical is a subset of low — every critical balance is also low', () => {
    for (const b of [0, 5, 10, 20]) {
      expect(isCriticalBalance(b)).toBe(true);
      expect(isLowBalance(b)).toBe(true);
    }
  });

  it('healthy balance (>=201) is neither low nor critical', () => {
    for (const b of [201, 500, 2500, 10000]) {
      expect(isLowBalance(b)).toBe(false);
      expect(isCriticalBalance(b)).toBe(false);
    }
  });
});
