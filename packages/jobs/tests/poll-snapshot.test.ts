/**
 * Polish-5 unit test: buildSnapshotUpdate maps an AdInsights into the
 * current_* + meta_* columns the poll writes on every tick. Locks the
 * shape so the kill/scale evaluator's "stable snapshot" surface keeps
 * its promise — current_window_kind labeled, decimals correctly
 * stringified for numeric() Drizzle columns.
 */
import { describe, expect, it } from 'vitest';
import type { AdInsights } from '@mbb/meta-api';
import { buildSnapshotUpdate } from '../src/functions/poll-ad-performance';

const baseInsights: AdInsights = {
  spendUsd: 22.5,
  impressions: 5000,
  clicks: 100,
  conversions: 4,
  ctrPct: 2,
  cpcUsd: 0.225,
  frequency: 1.85,
  // Polish-25.7 Commit 39: real conversion value from Meta insights.
  conversionValueUsd: 120.0,
};

describe('Polish-5: buildSnapshotUpdate', () => {
  it('writes meta_* AND current_* columns from the same insights row', () => {
    const u = buildSnapshotUpdate(baseInsights, 'last_7d');
    // meta_* (legacy back-compat fields the existing /launched UI reads).
    expect(u.metaSpendUsd).toBe('22.50');
    expect(u.metaImpressions).toBe(5000);
    expect(u.metaClicks).toBe(100);
    expect(u.metaConversions).toBe(4);
    // current_* (Polish-5 stable snapshot surface — what the kill /
    // scale evaluator reads).
    expect(u.currentSpend).toBe('22.50');
    expect(u.currentImpressions).toBe(5000);
    expect(u.currentClicks).toBe(100);
    expect(u.currentCtr).toBe('2.0000');
    expect(u.currentCpc).toBe('0.2250');
    expect(u.currentConversions).toBe(4);
    expect(u.currentFrequency).toBe('1.8500');
    expect(u.currentWindowKind).toBe('last_7d');
  });

  it('handles all-zero insights without NaN', () => {
    const u = buildSnapshotUpdate(
      {
        spendUsd: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        ctrPct: 0,
        cpcUsd: 0,
        frequency: 0,
        conversionValueUsd: 0,
      },
      'last_7d',
    );
    expect(u.currentSpend).toBe('0.00');
    expect(u.currentCtr).toBe('0.0000');
    expect(u.currentCpc).toBe('0.0000');
    expect(u.currentFrequency).toBe('0.0000');
  });

  it('labels the window passed in', () => {
    expect(buildSnapshotUpdate(baseInsights, 'last_30min').currentWindowKind).toBe('last_30min');
    expect(buildSnapshotUpdate(baseInsights, 'lifetime').currentWindowKind).toBe('lifetime');
  });
});
