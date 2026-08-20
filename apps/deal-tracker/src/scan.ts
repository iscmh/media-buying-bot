import type { Config } from './config.js';
import { evaluateQuote, isPlausible } from './deal.js';
import { sliceMatrix } from './matrix.js';
import { logQuote } from './store.js';
import { sleep } from './telegram.js';
import type { Alert, SearchQuery, Source, TrackerState } from './types.js';

export interface TickResult {
  queriesRun: number;
  quotesSeen: number;
  alerts: Alert[];
  errors: string[];
  /** True when this tick finished the first pass over the whole matrix. */
  completedBaseline: boolean;
}

/**
 * Runs `limit` workers over `items`, pausing `delayMs` between each start.
 *
 * The hotel's booking engine is a small business's server, not an API
 * product: two workers with a ~1s gap is enough to sweep a season in
 * minutes while staying gentler than a single human clicking around.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
      if (delayMs > 0) await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

interface QueryOutcome {
  query: SearchQuery;
  alerts: Alert[];
  quotes: number;
  error?: string;
}

/**
 * Prices one slice of the search matrix and folds the results into state.
 *
 * Alerts are returned rather than sent — the caller owns delivery, so quiet
 * hours and a failed Telegram call can't silently eat a price history update.
 */
export async function runTick(
  cfg: Config,
  state: TrackerState,
  source: Source,
  matrix: SearchQuery[],
  options: { full?: boolean } = {},
): Promise<TickResult> {
  const queries = options.full
    ? matrix
    : sliceMatrix(matrix, state.cursor, cfg.TRACKER_QUERIES_PER_TICK);

  const outcomes = await mapPool(
    queries,
    cfg.TRACKER_CONCURRENCY,
    cfg.TRACKER_REQUEST_DELAY_MS,
    async (query): Promise<QueryOutcome> => {
      try {
        const quotes = await source.fetchQuotes(query);
        const alerts: Alert[] = [];
        let counted = 0;

        for (const quote of quotes) {
          if (!isPlausible(cfg, quote)) continue;
          counted++;
          logQuote(cfg.TRACKER_LOG_FILE, quote);
          const { key, tracked, alert } = evaluateQuote(cfg, state, quote);
          state.prices[key] = tracked;
          if (alert) alerts.push(alert);
        }
        return { query, alerts, quotes: counted };
      } catch (err) {
        return {
          query,
          alerts: [],
          quotes: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  const errors = outcomes.flatMap((o) => (o.error ? [`${o.query.checkIn}: ${o.error}`] : []));
  const alerts = outcomes.flatMap((o) => o.alerts);
  const quotesSeen = outcomes.reduce((sum, o) => sum + o.quotes, 0);

  // Advance the rolling cursor; wrapping past the end means we have now
  // priced every combination at least once, so alerting can switch on.
  let completedBaseline = false;
  if (options.full) {
    completedBaseline = !state.baselineComplete;
    state.baselineComplete = true;
  } else if (matrix.length > 0) {
    const nextCursor = state.cursor + queries.length;
    if (!state.baselineComplete && nextCursor >= matrix.length) {
      state.baselineComplete = true;
      completedBaseline = true;
    }
    state.cursor = nextCursor % matrix.length;
  }

  state.stats.ticks++;
  state.stats.queries += queries.length;
  state.stats.errors += errors.length;
  state.stats.lastTickAt = Date.now();
  const lastError = errors[errors.length - 1];
  if (lastError !== undefined) {
    state.stats.lastError = lastError;
    state.stats.lastErrorAt = Date.now();
  }

  return { queriesRun: queries.length, quotesSeen, alerts, errors, completedBaseline };
}

/** Cheapest-first, so the most interesting alert lands at the top of the chat. */
export function rankAlerts(alerts: Alert[]): Alert[] {
  const priority: Record<Alert['reason'], number> = {
    target_hit: 0,
    new_low: 1,
    price_drop: 2,
    back_in_stock: 3,
  };
  return [...alerts].sort((a, b) => priority[a.reason] - priority[b.reason] || a.pppn - b.pppn);
}
