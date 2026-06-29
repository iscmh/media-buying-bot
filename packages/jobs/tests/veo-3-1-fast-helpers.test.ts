/**
 * Polish-19.2: pure-helper tests for the Veo 3.1 Fast worker.
 * Mirrors the Polish-19 Kling worker pattern — covers the pure
 * decision helpers the worker delegates to (poll backoff curve,
 * duration resolver) without spinning up Inngest's step harness.
 */
import { describe, expect, it } from 'vitest';
import {
  computeVeoPollIntervalSeconds,
  resolveVeoTargetDuration,
} from '../src/functions/generate-veo-3-1-fast';

describe('Polish-19.2: computeVeoPollIntervalSeconds', () => {
  it('attempt 0 returns the initial interval (8s)', () => {
    expect(computeVeoPollIntervalSeconds(0)).toBe(8);
  });

  it('grows gently in the first several attempts (1.15x growth)', () => {
    // 8 * 1.15 = 9.2 → ceil = 10
    // 8 * 1.15^2 = 10.58 → ceil = 11
    // 8 * 1.15^3 = 12.17 → ceil = 13
    expect(computeVeoPollIntervalSeconds(1)).toBe(10);
    expect(computeVeoPollIntervalSeconds(2)).toBe(11);
    expect(computeVeoPollIntervalSeconds(3)).toBe(13);
  });

  it('caps at 25s on later attempts', () => {
    expect(computeVeoPollIntervalSeconds(20)).toBe(25);
    expect(computeVeoPollIntervalSeconds(59)).toBe(25);
  });

  it('clamps non-finite / negative attempt indices to the initial interval', () => {
    expect(computeVeoPollIntervalSeconds(NaN)).toBe(8);
    expect(computeVeoPollIntervalSeconds(-2)).toBe(8);
    expect(computeVeoPollIntervalSeconds(Infinity)).toBe(8);
  });

  it('total wall-clock with POLL_MAX_ATTEMPTS=60 stays above 15 minutes', () => {
    // Sanity bound — needs enough headroom past observed Veo runtime.
    let total = 0;
    for (let i = 0; i < 60; i++) total += computeVeoPollIntervalSeconds(i);
    expect(total).toBeGreaterThan(15 * 60);
    expect(total).toBeLessThan(45 * 60);
  });
});

describe('Polish-19.2: resolveVeoTargetDuration', () => {
  it('defaults to 8s (Veo per-call ceiling) when metadata is null', () => {
    const r = resolveVeoTargetDuration(null);
    expect(r.durationSeconds).toBe(8);
    expect(r.clamped).toBe(false);
  });

  it('defaults to 8s when source_duration_seconds is missing or invalid', () => {
    expect(resolveVeoTargetDuration({ other: 'field' }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 'twelve' }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 0 }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: NaN }).durationSeconds).toBe(8);
    expect(resolveVeoTargetDuration({ source_duration_seconds: -3 }).durationSeconds).toBe(8);
  });

  it('passes mid-range durations under the cap straight through', () => {
    expect(resolveVeoTargetDuration({ source_duration_seconds: 4 }).durationSeconds).toBe(4);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 6 }).durationSeconds).toBe(6);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 8 }).durationSeconds).toBe(8);
  });

  it('clamps requests above 8s to 8s and flags clamped=true', () => {
    const r = resolveVeoTargetDuration({ source_duration_seconds: 30 });
    expect(r.durationSeconds).toBe(8);
    expect(r.clamped).toBe(true);
    expect(r.requestedSeconds).toBe(30);
  });

  it('rounds fractional seconds up to the next whole second', () => {
    expect(resolveVeoTargetDuration({ source_duration_seconds: 4.3 }).durationSeconds).toBe(5);
    expect(resolveVeoTargetDuration({ source_duration_seconds: 5.9 }).durationSeconds).toBe(6);
  });

  it('reports clamped=false when the request is exactly at the cap', () => {
    const r = resolveVeoTargetDuration({ source_duration_seconds: 8 });
    expect(r.clamped).toBe(false);
  });
});
