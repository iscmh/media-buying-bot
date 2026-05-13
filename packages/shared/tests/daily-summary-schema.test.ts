/**
 * Phase 6 schema coverage. Locks the contract for the two new
 * settings fields the daily-summary cron reads.
 */
import { describe, expect, it } from 'vitest';
import { SettingsFormSchema } from '../src';

function baseline(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    dailyLaunchBudgetCapUsd: 50,
    defaultAdDailyBudgetUsd: 10,
    defaultOptimizationGoal: 'CONVERSIONS',
    defaultPlacementType: 'advantage_plus',
    defaultPageId: null,
    defaultTargetingCountries: ['US'],
    defaultAgeMin: 18,
    defaultAgeMax: 65,
    pollingIntervalMinutes: 30,
    killMaxCpcUsd: 5,
    killNoConvSpendUsd: 10,
    killMinCtrPct: 0.5,
    scaleMinRoas: 2,
    scaleMinSpendUsd: 20,
    scaleIncrementPct: 50,
    scaleMaxDailyBudgetUsd: 100,
    dailySummaryEnabled: true,
    dailySummaryHourLocal: 9,
    timezone: 'America/New_York',
    ...overrides,
  };
}

describe('Phase 6: daily summary settings', () => {
  it('accepts default values', () => {
    expect(SettingsFormSchema.safeParse(baseline()).success).toBe(true);
  });

  it('accepts dailySummaryEnabled = false', () => {
    expect(SettingsFormSchema.safeParse(baseline({ dailySummaryEnabled: false })).success).toBe(
      true,
    );
  });

  it('accepts hours 0..23', () => {
    for (const h of [0, 9, 12, 23]) {
      expect(SettingsFormSchema.safeParse(baseline({ dailySummaryHourLocal: h })).success).toBe(
        true,
      );
    }
  });

  it('rejects hour < 0', () => {
    expect(SettingsFormSchema.safeParse(baseline({ dailySummaryHourLocal: -1 })).success).toBe(
      false,
    );
  });

  it('rejects hour > 23', () => {
    expect(SettingsFormSchema.safeParse(baseline({ dailySummaryHourLocal: 24 })).success).toBe(
      false,
    );
  });

  it('rejects non-integer hour', () => {
    expect(SettingsFormSchema.safeParse(baseline({ dailySummaryHourLocal: 9.5 })).success).toBe(
      false,
    );
  });
});
