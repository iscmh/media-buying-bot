/**
 * Phase 6 Telegram template test. Locks the format so a Refactor
 * doesn't accidentally drop the date / emoji / dashboard link.
 */
import { describe, expect, it } from 'vitest';
import { formatDailyRecap } from '../src/functions/daily-summary-generator';

const base = {
  summaryDate: '2026-05-13',
  totalSpendUsd: 42.5,
  totalConversions: 5,
  impliedRoas: null as number | null,
  adsActiveCount: 3,
  adsKilledToday: 0,
  adsScaledToday: 0,
  bestHeadline: null as string | null,
  bestSpendUsd: 0,
  bestConv: 0,
  bestRoas: 0,
  worstHeadline: null as string | null,
  worstSpendUsd: 0,
  worstConv: 0,
};

describe('Phase 6: formatDailyRecap', () => {
  it('includes the summary date in the header', () => {
    const out = formatDailyRecap(base);
    expect(out).toMatch(/2026-05-13/);
  });

  it('renders 🟢 emoji when ROAS ≥ 2', () => {
    const out = formatDailyRecap({ ...base, impliedRoas: 2.5 });
    expect(out).toMatch(/🟢/);
  });

  it('renders 🟡 emoji when 1 ≤ ROAS < 2', () => {
    const out = formatDailyRecap({ ...base, impliedRoas: 1.5 });
    expect(out).toMatch(/🟡/);
  });

  it('renders 🔴 emoji when ROAS < 1', () => {
    const out = formatDailyRecap({ ...base, impliedRoas: 0.5 });
    expect(out).toMatch(/🔴/);
  });

  it('renders ⚪️ when ROAS is null (no spend yet)', () => {
    const out = formatDailyRecap({ ...base, impliedRoas: null });
    expect(out).toMatch(/⚪️/);
    expect(out).toMatch(/ROAS: n\/a/);
  });

  it('omits Killed line when 0', () => {
    expect(formatDailyRecap(base)).not.toMatch(/Killed yesterday/);
  });

  it('shows Killed / Scaled lines when > 0', () => {
    const out = formatDailyRecap({ ...base, adsKilledToday: 2, adsScaledToday: 1 });
    expect(out).toMatch(/Killed yesterday: 2/);
    expect(out).toMatch(/Scaled yesterday: 1/);
  });

  it('renders best performer when headline is set', () => {
    const out = formatDailyRecap({
      ...base,
      bestHeadline: 'Try this 2026',
      bestSpendUsd: 30,
      bestConv: 4,
      bestRoas: 2.67,
    });
    expect(out).toMatch(/🏆 Best performer: "Try this 2026"/);
    expect(out).toMatch(/\$30\.00 → 4 conv \(2\.67x\)/);
  });

  it('shows worst performer only when distinct from best', () => {
    const out = formatDailyRecap({
      ...base,
      bestHeadline: 'X',
      worstHeadline: 'X',
    });
    expect(out.match(/Best performer/g)?.length ?? 0).toBe(1);
    expect(out.match(/Worst performer/g)?.length ?? 0).toBe(0);
  });

  it('links to /dashboard in the footer', () => {
    expect(formatDailyRecap(base)).toMatch(/\/dashboard/);
  });

  it('Polish-5: renders without throwing when every field is null', () => {
    const out = formatDailyRecap({
      summaryDate: null,
      totalSpendUsd: null,
      totalConversions: null,
      impliedRoas: null,
      adsActiveCount: null,
      adsKilledToday: null,
      adsScaledToday: null,
      bestHeadline: null,
      bestSpendUsd: null,
      bestConv: null,
      bestRoas: null,
      worstHeadline: null,
      worstSpendUsd: null,
      worstConv: null,
    });
    expect(out).toMatch(/\$0\.00/);
    expect(out).toMatch(/ROAS: n\/a/);
    expect(out).toMatch(/Active ads: 0/);
    expect(out).toMatch(/\/dashboard/);
  });

  it('Polish-5: renders without throwing when every field is undefined', () => {
    const out = formatDailyRecap({
      summaryDate: undefined,
      totalSpendUsd: undefined,
      totalConversions: undefined,
      impliedRoas: undefined,
      adsActiveCount: undefined,
      adsKilledToday: undefined,
      adsScaledToday: undefined,
      bestHeadline: undefined,
      bestSpendUsd: undefined,
      bestConv: undefined,
      bestRoas: undefined,
      worstHeadline: undefined,
      worstSpendUsd: undefined,
      worstConv: undefined,
    });
    expect(out).toMatch(/Daily Recap/);
    expect(out).toMatch(/\/dashboard/);
  });

  it('Polish-7: renders correctly with production-like data (3 ads, mixed spend, 0 conv)', () => {
    const out = formatDailyRecap({
      summaryDate: '2026-05-23',
      totalSpendUsd: 68.42,
      totalConversions: 0,
      impliedRoas: 0,
      adsActiveCount: 0,
      adsKilledToday: 3,
      adsScaledToday: 0,
      bestHeadline: null,
      bestSpendUsd: 24.15,
      bestConv: 0,
      bestRoas: 0,
      worstHeadline: null,
      worstSpendUsd: 22.01,
      worstConv: 0,
    });
    expect(out).toMatch(/\$68\.42/);
    expect(out).toMatch(/Conversions: 0/);
    expect(out).toMatch(/ROAS: 0\.00x/);
    expect(out).toMatch(/Killed yesterday: 3/);
    expect(out).not.toMatch(/Best performer/);
    expect(out).toMatch(/\/dashboard/);
    expect(out.length).toBeGreaterThan(50);
    expect(out.length).toBeLessThan(2000);
  });

  it('Polish-7: renders with best/worst headlines without crashing', () => {
    const out = formatDailyRecap({
      summaryDate: '2026-05-23',
      totalSpendUsd: 68.42,
      totalConversions: 2,
      impliedRoas: 1.46,
      adsActiveCount: 2,
      adsKilledToday: 1,
      adsScaledToday: 0,
      bestHeadline: 'Try This Natural Balm',
      bestSpendUsd: 24.15,
      bestConv: 2,
      bestRoas: 4.14,
      worstHeadline: 'Dermatologist Approved',
      worstSpendUsd: 22.01,
      worstConv: 0,
    });
    expect(out).toMatch(/Best performer: "Try This Natural Balm"/);
    expect(out).toMatch(/Worst performer: "Dermatologist Approved"/);
    expect(out).toMatch(/\$24\.15/);
    expect(out).toMatch(/4\.14x/);
  });

  it('Polish-7: output is always a valid non-empty string (never NaN or undefined interpolated)', () => {
    const cases = [
      { totalSpendUsd: NaN, totalConversions: NaN, impliedRoas: NaN },
      { totalSpendUsd: Infinity, totalConversions: -1 },
      { totalSpendUsd: 0, totalConversions: 0, impliedRoas: null },
    ];
    for (const overrides of cases) {
      const out = formatDailyRecap({ ...base, ...overrides });
      expect(out).not.toMatch(/undefined/);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toMatch(/\/dashboard/);
    }
  });
});
