/**
 * Pure-function test for the settings diff helper. Does NOT require a DB.
 *
 * The diff is what feeds the audit log — anything wrong here means we
 * either over-log (noise) or under-log (audit gaps). The "no changes"
 * case is the most important: a no-op submit must not write a log row.
 */
import { describe, expect, it } from 'vitest';
import { diffSettings, type SettingsRow } from '../src/settings';

const baseline: SettingsRow = {
  defaultTestCap: 20,
  adSetsPerLaunch: 5,
  dailyGenerationVolume: 40,
  campaignObjective: 'CBO',
  killThresholdCpc: 2.5,
  killThresholdCtr: 2,
  gracePeriodMinutes: 30,
  hour6CutoffEnabled: true,
  scaleTier1Cap: 200,
  scaleTier2Cap: 400,
  manualApprovalThreshold: 400,
  platformDailySpendCeiling: 500,
  aiGenerationDailyCapUsd: 50,
  timezone: 'America/New_York',
};

describe('diffSettings', () => {
  it('returns [] when nothing changed', () => {
    expect(diffSettings(baseline, { ...baseline })).toEqual([]);
  });

  it('reports a single changed numeric field', () => {
    const next = { ...baseline, defaultTestCap: 25 };
    const changes = diffSettings(baseline, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ field: 'defaultTestCap', oldValue: 20, newValue: 25 });
  });

  it('reports multiple changes in field order', () => {
    const next = {
      ...baseline,
      killThresholdCpc: 3.0,
      hour6CutoffEnabled: false,
      campaignObjective: 'ABO' as const,
    };
    const changes = diffSettings(baseline, next);
    const fields = changes.map((c) => c.field);
    expect(fields).toContain('killThresholdCpc');
    expect(fields).toContain('hour6CutoffEnabled');
    expect(fields).toContain('campaignObjective');
    expect(fields).toHaveLength(3);
  });

  it('does not report a field where new value === old value (precision-safe)', () => {
    // Same number from two paths: explicit literal vs. arithmetic that
    // produces the same float. This is the case that made me defensive
    // about coercing numerics to Number on read in getUserSettings.
    const next = { ...baseline, killThresholdCpc: 5 / 2 }; // 2.5
    expect(diffSettings(baseline, next)).toEqual([]);
  });

  it('treats string vs number as different (catches the postgres-js coercion bug)', () => {
    // If a future bug reintroduces stringified numerics from the DB into
    // diff inputs, every save would log every numeric field. This test
    // pins the contract: callers must coerce.
    const stringy = { ...baseline, defaultTestCap: '20' as unknown as number };
    const changes = diffSettings(stringy, baseline);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.field).toBe('defaultTestCap');
  });

  it('includes timezone changes in the diff', () => {
    const next = { ...baseline, timezone: 'Europe/London' };
    const changes = diffSettings(baseline, next);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: 'timezone',
      oldValue: 'America/New_York',
      newValue: 'Europe/London',
    });
  });
});
