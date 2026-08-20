/**
 * Core domain types for the Bulgaria holiday deal tracker.
 *
 * One "quote" = one price the booking engine returned for one
 * (check-in, nights, room/board) combination at one point in time.
 */

export interface Occupancy {
  adults: number;
  /** Ages of the children in the party, e.g. [12]. */
  childAges: number[];
}

/** A single search we ask the booking engine to price. */
export interface SearchQuery {
  /** ISO date, YYYY-MM-DD. */
  checkIn: string;
  /** ISO date, YYYY-MM-DD. */
  checkOut: string;
  nights: number;
  occupancy: Occupancy;
  currency: string;
}

/** One priced offer returned for a SearchQuery. */
export interface Quote {
  checkIn: string;
  checkOut: string;
  nights: number;
  /** Room type + board, as reported by the engine. Stable-ish grouping key. */
  label: string;
  /** Total stay price for the whole party, in `currency`. */
  total: number;
  currency: string;
  /** Where the number came from — heuristics are flagged so alerts can say so. */
  confidence: 'exact' | 'heuristic';
  /** Deep link a human can open to book this. */
  url?: string;
  /** Epoch ms when the quote was observed. */
  observedAt: number;
}

export interface SourceResult {
  query: SearchQuery;
  quotes: Quote[];
  /** Populated when the source failed; `quotes` is then empty. */
  error?: string;
}

/** A price source (booking engine adapter). */
export interface Source {
  readonly name: string;
  /** Called once before the first query — open a browser, warm a session, etc. */
  init?(): Promise<void>;
  fetchQuotes(query: SearchQuery): Promise<Quote[]>;
  close?(): Promise<void>;
}

export type AlertReason = 'new_low' | 'price_drop' | 'target_hit' | 'back_in_stock';

export interface Alert {
  reason: AlertReason;
  quote: Quote;
  /** Price this key was last seen at, if any. */
  previousTotal?: number;
  /** Best price ever recorded for this key before this observation. */
  previousBest?: number;
  /** Negative = cheaper than last time. */
  changePct?: number;
  /** Price per person per night, party size included. */
  pppn: number;
}

/** Per-(check-in, nights, label) price history. */
export interface TrackedPrice {
  key: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  label: string;
  currency: string;
  lastTotal: number;
  lastSeenAt: number;
  bestTotal: number;
  bestSeenAt: number;
  firstSeenAt: number;
  /** Rolling window of recent observations (capped). */
  history: Array<{ at: number; total: number }>;
}

export interface AlertLogEntry {
  key: string;
  reason: AlertReason;
  at: number;
  total: number;
}

export interface TrackerState {
  version: 1;
  /** True once the first full sweep has completed — before that we never spam. */
  baselineComplete: boolean;
  /** Rolling cursor into the search matrix, so each tick scans a slice. */
  cursor: number;
  /** Telegram getUpdates offset. */
  telegramOffset: number;
  paused: boolean;
  /** Runtime-tunable overrides set via Telegram commands. */
  overrides: {
    targetTotal?: number;
    targetPppn?: number;
    dropPct?: number;
  };
  prices: Record<string, TrackedPrice>;
  alerts: AlertLogEntry[];
  stats: {
    ticks: number;
    queries: number;
    errors: number;
    lastTickAt?: number;
    lastErrorAt?: number;
    lastError?: string;
  };
}
