import type { Config } from './config.js';
import type { Quote, SearchQuery } from './types.js';

const DAY_MS = 86_400_000;

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toISODate(new Date(parseISODate(iso).getTime() + days * DAY_MS));
}

/** 0 = Sunday .. 6 = Saturday, in UTC so it never shifts with the host TZ. */
export function weekdayOf(iso: string): number {
  return parseISODate(iso).getUTCDay();
}

/**
 * Every (check-in, nights) combination we want priced, ordered so that a
 * rolling cursor walks the season in date order rather than jumping about.
 */
export function buildSearchMatrix(cfg: Config): SearchQuery[] {
  const start = parseISODate(cfg.TRACKER_SEASON_START).getTime();
  const end = parseISODate(cfg.TRACKER_SEASON_END).getTime();
  if (end <= start) {
    throw new Error(
      `TRACKER_SEASON_END (${cfg.TRACKER_SEASON_END}) must be after TRACKER_SEASON_START (${cfg.TRACKER_SEASON_START})`,
    );
  }

  const weekdays = new Set(cfg.TRACKER_CHECKIN_WEEKDAYS);
  const nightsList = [...cfg.TRACKER_NIGHTS].sort((a, b) => a - b);
  const queries: SearchQuery[] = [];

  for (let t = start; t <= end; t += cfg.TRACKER_CHECKIN_STEP_DAYS * DAY_MS) {
    const checkIn = toISODate(new Date(t));
    if (weekdays.size > 0 && !weekdays.has(weekdayOf(checkIn))) continue;

    for (const nights of nightsList) {
      // The window bounds check-in dates, not check-out — a stay starting on
      // the last day of the window is still a stay you might book.
      const checkOut = addDays(checkIn, nights);
      queries.push({
        checkIn,
        checkOut,
        nights,
        occupancy: cfg.occupancy,
        currency: cfg.TRACKER_CURRENCY,
      });
    }
  }

  return queries;
}

/** Take `count` queries starting at `cursor`, wrapping around the matrix. */
export function sliceMatrix<T>(matrix: T[], cursor: number, count: number): T[] {
  if (matrix.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < Math.min(count, matrix.length); i++) {
    const item = matrix[(cursor + i) % matrix.length];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/**
 * Grouping key for price history. Room labels vary in whitespace and case
 * between responses, so they are normalised before being folded into the key.
 */
export function quoteKey(quote: Pick<Quote, 'checkIn' | 'nights' | 'label'>): string {
  const label = quote.label.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${quote.checkIn}|${quote.nights}|${label}`;
}

export function pricePerPersonPerNight(total: number, nights: number, partySize: number): number {
  if (nights <= 0 || partySize <= 0) return total;
  return total / (nights * partySize);
}

/**
 * Fills {checkIn}/{adults}/... placeholders in a deep-link or endpoint
 * template. Unknown placeholders are left untouched so a bad template shows
 * up in the logs rather than silently querying the wrong dates.
 */
export function renderTemplate(template: string, query: SearchQuery): string {
  const values: Record<string, string> = {
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    nights: String(query.nights),
    adults: String(query.occupancy.adults),
    children: String(query.occupancy.childAges.length),
    childAges: query.occupancy.childAges.join(','),
    currency: query.currency,
  };
  return template.replace(/\{\{?(\w+)\}?\}/g, (match, name: string) => values[name] ?? match);
}
