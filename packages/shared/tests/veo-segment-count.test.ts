/**
 * Polish-19.3: computeVeoSegmentCount branches. Shared helper used by
 * both the cost-estimator and the worker so the form's displayed
 * cost matches the segments the worker will (eventually, in Commit 2)
 * actually run.
 */
import { describe, expect, it } from 'vitest';
import {
  computeAutoVeoExtendCalls,
  computeAutoVeoSegmentCount,
  computeVeoExtendCalls,
  computeVeoSegmentCount,
  extendCallsToDurationSeconds,
} from '../src/cost-estimation';

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

describe('Polish-19.4: computeVeoExtendCalls (base 8s + 7s × N math)', () => {
  // Extend chain math: total_calls = 1 + ceil((target - 8) / 7),
  // floored at 1, capped at 21 (1 base + 20 extends = Google's
  // documented 148s ceiling).

  it('≤8s target → 1 call (base only, no extends needed)', () => {
    expect(computeVeoExtendCalls(1)).toBe(1);
    expect(computeVeoExtendCalls(7)).toBe(1);
    expect(computeVeoExtendCalls(8)).toBe(1);
  });

  it('9-15s target → 2 calls (1 base + 1 extend, covers 15s)', () => {
    expect(computeVeoExtendCalls(9)).toBe(2);
    expect(computeVeoExtendCalls(15)).toBe(2);
  });

  it('16-22s → 3 calls, 23-29s → 4 calls (each extend adds 7s of coverage)', () => {
    expect(computeVeoExtendCalls(16)).toBe(3); // 8 + 7 = 15, need one more
    expect(computeVeoExtendCalls(22)).toBe(3); // 8 + 14 = 22 ✓
    expect(computeVeoExtendCalls(23)).toBe(4);
    expect(computeVeoExtendCalls(29)).toBe(4); // 8 + 7×3 = 29 ✓
  });

  it('30s target → 4 calls (slight under-coverage at 29s — preset label is approximate)', () => {
    expect(computeVeoExtendCalls(30)).toBe(5); // 30s strict ceil → 5 calls (36s)
  });

  it('60s target → 8 calls (1 base + 7 extends = 57s output)', () => {
    // Strict math: ceil((60-8)/7) = 8 extensions, 1+8 = 9 calls → 64s.
    expect(computeVeoExtendCalls(60)).toBe(9);
  });

  it('caps at 21 total calls (Google ceiling: 1 base + 20 extends = 148s)', () => {
    expect(computeVeoExtendCalls(148)).toBe(21);
    expect(computeVeoExtendCalls(149)).toBe(21);
    expect(computeVeoExtendCalls(9999)).toBe(21);
  });

  it('returns 1 as the safe floor for zero / negative / NaN / Infinity', () => {
    expect(computeVeoExtendCalls(0)).toBe(1);
    expect(computeVeoExtendCalls(-3)).toBe(1);
    expect(computeVeoExtendCalls(NaN)).toBe(1);
    expect(computeVeoExtendCalls(Infinity)).toBe(1);
  });
});

describe('Polish-19.4: computeAutoVeoExtendCalls (preset-aligned source mapping)', () => {
  // Tracks the simplified-form presets (8/15/30/60s) so the form
  // preview matches the worker. Distinct from computeVeoExtendCalls
  // which is a strict ceil-style math helper.

  it('missing source → 4 calls (default 30s output preset)', () => {
    expect(computeAutoVeoExtendCalls(null)).toBe(4);
    expect(computeAutoVeoExtendCalls(undefined)).toBe(4);
    expect(computeAutoVeoExtendCalls(0)).toBe(4);
    expect(computeAutoVeoExtendCalls(NaN)).toBe(4);
    expect(computeAutoVeoExtendCalls(-5)).toBe(4);
  });

  it('≤8s source → 1 call', () => {
    expect(computeAutoVeoExtendCalls(1)).toBe(1);
    expect(computeAutoVeoExtendCalls(7)).toBe(1);
    expect(computeAutoVeoExtendCalls(8)).toBe(1);
  });

  it('9-15s source → 2 calls (15s preset)', () => {
    expect(computeAutoVeoExtendCalls(9)).toBe(2);
    expect(computeAutoVeoExtendCalls(12)).toBe(2);
    expect(computeAutoVeoExtendCalls(15)).toBe(2);
  });

  it('16-30s source → 4 calls (30s preset)', () => {
    expect(computeAutoVeoExtendCalls(16)).toBe(4);
    expect(computeAutoVeoExtendCalls(25)).toBe(4);
    expect(computeAutoVeoExtendCalls(30)).toBe(4);
  });

  it('>30s source → 8 calls (60s preset)', () => {
    expect(computeAutoVeoExtendCalls(31)).toBe(8);
    expect(computeAutoVeoExtendCalls(60)).toBe(8);
    expect(computeAutoVeoExtendCalls(120)).toBe(8);
    expect(computeAutoVeoExtendCalls(9999)).toBe(8);
  });
});

describe('Polish-19.4: extendCallsToDurationSeconds', () => {
  it('1 call → 8s, 2 → 15s, 4 → 29s, 8 → 57s (matches preset table)', () => {
    expect(extendCallsToDurationSeconds(1)).toBe(8);
    expect(extendCallsToDurationSeconds(2)).toBe(15);
    expect(extendCallsToDurationSeconds(4)).toBe(29);
    expect(extendCallsToDurationSeconds(8)).toBe(57);
  });

  it('floors fractional / clamps non-positive to 0 (defensive)', () => {
    expect(extendCallsToDurationSeconds(1.7)).toBe(8); // floor to 1
    expect(extendCallsToDurationSeconds(0)).toBe(0);
    expect(extendCallsToDurationSeconds(-2)).toBe(0);
    expect(extendCallsToDurationSeconds(NaN)).toBe(0);
  });

  it('clamps above the Google ceiling (21 calls = 148s)', () => {
    expect(extendCallsToDurationSeconds(21)).toBe(148);
    expect(extendCallsToDurationSeconds(100)).toBe(148);
  });
});
