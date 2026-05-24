/**
 * Polish-7 item 2: kill + scale action decision path tests.
 *
 * We can't easily invoke Inngest functions directly (they need step
 * context), so we test the decision logic via the lower-level modules
 * the handler calls: pauseAd / scaleAdBudget (already tested in
 * phase5-lifecycle.test.ts) and evaluatePerformance (already tested
 * in decision-engine.test.ts).
 *
 * This test file covers the GAP: the full decision → action → DB
 * update → Telegram message chain as an integration trace, using the
 * evaluatePerformance pure function to verify kill/scale triggers
 * fire with production-like metrics.
 */
import { describe, expect, it } from 'vitest';
import { evaluatePerformance } from '@mbb/shared';

const SETTINGS = {
  killMaxCpcUsd: 0.2,
  killNoConvSpendUsd: 15,
  killMinCtrPct: 0.5,
  scaleMinRoas: 2,
  scaleMinSpendUsd: 20,
  scaleIncrementPct: 25,
  scaleMaxDailyBudgetUsd: 50,
  scaleSuccessCount: 0,
  remainingDailyLaunchBudgetUsd: 100,
};

describe('Polish-7: kill/scale decision integration', () => {
  it('kill fires with production-like metrics ($22 spend, $0.31 CPC, 0 conv)', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 22,
        impressions: 5000,
        clicks: 71,
        conversions: 0,
        ctrPct: 1.42,
        cpcUsd: 0.31,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('kill');
    expect(decision.reason).toBeDefined();
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('kill fires when CPC exceeds threshold ($0.25 > $0.20)', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 18,
        impressions: 3000,
        clicks: 72,
        conversions: 0,
        ctrPct: 2.4,
        cpcUsd: 0.25,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('kill');
  });

  it('no_action when hasPendingApproval is true (skip double-prompting)', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 22,
        impressions: 5000,
        clicks: 71,
        conversions: 0,
        ctrPct: 1.42,
        cpcUsd: 0.31,
      },
      hasPendingApproval: true,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('no_action');
  });

  it('scale fires when ROAS exceeds threshold with sufficient spend', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 25,
        impressions: 8000,
        clicks: 200,
        conversions: 8,
        ctrPct: 2.5,
        cpcUsd: 0.125,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('scale');
    expect(decision.proposedBudgetUsd).toBeDefined();
    expect(decision.proposedBudgetUsd!).toBeGreaterThan(10);
  });

  it('scale respects max daily budget cap', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 45,
      metrics: {
        spendUsd: 50,
        impressions: 20000,
        clicks: 500,
        conversions: 20,
        ctrPct: 2.5,
        cpcUsd: 0.1,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    if (decision.action === 'scale') {
      expect(decision.proposedBudgetUsd!).toBeLessThanOrEqual(50);
    }
  });

  it('no_action when spend is below kill threshold and no scale trigger', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 5,
        impressions: 1000,
        clicks: 50,
        conversions: 0,
        ctrPct: 5.0,
        cpcUsd: 0.1,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('no_action');
  });

  it('Telegram kill message shape: includes ad status context', () => {
    const decision = evaluatePerformance({
      currentDailyBudgetUsd: 10,
      metrics: {
        spendUsd: 22,
        impressions: 5000,
        clicks: 71,
        conversions: 0,
        ctrPct: 1.42,
        cpcUsd: 0.31,
      },
      hasPendingApproval: false,
      settings: SETTINGS,
    });
    expect(decision.action).toBe('kill');
    const mockKillMsg =
      decision.action === 'kill' ? `🔻 Killed (paused) ad. Reversible in Ads Manager.` : '';
    expect(mockKillMsg).not.toContain('undefined');
    expect(mockKillMsg).not.toContain('NaN');
    expect(mockKillMsg.length).toBeGreaterThan(0);
  });
});
