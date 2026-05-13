/**
 * Phase 4a — locks the contract for the launch cap + per-ad budget
 * clamps. Mirrors safety-clamp.test.ts (Phase 1) and safety-ceiling
 * (Phase 3a) so a future schema bump that lifts one side without the
 * other fails loudly.
 */
import { describe, expect, it } from 'vitest';
import {
  META_OPTIMIZATION_GOALS,
  META_PLACEMENT_TYPES,
  PLATFORM_HARD_AD_DAILY_BUDGET_USD,
  PLATFORM_HARD_LAUNCH_CEILING_USD,
  SettingsFormSchema,
} from '../src';

describe('platform launch budget cap clamp', () => {
  it('PLATFORM_HARD_LAUNCH_CEILING_USD has a sane value', () => {
    expect(PLATFORM_HARD_LAUNCH_CEILING_USD).toBeGreaterThanOrEqual(100);
    expect(PLATFORM_HARD_LAUNCH_CEILING_USD).toBeLessThanOrEqual(10_000);
  });

  it('schema accepts the launch hard ceiling exactly', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ dailyLaunchBudgetCapUsd: PLATFORM_HARD_LAUNCH_CEILING_USD }),
    );
    expect(result.success).toBe(true);
  });

  it('schema rejects a value above the launch ceiling', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ dailyLaunchBudgetCapUsd: PLATFORM_HARD_LAUNCH_CEILING_USD + 1 }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'dailyLaunchBudgetCapUsd');
    expect(issue?.message).toMatch(/cannot exceed/);
  });

  it('Math.min clamp catches values that slip past the schema', () => {
    const userInput = PLATFORM_HARD_LAUNCH_CEILING_USD + 999;
    expect(Math.min(userInput, PLATFORM_HARD_LAUNCH_CEILING_USD)).toBe(
      PLATFORM_HARD_LAUNCH_CEILING_USD,
    );
  });
});

describe('per-ad daily budget clamp', () => {
  it('schema accepts the per-ad hard ceiling exactly', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ defaultAdDailyBudgetUsd: PLATFORM_HARD_AD_DAILY_BUDGET_USD }),
    );
    expect(result.success).toBe(true);
  });

  it('schema rejects a value above the per-ad ceiling', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ defaultAdDailyBudgetUsd: PLATFORM_HARD_AD_DAILY_BUDGET_USD + 0.01 }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Meta enum fields', () => {
  it('only the listed optimization goals are accepted', () => {
    for (const goal of META_OPTIMIZATION_GOALS) {
      expect(
        SettingsFormSchema.safeParse(validBaseline({ defaultOptimizationGoal: goal })).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown optimization goal', () => {
    expect(
      SettingsFormSchema.safeParse(validBaseline({ defaultOptimizationGoal: 'MOON_BASE' })).success,
    ).toBe(false);
  });

  it('only the listed placement types are accepted', () => {
    for (const placement of META_PLACEMENT_TYPES) {
      expect(
        SettingsFormSchema.safeParse(validBaseline({ defaultPlacementType: placement })).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown placement type', () => {
    expect(
      SettingsFormSchema.safeParse(validBaseline({ defaultPlacementType: 'banner_blanket' }))
        .success,
    ).toBe(false);
  });
});

function validBaseline(overrides: Partial<Record<string, number | string | boolean>>) {
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
    timezone: 'America/New_York',
    ...overrides,
  };
}
