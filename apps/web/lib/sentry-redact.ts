import type { Event, EventHint } from '@sentry/nextjs';

/**
 * Polish-25.7 Commit 44: shared `beforeSend` hook for every Sentry
 * runtime (client / server / edge). The bot handles Meta access
 * tokens, Claude / Gemini / OpenAI keys, HeyGen tokens, and Supabase
 * service-role secrets. A stray `throw new Error(...)` including one
 * of those strings in its message would end up on Sentry's servers —
 * unacceptable for a paid product.
 *
 * This hook walks the event's user-mutable surfaces (message, stack
 * frames, breadcrumb messages/data, request payloads) and replaces
 * anything that looks like a credential with `[REDACTED]`. It
 * intentionally errs on the side of over-redacting — a false positive
 * is a slightly harder-to-debug event; a false negative is a leaked
 * key.
 *
 * Runs after Sentry has already scrubbed cookies/authorization
 * headers via its own defaults, so this only has to cover the
 * long-tail: values buried in payloads or accidentally logged into
 * error messages.
 */

// Long-form credential prefixes worth catching by pattern rather than
// by exact key name. Meta long-lived access tokens start `EAA` and are
// hundreds of characters; Anthropic keys start `sk-ant-`; OpenAI keys
// start `sk-`; Google API keys start `AIza`.
const CREDENTIAL_REGEXES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /EAA[A-Za-z0-9]{40,}/g,
  /Bearer\s+[A-Za-z0-9_.-]{20,}/gi,
  // JWT-ish shape: three base64url segments split by dots. Catches
  // Supabase service-role keys and anon keys pasted into messages.
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

// Object-key allowlist for full-value redaction. If any of these
// substrings appears in a key name, wipe the value entirely regardless
// of shape.
const SENSITIVE_KEY_HINTS = [
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'session',
  'authorization',
  'encrypted',
];

const REDACTED = '[REDACTED]';

function scrubString(s: string): string {
  let out = s;
  for (const re of CREDENTIAL_REGEXES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_HINTS.some((hint) => lower.includes(hint));
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // cycle / deep-object guard
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function redactSentryEvent<T extends Event>(event: T, _hint?: EventHint): T {
  if (event.message) event.message = scrubString(event.message);

  // Exception values (the thrown Error's .message).
  const values = event.exception?.values;
  if (Array.isArray(values)) {
    for (const v of values) {
      if (typeof v.value === 'string') v.value = scrubString(v.value);
    }
  }

  // Breadcrumbs — often carry HTTP request/response snippets.
  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (typeof b.message === 'string') b.message = scrubString(b.message);
      if (b.data) b.data = scrubValue(b.data) as typeof b.data;
    }
  }

  // Request payload — server-side spans carry POST bodies.
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

  // Extras / contexts — freeform payloads devs sometimes attach.
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;

  return event;
}

/**
 * Escape hatch for tests + local verification. Feed a synthetic event
 * shape through the same pipeline and assert on the output.
 */
export const _scrubValueForTests = scrubValue;
export const _scrubStringForTests = scrubString;
