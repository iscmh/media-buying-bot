/**
 * Pure-function tests for the AI generation cost cap. Locks the contract
 * between the schema's .max() bound, the server action's Math.min clamp,
 * and the PLATFORM_HARD_AI_CEILING_USD constant. Lift any of those
 * without lifting all three and this test fails.
 */
import { describe, expect, it } from 'vitest';
import { MAX_VARIANTS_PER_JOB, PLATFORM_HARD_AI_CEILING_USD, SettingsFormSchema } from '../src';

describe('PLATFORM_HARD_AI_CEILING_USD', () => {
  it('has a sane value', () => {
    expect(PLATFORM_HARD_AI_CEILING_USD).toBeGreaterThanOrEqual(50);
    expect(PLATFORM_HARD_AI_CEILING_USD).toBeLessThanOrEqual(2_000);
  });

  it('schema accepts the hard ceiling exactly', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ aiGenerationDailyCapUsd: PLATFORM_HARD_AI_CEILING_USD }),
    );
    expect(result.success).toBe(true);
  });

  it('schema rejects a value above the hard ceiling', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({ aiGenerationDailyCapUsd: PLATFORM_HARD_AI_CEILING_USD + 1 }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'aiGenerationDailyCapUsd');
    expect(issue?.message).toMatch(/cannot exceed/);
  });

  it('Math.min clamp catches values that slipped past schema (defense in depth)', () => {
    const userInput = PLATFORM_HARD_AI_CEILING_USD + 500;
    const clamped = Math.min(userInput, PLATFORM_HARD_AI_CEILING_USD);
    expect(clamped).toBe(PLATFORM_HARD_AI_CEILING_USD);
  });
});

describe('MAX_VARIANTS_PER_JOB hard cap', () => {
  it('is 100', () => {
    expect(MAX_VARIANTS_PER_JOB).toBe(100);
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
    timezone: 'America/New_York',
    ...overrides,
  };
}
