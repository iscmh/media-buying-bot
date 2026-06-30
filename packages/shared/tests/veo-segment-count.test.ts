/**
 * Polish-19.3: computeVeoSegmentCount branches. Shared helper used by
 * both the cost-estimator and the worker so the form's displayed
 * cost matches the segments the worker will (eventually, in Commit 2)
 * actually run.
 */
import { describe, expect, it } from 'vitest';
import { computeAutoVeoSegmentCount, computeVeoSegmentCount } from '../src/cost-estimation';

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

describe('Polish-19.3.1: computeAutoVeoSegmentCount', () => {
  // Auto path — rounds source duration up to the nearest power-of-2
  // segment count (1/2/4/8). Distinct from computeVeoSegmentCount
  // (strict ceil/8) because the simplified form no longer has a
  // length picker for Veo; auto-resolve from source video duration
  // with a 30s default when no source signal is available.

  it('missing source → 4 segments (30s default UGC output)', () => {
    expect(computeAutoVeoSegmentCount(null)).toBe(4);
    expect(computeAutoVeoSegmentCount(undefined)).toBe(4);
    expect(computeAutoVeoSegmentCount(0)).toBe(4);
    expect(computeAutoVeoSegmentCount(NaN)).toBe(4);
    expect(computeAutoVeoSegmentCount(-5)).toBe(4);
  });

  it('≤8s source → 1 segment (single 8s output)', () => {
    expect(computeAutoVeoSegmentCount(1)).toBe(1);
    expect(computeAutoVeoSegmentCount(7)).toBe(1);
    expect(computeAutoVeoSegmentCount(8)).toBe(1);
  });

  it('9-16s source → 2 segments (16s output)', () => {
    expect(computeAutoVeoSegmentCount(9)).toBe(2);
    expect(computeAutoVeoSegmentCount(12)).toBe(2);
    expect(computeAutoVeoSegmentCount(16)).toBe(2);
  });

  it('17-32s source → 4 segments (32s output)', () => {
    expect(computeAutoVeoSegmentCount(17)).toBe(4);
    expect(computeAutoVeoSegmentCount(25)).toBe(4);
    expect(computeAutoVeoSegmentCount(32)).toBe(4);
  });

  it('>32s source → 8 segments (capped at 64s output)', () => {
    expect(computeAutoVeoSegmentCount(33)).toBe(8);
    expect(computeAutoVeoSegmentCount(60)).toBe(8);
    expect(computeAutoVeoSegmentCount(120)).toBe(8);
    expect(computeAutoVeoSegmentCount(9999)).toBe(8);
  });
});
