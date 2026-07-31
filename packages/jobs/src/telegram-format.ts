import type { DashboardMetrics, TimeRange } from '@mbb/db';
import type { TelegramNotificationPreferences } from '@mbb/db';

/**
 * Polish-25.8 Commit 48: format DashboardMetrics for daily/weekly
 * Telegram summaries. Three formats, per user preference:
 *
 *   compact  — single-line ("Yesterday: $X, Y conv, Z ROAS…")
 *   detailed — multi-line, key metrics only
 *   verbose  — full markdown-style table with breakdown
 */

export function formatSummary(input: {
  metrics: DashboardMetrics;
  range: TimeRange;
  format: TelegramNotificationPreferences['summary_format'];
  label: string;
}): string {
  const { metrics, format, label } = input;
  const roas =
    metrics.impliedRoas != null
      ? `${metrics.impliedRoas.toFixed(2)}x${metrics.impliedRoasIsEstimate ? '*' : ''}`
      : '—';
  const spend = `$${metrics.totalSpendUsd.toFixed(2)}`;
  const conv = metrics.totalConversions.toLocaleString();

  if (format === 'compact') {
    return `${label}: ${spend} spend · ${conv} conv · ROAS ${roas} · ${metrics.adsKilledCount} killed · ${metrics.adsScaledCount} scaled`;
  }

  const ctr = metrics.avgCtrPct != null ? `${metrics.avgCtrPct.toFixed(2)}%` : '—';
  const cpc = metrics.avgCpcUsd != null ? `$${metrics.avgCpcUsd.toFixed(2)}` : '—';
  const lines: string[] = [
    `📊 ${label}`,
    '',
    `Spend       ${spend}`,
    `Impressions ${metrics.totalImpressions.toLocaleString()}`,
    `Clicks      ${metrics.totalClicks.toLocaleString()} (CTR ${ctr}, CPC ${cpc})`,
    `Conversions ${conv}`,
    `ROAS        ${roas}`,
    '',
    `Active ads  ${metrics.adsActiveCount}`,
    `Killed      ${metrics.adsKilledCount}`,
    `Scaled      ${metrics.adsScaledCount}`,
  ];

  if (format === 'verbose' && metrics.timeSeries.length > 0) {
    lines.push('', 'Daily breakdown:');
    for (const p of metrics.timeSeries.slice(-7)) {
      lines.push(
        `  ${p.date}  $${p.spendUsd.toFixed(2).padStart(8)}  ${String(p.conversions).padStart(4)} conv`,
      );
    }
  }

  if (metrics.impliedRoasIsEstimate) {
    lines.push('', '* ROAS estimated — Meta pixel not sending purchase values.');
  }

  return lines.join('\n');
}
