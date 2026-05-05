/**
 * IANA timezone validation. Pure function — no DB.
 *
 * Validation should accept the full IANA database when the runtime
 * exposes Intl.supportedValuesOf, and at minimum the curated picker zones
 * always work (because they're pre-baked into the fallback set).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, TIMEZONE_PICKER_GROUPS, isValidIanaZone } from '../src/timezone';
import { SettingsFormSchema } from '../src/settings-form';

describe('isValidIanaZone', () => {
  it('accepts every zone in the picker', () => {
    for (const group of TIMEZONE_PICKER_GROUPS) {
      for (const tz of group.zones) {
        expect(isValidIanaZone(tz), tz).toBe(true);
      }
    }
  });

  it('accepts UTC and the schema default', () => {
    expect(isValidIanaZone('UTC')).toBe(true);
    expect(isValidIanaZone(DEFAULT_TIMEZONE)).toBe(true);
  });

  it('rejects garbage strings', () => {
    expect(isValidIanaZone('')).toBe(false);
    expect(isValidIanaZone('not-a-zone')).toBe(false);
    expect(isValidIanaZone('America/Atlantis')).toBe(false);
    expect(isValidIanaZone('PST')).toBe(false); // legacy POSIX, not IANA
    expect(isValidIanaZone('utc')).toBe(false); // case-sensitive
  });

  it('rejects empty + whitespace explicitly', () => {
    expect(isValidIanaZone(' ')).toBe(false);
    expect(isValidIanaZone(' America/New_York ')).toBe(false);
  });
});

describe('SettingsFormSchema timezone field', () => {
  function baseline(overrides: Record<string, unknown>) {
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
      timezone: 'America/New_York',
      ...overrides,
    };
  }

  it('accepts a valid IANA zone', () => {
    expect(SettingsFormSchema.safeParse(baseline({ timezone: 'Europe/London' })).success).toBe(
      true,
    );
  });

  it('rejects an invalid zone', () => {
    const result = SettingsFormSchema.safeParse(baseline({ timezone: 'Mars/Olympus' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === 'timezone')).toBe(true);
  });

  it('rejects empty string', () => {
    const result = SettingsFormSchema.safeParse(baseline({ timezone: '' }));
    expect(result.success).toBe(false);
  });
});
