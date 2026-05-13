/**
 * Phase 4b — locks the contract on the live-launch settings fields and
 * the FIRST_LIVE_LAUNCH_HARD_CAP_USD constant. If a future schema bump
 * lifts the cap without lifting the constant (or vice versa) this fails.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_LIVE_LAUNCH_HARD_CAP_USD,
  SUPPORTED_TARGETING_COUNTRIES,
  SettingsFormSchema,
  SettingsFormSchemaRefined,
} from '../src';

describe('FIRST_LIVE_LAUNCH_HARD_CAP_USD constant', () => {
  it('is set conservatively (≤ $25)', () => {
    expect(FIRST_LIVE_LAUNCH_HARD_CAP_USD).toBeGreaterThan(0);
    expect(FIRST_LIVE_LAUNCH_HARD_CAP_USD).toBeLessThanOrEqual(25);
  });

  it('is exactly $10 by spec', () => {
    expect(FIRST_LIVE_LAUNCH_HARD_CAP_USD).toBe(10);
  });
});

describe('SettingsFormSchema — Phase 4b targeting fields', () => {
  it('accepts default values', () => {
    expect(SettingsFormSchema.safeParse(baseline({})).success).toBe(true);
  });

  it('accepts a null defaultPageId (pre-page-fetch state)', () => {
    expect(SettingsFormSchema.safeParse(baseline({ defaultPageId: null })).success).toBe(true);
  });

  it('rejects an empty country list', () => {
    expect(SettingsFormSchema.safeParse(baseline({ defaultTargetingCountries: [] })).success).toBe(
      false,
    );
  });

  it('rejects a lower-case country code', () => {
    expect(
      SettingsFormSchema.safeParse(baseline({ defaultTargetingCountries: ['us'] })).success,
    ).toBe(false);
  });

  it('accepts ISO 3166-1 alpha-2 codes', () => {
    expect(
      SettingsFormSchema.safeParse(baseline({ defaultTargetingCountries: ['US', 'CA', 'GB'] }))
        .success,
    ).toBe(true);
  });

  it('rejects defaultAgeMin below 13', () => {
    expect(SettingsFormSchema.safeParse(baseline({ defaultAgeMin: 12 })).success).toBe(false);
  });

  it('rejects defaultAgeMax above 65', () => {
    expect(SettingsFormSchema.safeParse(baseline({ defaultAgeMax: 66 })).success).toBe(false);
  });
});

describe('SettingsFormSchemaRefined — age cross-field', () => {
  it('rejects when defaultAgeMin > defaultAgeMax', () => {
    const result = SettingsFormSchemaRefined.safeParse(
      baseline({ defaultAgeMin: 50, defaultAgeMax: 30 }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts when min == max', () => {
    expect(
      SettingsFormSchemaRefined.safeParse(baseline({ defaultAgeMin: 25, defaultAgeMax: 25 }))
        .success,
    ).toBe(true);
  });

  it('accepts when min < max', () => {
    expect(
      SettingsFormSchemaRefined.safeParse(baseline({ defaultAgeMin: 18, defaultAgeMax: 65 }))
        .success,
    ).toBe(true);
  });
});

describe('SUPPORTED_TARGETING_COUNTRIES', () => {
  it('every code is an ISO 3166-1 alpha-2 string', () => {
    for (const c of SUPPORTED_TARGETING_COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('includes US at minimum', () => {
    expect(SUPPORTED_TARGETING_COUNTRIES.some((c) => c.code === 'US')).toBe(true);
  });

  it('all codes pass the schema validator', () => {
    for (const c of SUPPORTED_TARGETING_COUNTRIES) {
      expect(
        SettingsFormSchema.safeParse(baseline({ defaultTargetingCountries: [c.code] })).success,
      ).toBe(true);
    }
  });
});

function baseline(overrides: Partial<Record<string, unknown>>) {
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
    timezone: 'America/New_York',
    ...overrides,
  };
}
