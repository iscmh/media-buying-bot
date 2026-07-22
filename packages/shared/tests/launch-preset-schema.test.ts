import { describe, expect, it } from 'vitest';
import { LaunchPresetInputSchema } from '../src/schemas/launch-preset';

/**
 * Polish-25.2 Commit 16b: LaunchPresetInputSchema regression pins.
 * Shared between the /settings/presets client form + the server
 * actions so both sides of the wire enforce the same rules.
 */
describe('LaunchPresetInputSchema', () => {
  const good = {
    name: 'US cold — $20/day',
    targetingCountries: ['US', 'CA'],
    ageMin: 18,
    ageMax: 65,
    optimizationGoal: 'CONVERSIONS' as const,
    placementType: 'advantage_plus' as const,
    perAdDailyBudgetUsd: 10,
  };

  it('accepts a well-formed preset input', () => {
    expect(LaunchPresetInputSchema.safeParse(good).success).toBe(true);
  });

  it('uppercases country codes on parse', () => {
    const r = LaunchPresetInputSchema.safeParse({ ...good, targetingCountries: ['us', 'ca'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.targetingCountries).toEqual(['US', 'CA']);
  });

  it('rejects empty name', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, name: '' }).success).toBe(false);
  });

  it('rejects name > 60 chars', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, name: 'x'.repeat(61) }).success).toBe(
      false,
    );
  });

  it('rejects empty country list', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, targetingCountries: [] }).success).toBe(
      false,
    );
  });

  it('rejects 3-letter country codes', () => {
    expect(
      LaunchPresetInputSchema.safeParse({ ...good, targetingCountries: ['USA'] }).success,
    ).toBe(false);
  });

  it('rejects ageMin > ageMax', () => {
    // Common paste-error: user swaps the two fields on edit.
    const r = LaunchPresetInputSchema.safeParse({ ...good, ageMin: 50, ageMax: 30 });
    expect(r.success).toBe(false);
  });

  it('rejects ageMin < 13 (Meta minimum)', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, ageMin: 12 }).success).toBe(false);
  });

  it('rejects zero / negative budget', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, perAdDailyBudgetUsd: 0 }).success).toBe(
      false,
    );
    expect(LaunchPresetInputSchema.safeParse({ ...good, perAdDailyBudgetUsd: -5 }).success).toBe(
      false,
    );
  });

  it('rejects budget > $1000 (schema-level ceiling)', () => {
    expect(LaunchPresetInputSchema.safeParse({ ...good, perAdDailyBudgetUsd: 1001 }).success).toBe(
      false,
    );
  });

  it('rejects unknown optimization goal', () => {
    expect(
      LaunchPresetInputSchema.safeParse({
        ...good,
        optimizationGoal: 'FICTIONAL_GOAL',
      } as unknown).success,
    ).toBe(false);
  });
});
