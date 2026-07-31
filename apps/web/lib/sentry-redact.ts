import type { Event, EventHint } from '@sentry/nextjs';
import { REDACTED, scrubString, scrubValue } from '@mbb/shared';

/**
 * Polish-25.7 Commit 44: shared `beforeSend` hook for every Sentry
 * runtime (client / server / edge).
 *
 * Polish-25.7 Commit 46: credential/PII scrubbing rules moved to
 * @mbb/shared/redact so the first-party error_log writer uses the
 * exact same rules. This module is now a thin Sentry-shaped adapter
 * over that shared code — no drift between the two audit trails.
 */

// Legacy exports for the existing sentry-redact.test.ts.
export const _scrubValueForTests = scrubValue;
export const _scrubStringForTests = scrubString;

export function redactSentryEvent<T extends Event>(event: T, _hint?: EventHint): T {
  if (event.message) event.message = scrubString(event.message);

  const values = event.exception?.values;
  if (Array.isArray(values)) {
    for (const v of values) {
      if (typeof v.value === 'string') v.value = scrubString(v.value);
    }
  }

  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (typeof b.message === 'string') b.message = scrubString(b.message);
      if (b.data) b.data = scrubValue(b.data) as typeof b.data;
    }
  }

  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubValue(event.request.data) as typeof event.request.data;
    }
    if (event.request.headers) {
      event.request.headers = scrubValue(event.request.headers) as typeof event.request.headers;
    }
    if (typeof event.request.url === 'string') {
      event.request.url = scrubString(event.request.url);
    }
  }

  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;

  return event;
}

// Silence unused-import warning on REDACTED — kept exported for
// tests that assert on the exact sentinel.
export { REDACTED };
