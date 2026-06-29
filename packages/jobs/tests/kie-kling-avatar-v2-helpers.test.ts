/**
 * Polish-19: pure-helper tests for the Kling Avatar v2 worker.
 * Inngest's step harness is mocked out — we cover the decisions
 * the worker delegates to plain functions.
 */
import { describe, expect, it } from 'vitest';
import { resolveTargetDuration } from '../src/functions/generate-kie-kling-avatar-v2';

describe('Polish-19: resolveTargetDuration', () => {
  it('defaults to 30s when metadata is null', () => {
    expect(resolveTargetDuration(null)).toBe(30);
  });

  it('defaults to 30s when source_duration_seconds is missing', () => {
    expect(resolveTargetDuration({ other: 'fields' })).toBe(30);
  });

  it('defaults to 30s for non-numeric / zero / NaN durations', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 'twelve' })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: 0 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: NaN })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: -5 })).toBe(30);
  });

  it('clamps short detections to the 8s floor (prevents 3s broken-thumbnail outliers)', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 3 })).toBe(8);
    expect(resolveTargetDuration({ source_duration_seconds: 7.4 })).toBe(8);
  });

  it('clamps long detections to the 5-minute (300s) hard ceiling (kie.ai max)', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 600 })).toBe(300);
    expect(resolveTargetDuration({ source_duration_seconds: 4000 })).toBe(300);
  });

  it('rounds fractional seconds up so the worker never under-generates', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 18.3 })).toBe(19);
    expect(resolveTargetDuration({ source_duration_seconds: 45.9 })).toBe(46);
  });

  it('passes through canonical mid-range durations unchanged', () => {
    expect(resolveTargetDuration({ source_duration_seconds: 30 })).toBe(30);
    expect(resolveTargetDuration({ source_duration_seconds: 60 })).toBe(60);
    expect(resolveTargetDuration({ source_duration_seconds: 120 })).toBe(120);
    expect(resolveTargetDuration({ source_duration_seconds: 240 })).toBe(240);
  });
});
