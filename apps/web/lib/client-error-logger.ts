'use client';

/**
 * Polish-25.7 Commit 46: client-side error logger + breadcrumb buffer.
 *
 * Batches errors + a rolling breadcrumb ring, POSTs to /api/log-error
 * where the API-route wrapper writes them into error_log with the
 * shared redaction rules.
 *
 * Design rules:
 *   1. NEVER logs its own failures (would loop forever). If the POST
 *      to /api/log-error fails, we drop the batch and console.warn.
 *   2. Rate-limited: max 10 events per rolling minute per tab. Any
 *      excess drops silently — this is a beta safety valve so a
 *      buggy component doesn't nuke Sentry quota + error_log rows.
 *   3. Breadcrumbs are a ring buffer of the last 20 events. Cleared
 *      after a batch send so old context doesn't stack up.
 *   4. Auto-flush every 5s. Also flushes on visibilitychange=hidden
 *      via sendBeacon so we don't lose the last batch on tab close.
 */

const BREADCRUMB_LIMIT = 20;
const BATCH_MAX = 10;
const FLUSH_INTERVAL_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

export interface Breadcrumb {
  timestamp: string;
  category: 'navigation' | 'click' | 'submit' | 'fetch' | 'log';
  message: string;
  data?: Record<string, unknown>;
}

interface ClientErrorPayload {
  source: 'client_render' | 'client_boundary' | 'unhandled_promise';
  sourceName?: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  severity?: 'error' | 'warning' | 'info';
  timestamp: string;
}

let breadcrumbs: Breadcrumb[] = [];
let pendingErrors: ClientErrorPayload[] = [];
let rateLimitTimestamps: number[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let handlersInstalled = false;

function addBreadcrumb(b: Breadcrumb): void {
  breadcrumbs.push(b);
  if (breadcrumbs.length > BREADCRUMB_LIMIT) {
    breadcrumbs = breadcrumbs.slice(-BREADCRUMB_LIMIT);
  }
}

function withinRateLimit(): boolean {
  const now = Date.now();
  rateLimitTimestamps = rateLimitTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (rateLimitTimestamps.length >= RATE_LIMIT_MAX) return false;
  rateLimitTimestamps.push(now);
  return true;
}

async function flush(useBeacon = false): Promise<void> {
  if (pendingErrors.length === 0) return;
  const batch = pendingErrors.slice(0, BATCH_MAX);
  pendingErrors = pendingErrors.slice(BATCH_MAX);
  const body = JSON.stringify({ events: batch });
  try {
    if (useBeacon && typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      // sendBeacon fires-and-forgets — perfect for the visibilitychange
      // path where fetch would be cancelled on unload.
      navigator.sendBeacon('/api/log-error', new Blob([body], { type: 'application/json' }));
      return;
    }
    await fetch('/api/log-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // keepalive lets the request survive a partial navigation.
      keepalive: true,
    });
  } catch {
    // Silently drop. The whole point of NEVER logging our own
    // failures is that a broken /api/log-error must not loop.
  }
}

function ensureHandlersInstalled(): void {
  if (handlersInstalled || typeof window === 'undefined') return;
  handlersInstalled = true;

  flushTimer = setInterval(() => {
    void flush(false);
  }, FLUSH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(true);
  });

  // Global unhandled-error safety nets. React error boundaries
  // catch component tree errors; these two catch everything else.
  window.addEventListener('error', (evt) => {
    logClientError({
      source: 'unhandled_promise',
      sourceName: 'window.onerror',
      error: evt.error ?? new Error(evt.message || 'unknown window error'),
      context: {
        filename: evt.filename ?? null,
        lineno: evt.lineno ?? null,
        colno: evt.colno ?? null,
      },
    });
  });
  window.addEventListener('unhandledrejection', (evt) => {
    logClientError({
      source: 'unhandled_promise',
      sourceName: 'unhandledrejection',
      error:
        evt.reason instanceof Error
          ? evt.reason
          : new Error(typeof evt.reason === 'string' ? evt.reason : 'unhandled rejection'),
    });
  });
}

/** Fire and forget — logs an error to the batcher. */
export function logClientError(input: {
  source: 'client_render' | 'client_boundary' | 'unhandled_promise';
  sourceName?: string;
  error: unknown;
  context?: Record<string, unknown>;
  severity?: 'error' | 'warning' | 'info';
}): void {
  ensureHandlersInstalled();
  if (!withinRateLimit()) return;

  const err = input.error;
  const message =
    err instanceof Error
      ? err.message || err.name || 'client error'
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  const stack = err instanceof Error ? err.stack : undefined;

  const payload: ClientErrorPayload = {
    source: input.source,
    sourceName: input.sourceName,
    message,
    stack,
    context: {
      ...input.context,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    },
    breadcrumbs: breadcrumbs.slice(),
    severity: input.severity ?? 'error',
    timestamp: new Date().toISOString(),
  };
  pendingErrors.push(payload);
  // Clear breadcrumbs after attaching to a batch — next error gets
  // a fresh window.
  breadcrumbs = [];
}

/** Public breadcrumb helpers — called by nav / click / fetch wrappers. */
export function logBreadcrumb(b: Omit<Breadcrumb, 'timestamp'>): void {
  ensureHandlersInstalled();
  addBreadcrumb({ ...b, timestamp: new Date().toISOString() });
}

/** For tests only. */
export function _resetForTests(): void {
  breadcrumbs = [];
  pendingErrors = [];
  rateLimitTimestamps = [];
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  handlersInstalled = false;
}
