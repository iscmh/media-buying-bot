/**
 * Polish-19.3: computeVeoSegmentCount branches. Shared helper used by
 * both the cost-estimator and the worker so the form's displayed
 * cost matches the segments the worker will (eventually, in Commit 2)
 * actually run.
 */
import { describe, expect, it } from 'vitest';
import { computeVeoSegmentCount } from '../src/cost-estimation';

describe('Polish-19.3: computeVeoSegmentCount', () => {
  it('returns 1 for the 8s preset (single-segment trivial case)', () => {
    expect(computeVeoSegmentCount(8)).toBe(1);
  });

  it('returns 2 for the 15s preset (ceil(15/8) = 2)', () => {
    expect(computeVeoSegmentCount(15)).toBe(2);
    expect(computeVeoSegmentCount(16)).toBe(2);
  });

  it('returns 4 for the 30s preset (ceil(30/8) = 4)', () => {
    expect(computeVeoSegmentCount(30)).toBe(4);
  });

  it('returns 8 for the 60s preset (ceil(60/8) = 8)', () => {
    expect(computeVeoSegmentCount(60)).toBe(8);
  });

  it('rounds fractional seconds up — caller never gets under-coverage', () => {
    expect(computeVeoSegmentCount(8.1)).toBe(2);
    expect(computeVeoSegmentCount(17.5)).toBe(3);
  });

  it('clamps to MAX_SEGMENTS=8 for runaway inputs (cost stays finite)', () => {
    expect(computeVeoSegmentCount(100)).toBe(8);
    expect(computeVeoSegmentCount(99_999)).toBe(8);
  });

  it('returns 1 as the safe floor for zero / negative / NaN / Infinity', () => {
    // Number.isFinite() rejects all three of NaN / +Infinity / -Infinity,
    // so the early-return branch fires and we hand back 1 segment as
    // the floor.
    expect(computeVeoSegmentCount(0)).toBe(1);
    expect(computeVeoSegmentCount(-3)).toBe(1);
    expect(computeVeoSegmentCount(NaN)).toBe(1);
    expect(computeVeoSegmentCount(Infinity)).toBe(1);
  });
});
