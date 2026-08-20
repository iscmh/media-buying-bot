import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertLogEntry, Quote, TrackedPrice, TrackerState } from './types.js';

const HISTORY_CAP = 60;
const ALERT_LOG_CAP = 500;

export function emptyState(): TrackerState {
  return {
    version: 1,
    baselineComplete: false,
    cursor: 0,
    telegramOffset: 0,
    paused: false,
    overrides: {},
    prices: {},
    alerts: [],
    stats: { ticks: 0, queries: 0, errors: 0 },
  };
}

export function loadState(file: string): TrackerState {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TrackerState>;
    if (parsed.version !== 1) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    // First run, or a truncated file from a hard kill — start clean rather
    // than crash-looping. Losing history costs one baseline sweep.
    return emptyState();
  }
}

export function saveState(file: string, state: TrackerState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file); // atomic — a crash mid-write can't corrupt state
}

/** Append-only quote log, handy for plotting price curves later. */
export function logQuote(file: string, quote: Quote): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(quote) + '\n', 'utf8');
  } catch {
    // Logging is best-effort; never take the tracker down over it.
  }
}

export function recordAlert(state: TrackerState, entry: AlertLogEntry): void {
  state.alerts.push(entry);
  if (state.alerts.length > ALERT_LOG_CAP) {
    state.alerts.splice(0, state.alerts.length - ALERT_LOG_CAP);
  }
}

/** Most recent alert for this offer + reason, used for cooldown checks. */
export function lastAlertAt(state: TrackerState, key: string, reason: string): number | undefined {
  for (let i = state.alerts.length - 1; i >= 0; i--) {
    const entry = state.alerts[i];
    if (entry && entry.key === key && entry.reason === reason) return entry.at;
  }
  return undefined;
}

export function upsertPrice(existing: TrackedPrice | undefined, quote: Quote): TrackedPrice {
  const key = existing?.key ?? '';
  if (!existing) {
    return {
      key,
      checkIn: quote.checkIn,
      checkOut: quote.checkOut,
      nights: quote.nights,
      label: quote.label,
      currency: quote.currency,
      lastTotal: quote.total,
      lastSeenAt: quote.observedAt,
      bestTotal: quote.total,
      bestSeenAt: quote.observedAt,
      firstSeenAt: quote.observedAt,
      history: [{ at: quote.observedAt, total: quote.total }],
    };
  }

  const history = [...existing.history, { at: quote.observedAt, total: quote.total }];
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);

  return {
    ...existing,
    label: quote.label,
    currency: quote.currency,
    lastTotal: quote.total,
    lastSeenAt: quote.observedAt,
    bestTotal: Math.min(existing.bestTotal, quote.total),
    bestSeenAt: quote.total < existing.bestTotal ? quote.observedAt : existing.bestSeenAt,
    history,
  };
}
