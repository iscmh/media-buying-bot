/**
 * Phase 5 decision-engine tests. Each kill rule + the scale rule +
 * every safety clamp gets its own assertion.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSUMED_CONVERSION_VALUE_USD,
  FIRST_SCALES_INCREMENT_PCT_CAP,
  SCALE_HARD_MULTIPLIER_CAP,
  computeImpliedRoas,
  computeProposedScale,
  evaluatePerformance,
} from '../src';

function baseSettings(overrides: Partial<Record<string, number>> = {}) {
  return {
    killMaxCpcUsd: 5,
    killNoConvSpendUsd: 10,
    killMinCtrPct: 0.5,
    scaleMinRoas: 2,
    scaleMinSpendUsd: 20,
    scaleIncrementPct: 50,
    scaleMaxDailyBudgetUsd: 100,
    scaleSuccessCount: 10, // past the grace window unless overridden
    remainingDailyLaunchBudgetUsd: 1000,
    ...overrides,
  };
}

function baseMetrics(overrides: Partial<Record<string, number>> = {}) {
  return {
    spendUsd: 5,
    impressions: 500,
    clicks: 10,
    conversions: 0,
    ctrPct: 2,
    cpcUsd: 0.5,
    ...overrides,
  };
}

describe('evaluatePerformance — short-circuits', () => {
  it('returns no_action when a pending approval already exists', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ spendUsd: 20, conversions: 0 }),
      hasPendingApproval: true,
      settings: baseSettings(),
    });
    expect(result.action).toBe('no_action');
    expect(result.reason).toMatch(/pending approval/);
  });
});

describe('evaluatePerformance — kill rules', () => {
  it('kills when spend ≥ killNoConvSpendUsd AND conversions = 0', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ spendUsd: 10, conversions: 0 }),
      hasPendingApproval: false,
      settings: baseSettings(),
    });
    expect(result.action).toBe('kill');
    expect(result.reason).toMatch(/0 conversions/);
  });

  it('kills when CPC > killMaxCpcUsd AND spend ≥ $3', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ spendUsd: 4, cpcUsd: 6, conversions: 1 }),
      hasPendingApproval: false,
      settings: baseSettings({ killNoConvSpendUsd: 999 }),
    });
    expect(result.action).toBe('kill');
    expect(result.reason).toMatch(/CPC/);
  });

  it('does NOT kill on CPC when spend < $3 (insufficient signal)', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ spendUsd: 2, cpcUsd: 10, conversions: 1 }),
      hasPendingApproval: false,
      settings: baseSettings({ killNoConvSpendUsd: 999 }),
    });
    expect(result.action).toBe('no_action');
  });

  it('kills when CTR < killMinCtrPct AND impressions ≥ 1000', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ impressions: 1500, ctrPct: 0.3, conversions: 1, spendUsd: 5 }),
      hasPendingApproval: false,
      settings: baseSettings({ killNoConvSpendUsd: 999 }),
    });
    expect(result.action).toBe('kill');
    expect(result.reason).toMatch(/CTR/);
  });

  it('does NOT kill on CTR when impressions < 1000', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 5,
      metrics: baseMetrics({ impressions: 500, ctrPct: 0.1, conversions: 1, spendUsd: 5 }),
      hasPendingApproval: false,
      settings: baseSettings({ killNoConvSpendUsd: 999 }),
    });
    expect(result.action).toBe('no_action');
  });
});

describe('evaluatePerformance — scale rule', () => {
  it('scales when ROAS ≥ min AND spend ≥ min AND conversions > 0', () => {
    // spend=$20, conv=3 → roas = 3 × $20 / $20 = 3.0 (≥ 2.0)
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 20, conversions: 3, clicks: 50, cpcUsd: 0.4 }),
      hasPendingApproval: false,
      settings: baseSettings(),
    });
    expect(result.action).toBe('scale');
    expect(result.proposedBudgetUsd).toBeGreaterThan(10);
  });

  it('does NOT scale when ROAS below min', () => {
    // spend=$30, conv=1 → roas = 1 × $20 / $30 ≈ 0.67 (< 2.0)
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 30, conversions: 1, clicks: 50, cpcUsd: 0.6 }),
      hasPendingApproval: false,
      settings: baseSettings({ killMaxCpcUsd: 100, killMinCtrPct: 0 }),
    });
    expect(result.action).toBe('no_action');
  });

  it('does NOT scale when spend < scaleMinSpendUsd', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 5, conversions: 3, clicks: 20, cpcUsd: 0.25 }),
      hasPendingApproval: false,
      settings: baseSettings(),
    });
    expect(result.action).toBe('no_action');
  });
});

describe('evaluatePerformance — scale caps', () => {
  it('hard 2× cap applies before settings max', () => {
    // current=$10, increment=200% would propose $30; 2× cap snaps to $20.
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 200,
        scaleMaxDailyBudgetUsd: 999, // wouldn't bind
      }),
    });
    expect(result.action).toBe('scale');
    expect(result.proposedBudgetUsd).toBe(10 * SCALE_HARD_MULTIPLIER_CAP);
    expect(result.scaleCapApplied).toBe('hard_2x');
  });

  it('settings_max wins when smaller than 2× cap', () => {
    // current=$10, 2× would be $20; settings max $15 binds.
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 200,
        scaleMaxDailyBudgetUsd: 15,
      }),
    });
    expect(result.action).toBe('scale');
    expect(result.proposedBudgetUsd).toBe(15);
    expect(result.scaleCapApplied).toBe('settings_max');
  });

  it('first-5-scales grace caps increment at +25%', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 100, // user wants 100%
        scaleSuccessCount: 0, // first scale
      }),
    });
    expect(result.action).toBe('scale');
    // +25% from $10 = $12.50
    expect(result.proposedBudgetUsd).toBe(12.5);
    expect(result.scaleCapApplied).toBe('first_scales_grace');
  });

  it('after 5 successful scales the grace cap no longer binds', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 50,
        scaleSuccessCount: 5,
      }),
    });
    expect(result.action).toBe('scale');
    expect(result.proposedBudgetUsd).toBe(15); // +50%
    expect(result.scaleCapApplied).toBeNull();
  });

  it('remaining daily launch cap wins when smaller than every other clamp', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 50,
        // Headroom of $2 → can grow from $10 to $12 max.
        remainingDailyLaunchBudgetUsd: 2,
      }),
    });
    expect(result.action).toBe('scale');
    expect(result.proposedBudgetUsd).toBe(12);
    expect(result.scaleCapApplied).toBe('remaining_daily_launch_cap');
  });

  it('returns no_action if every cap collapses below current budget', () => {
    const result = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: baseMetrics({ spendUsd: 25, conversions: 5, clicks: 60 }),
      hasPendingApproval: false,
      settings: baseSettings({
        scaleIncrementPct: 50,
        scaleMaxDailyBudgetUsd: 5, // already below current
        remainingDailyLaunchBudgetUsd: 0,
      }),
    });
    expect(result.action).toBe('no_action');
  });
});

describe('computeImpliedRoas', () => {
  it('uses ASSUMED_CONVERSION_VALUE_USD per conversion', () => {
    expect(computeImpliedRoas(3, 30)).toBeCloseTo((3 * ASSUMED_CONVERSION_VALUE_USD) / 30);
  });
  it('returns 0 when spend is 0', () => {
    expect(computeImpliedRoas(5, 0)).toBe(0);
  });
});

describe('computeProposedScale — boundary tags', () => {
  it('reports first_scales_grace when grace cap clips the user increment', () => {
    const r = computeProposedScale({
      currentDailyBudgetUsd: 10,
      settings: {
        scaleIncrementPct: 100,
        scaleMaxDailyBudgetUsd: 1000,
        scaleSuccessCount: 0,
        remainingDailyLaunchBudgetUsd: 1000,
      },
    });
    // +25% grace cap applies; raw was +100%
    expect(r.proposedBudgetUsd).toBe(12.5);
    expect(r.capApplied).toBe('first_scales_grace');
    expect(FIRST_SCALES_INCREMENT_PCT_CAP).toBe(25);
  });
});
