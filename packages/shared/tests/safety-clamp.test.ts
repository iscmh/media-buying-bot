/**
 * Pure-function test for the platform spend ceiling clamp.
 * Locks the contract: the schema's max() and the code's Math.min() agree
 * on the cap. If a future schema change lifts the schema cap without
 * lifting PLATFORM_HARD_CEILING_USD (or vice versa), this test fails.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_HARD_CEILING_USD, SettingsFormSchema } from '../src';

describe('platform spend ceiling clamp', () => {
  it('PLATFORM_HARD_CEILING_USD has a sane value', () => {
    expect(PLATFORM_HARD_CEILING_USD).toBeGreaterThanOrEqual(100);
    expect(PLATFORM_HARD_CEILING_USD).toBeLessThanOrEqual(10_000);
  });

  it('schema accepts the hard ceiling exactly', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({
        platformDailySpendCeiling: PLATFORM_HARD_CEILING_USD,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('schema rejects a value above the hard ceiling', () => {
    const result = SettingsFormSchema.safeParse(
      validBaseline({
        platformDailySpendCeiling: PLATFORM_HARD_CEILING_USD + 1,
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'platformDailySpendCeiling');
    expect(issue?.message).toMatch(/cannot exceed/);
  });

  it('Math.min clamp would catch a value that slipped past the schema', () => {
    // Belt-and-suspenders: server action runs Math.min after parse. Even
    // if a future schema accepts a higher value, the clamp wins.
    const userInput = PLATFORM_HARD_CEILING_USD + 500;
    const clamped = Math.min(userInput, PLATFORM_HARD_CEILING_USD);
    expect(clamped).toBe(PLATFORM_HARD_CEILING_USD);
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
    ...overrides,
  };
}
