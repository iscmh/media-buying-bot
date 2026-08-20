import type { Config } from './config.js';
import type { RankedDeal } from './deal.js';
import { parseISODate, renderTemplate } from './matrix.js';
import type { Alert, SearchQuery, TrackerState } from './types.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDate(iso: string): string {
  const d = parseISODate(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value)} ${currency}`;
  }
}

const REASON_HEADERS: Record<Alert['reason'], string> = {
  target_hit: '🎯 <b>TARGET HIT</b>',
  new_low: '📉 <b>New lowest price</b>',
  price_drop: '💸 <b>Price drop</b>',
  back_in_stock: '🔓 <b>Back on sale</b>',
};

/** Deep link a human can click to land on the same search. */
export function bookingLink(
  cfg: Config,
  query: Pick<SearchQuery, 'checkIn' | 'checkOut' | 'nights'>,
): string {
  const full: SearchQuery = {
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    nights: query.nights,
    occupancy: cfg.occupancy,
    currency: cfg.TRACKER_CURRENCY,
  };
  return cfg.TRACKER_URL_TEMPLATE
    ? renderTemplate(cfg.TRACKER_URL_TEMPLATE, full)
    : cfg.TRACKER_BOOKING_URL;
}

export function formatAlert(cfg: Config, alert: Alert): string {
  const { quote } = alert;
  const lines: string[] = [REASON_HEADERS[alert.reason]];

  lines.push(
    `${escapeHtml(quote.label)}`,
    `🗓 ${formatDate(quote.checkIn)} → ${formatDate(quote.checkOut)} (${quote.nights} nights)`,
    `👨‍👩‍👧 ${cfg.occupancy.adults} adults + ${cfg.occupancy.childAges.length} child (${cfg.occupancy.childAges.join(', ')})`,
    '',
    `<b>${formatMoney(quote.total, quote.currency)}</b> total — ${formatMoney(alert.pppn, quote.currency)} per person / night`,
  );

  if (alert.previousTotal !== undefined && alert.changePct !== undefined) {
    const arrow = alert.changePct <= 0 ? '↓' : '↑';
    lines.push(
      `${arrow} was ${formatMoney(alert.previousTotal, quote.currency)} (${alert.changePct >= 0 ? '+' : ''}${alert.changePct.toFixed(1)}%)`,
    );
  }
  if (alert.previousBest !== undefined && alert.reason === 'new_low') {
    lines.push(`Previous best: ${formatMoney(alert.previousBest, quote.currency)}`);
  }
  if (quote.confidence === 'heuristic') {
    lines.push('', '⚠️ <i>Price read heuristically — verify on the site before booking.</i>');
  }

  const link = quote.url ?? bookingLink(cfg, quote);
  lines.push('', `<a href="${escapeHtml(link)}">Open booking page</a>`);
  return lines.join('\n');
}

export function formatDealList(deals: RankedDeal[], title: string): string {
  if (deals.length === 0) {
    return `${title}\n\nNothing tracked yet — give it a sweep or two.`;
  }
  const lines = [title, ''];
  deals.forEach((deal, i) => {
    lines.push(
      `<b>${i + 1}.</b> ${formatMoney(deal.bestTotal, deal.currency)} · ${formatMoney(deal.pppn, deal.currency)}/pp/night`,
      `    ${formatDate(deal.checkIn)} · ${deal.nights}n · ${escapeHtml(deal.label)}`,
    );
  });
  return lines.join('\n');
}

export function formatStatus(cfg: Config, state: TrackerState, matrixSize: number): string {
  const { stats } = state;
  const tracked = Object.keys(state.prices).length;
  const lastTick = stats.lastTickAt ? new Date(stats.lastTickAt).toISOString() : 'never';
  const target = state.overrides.targetTotal ?? cfg.TRACKER_TARGET_TOTAL;
  const targetPppn = state.overrides.targetPppn ?? cfg.TRACKER_TARGET_PPPN;

  return [
    '📊 <b>Tracker status</b>',
    '',
    `Source: <code>${cfg.TRACKER_SOURCE}</code>${state.paused ? ' (⏸ paused)' : ''}`,
    `Season: ${cfg.TRACKER_SEASON_START} → ${cfg.TRACKER_SEASON_END}`,
    `Stays: ${cfg.TRACKER_NIGHTS.join(', ')} nights · party ${cfg.occupancy.adults}+${cfg.occupancy.childAges.length}`,
    `Search matrix: ${matrixSize} combos, ${cfg.TRACKER_QUERIES_PER_TICK}/tick every ${cfg.TRACKER_POLL_MINUTES}m`,
    `Full sweep: ~${Math.ceil((matrixSize / cfg.TRACKER_QUERIES_PER_TICK) * cfg.TRACKER_POLL_MINUTES)} min`,
    `Baseline: ${state.baselineComplete ? '✅ complete' : '⏳ building'}`,
    '',
    `Tracked offers: ${tracked}`,
    `Ticks: ${stats.ticks} · queries: ${stats.queries} · errors: ${stats.errors}`,
    `Last tick: ${lastTick}`,
    stats.lastError ? `Last error: <code>${escapeHtml(stats.lastError.slice(0, 200))}</code>` : '',
    '',
    `Drop threshold: ${state.overrides.dropPct ?? cfg.TRACKER_DROP_PCT}%`,
    `Target total: ${target !== undefined ? formatMoney(target, cfg.TRACKER_CURRENCY) : 'not set'}`,
    `Target pp/night: ${targetPppn !== undefined ? formatMoney(targetPppn, cfg.TRACKER_CURRENCY) : 'not set'}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export const HELP_TEXT = [
  '🏖 <b>Reina del Mar deal tracker</b>',
  '',
  '/best — cheapest prices ever seen',
  '/now — cheapest currently on sale',
  '/status — what the tracker is doing',
  '/scan — force a sweep right now',
  '/target &lt;amount&gt; — alert at/below this total (0 clears)',
  '/pppn &lt;amount&gt; — alert at/below this per person per night (0 clears)',
  '/drop &lt;pct&gt; — alert on drops of at least this much',
  '/pause · /resume — stop / restart scanning',
  '/help — this message',
].join('\n');
