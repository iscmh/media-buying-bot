import { z } from 'zod';
import type { Occupancy } from './types.js';

/**
 * All tuning lives in env vars so the tracker can run from a laptop, a
 * Raspberry Pi or a $4 VPS without touching code. Anything a human might
 * want to change mid-hunt (target price, drop threshold) is *also*
 * changeable at runtime over Telegram — see state.overrides.
 */

const csvNumbers = (fallback: number[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n)),
    );

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const ConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  /** api = replay a captured JSON endpoint, browser = drive Playwright, mock = offline demo. */
  TRACKER_SOURCE: z.enum(['api', 'browser', 'mock']).default('mock'),
  TRACKER_BOOKING_URL: z
    .string()
    .url()
    .default('https://reservations.hvdhotels.com/hvd-reina-del-mar/'),
  /**
   * Optional deep-link template used by the browser source and by the
   * "book this" links in alerts. Placeholders: {checkIn} {checkOut}
   * {nights} {adults} {children} {childAges} {currency}
   */
  TRACKER_URL_TEMPLATE: z.string().optional(),
  TRACKER_ENDPOINT_FILE: z.string().default('./data/endpoint.json'),

  TRACKER_ADULTS: z.coerce.number().int().min(1).max(10).default(3),
  TRACKER_CHILD_AGES: csvNumbers([12]),
  TRACKER_CURRENCY: z.string().min(3).max(3).default('EUR'),

  /** Range of check-in dates to sweep, both ends inclusive. Stays may end after it. */
  TRACKER_SEASON_START: isoDate.default('2027-06-01'),
  TRACKER_SEASON_END: isoDate.default('2027-09-15'),
  TRACKER_NIGHTS: csvNumbers([7, 10, 14]),
  TRACKER_CHECKIN_STEP_DAYS: z.coerce.number().int().min(1).max(30).default(1),
  /** Only sweep these weekday check-ins (0=Sun..6=Sat). Empty = all days. */
  TRACKER_CHECKIN_WEEKDAYS: csvNumbers([]),

  TRACKER_POLL_MINUTES: z.coerce.number().min(1).max(1440).default(5),
  /**
   * The full matrix is far too big to re-price every few minutes without
   * hammering the hotel. Each tick prices a slice and the cursor advances,
   * so the whole season is covered every (matrixSize / sliceSize) ticks.
   */
  TRACKER_QUERIES_PER_TICK: z.coerce.number().int().min(1).max(500).default(24),
  TRACKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  TRACKER_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1200),

  /** Alert when a tracked price falls at least this much vs the last observation. */
  TRACKER_DROP_PCT: z.coerce.number().min(0.5).max(90).default(4),
  /** Alert on any offer at or below this total stay price. Unset = off. */
  TRACKER_TARGET_TOTAL: z.coerce.number().positive().optional(),
  /** Alert on any offer at or below this price per person per night. Unset = off. */
  TRACKER_TARGET_PPPN: z.coerce.number().positive().optional(),
  /** Silence repeat alerts for the same offer+reason for this long. */
  TRACKER_ALERT_COOLDOWN_HOURS: z.coerce.number().min(0).max(168).default(6),
  /** Ignore quotes below this total — guards against scraping a per-night or deposit figure. */
  TRACKER_MIN_PLAUSIBLE_TOTAL: z.coerce.number().min(0).default(150),
  /** Ignore absurd quotes (data glitches, wrong currency). */
  TRACKER_MAX_PLAUSIBLE_TOTAL: z.coerce.number().min(1).default(30_000),

  /** "23-8" = no alerts between 23:00 and 08:00 local. Unset = always on. */
  TRACKER_QUIET_HOURS: z
    .string()
    .regex(/^\d{1,2}-\d{1,2}$/)
    .optional(),
  TRACKER_STATE_FILE: z.string().default('./data/state.json'),
  TRACKER_LOG_FILE: z.string().default('./data/quotes.ndjson'),
  TRACKER_HEADLESS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface Config extends RawConfig {
  occupancy: Occupancy;
  /** Adults + children — what we divide by for per-person maths. */
  partySize: number;
  quietHours?: { from: number; to: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  const occupancy: Occupancy = {
    adults: parsed.TRACKER_ADULTS,
    childAges: parsed.TRACKER_CHILD_AGES,
  };

  let quietHours: Config['quietHours'];
  if (parsed.TRACKER_QUIET_HOURS) {
    const [from, to] = parsed.TRACKER_QUIET_HOURS.split('-').map(Number);
    if (from !== undefined && to !== undefined) quietHours = { from, to };
  }

  return {
    ...parsed,
    occupancy,
    partySize: occupancy.adults + occupancy.childAges.length,
    quietHours,
  };
}

/** True when `date` (local time) falls inside the configured quiet window. */
export function inQuietHours(cfg: Config, date: Date): boolean {
  if (!cfg.quietHours) return false;
  const { from, to } = cfg.quietHours;
  const h = date.getHours();
  // Windows that wrap midnight (23-8) need the OR form.
  return from <= to ? h >= from && h < to : h >= from || h < to;
}
