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
});
