import type { Config } from '../config.js';
import { parseISODate } from '../matrix.js';
import type { Quote, SearchQuery, Source } from '../types.js';

/**
 * Offline source. Produces plausible, deterministic-but-drifting prices so
 * the whole pipeline — matrix, history, alerts, Telegram formatting — can be
 * exercised end to end without touching the hotel's servers.
 *
 * Set TRACKER_SOURCE=mock to demo the bot; never use it to book a holiday.
 */

const ROOMS = [
  { label: 'Standard double, park view — Ultra All Inclusive', factor: 1 },
  { label: 'Standard double, partial sea view — Ultra All Inclusive', factor: 1.14 },
  { label: 'Family room, sea view — Ultra All Inclusive', factor: 1.38 },
];

/** Cheap deterministic hash → [0, 1). Keeps runs reproducible. */
function hash01(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Base per-person-per-night rate, shaped like a Black Sea season curve. */
function seasonRate(checkIn: string): number {
  const date = parseISODate(checkIn);
  const dayOfYear = Math.floor(
    (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000,
  );
  const peak = 205; // early August
  const distance = Math.abs(dayOfYear - peak);
  return 52 + 46 * Math.exp(-((distance / 26) ** 2));
}

export class MockSource implements Source {
  readonly name = 'mock';
  /** Bumped every sweep so prices wander and alerts have something to fire on. */
  private round = 0;

  constructor(private readonly cfg: Config) {}

  bumpRound(): void {
    this.round++;
  }

  /** Seeded from the tick count so prices keep moving across restarts. */
  setRound(round: number): void {
    this.round = round;
  }

  async fetchQuotes(query: SearchQuery): Promise<Quote[]> {
    const partySize = this.cfg.partySize;
    const observedAt = Date.now();

    return ROOMS.map((room) => {
      const base = seasonRate(query.checkIn) * room.factor;
      // Longer stays get a small discount, as most all-inclusives do.
      const stayDiscount = query.nights >= 10 ? 0.93 : 1;
      const wobble =
        0.9 + 0.2 * hash01(`${query.checkIn}|${query.nights}|${room.label}|${this.round}`);
      const total = base * query.nights * partySize * stayDiscount * wobble;

      return {
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights: query.nights,
        label: room.label,
        total: Math.round(total),
        currency: query.currency,
        confidence: 'exact' as const,
        observedAt,
      };
    });
  }
}
