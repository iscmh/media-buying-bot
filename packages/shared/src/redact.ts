/**
 * Polish-25.7 Commit 46: shared credential/PII scrubber.
 *
 * Extracted from apps/web/lib/sentry-redact.ts so both the Sentry
 * beforeSend hook AND the first-party error_log writer use the same
 * regex + sensitive-key rules. Any credential shape a Sentry event
 * would strip, the internal error_log strips too — no split brain.
 *
 * The bot handles Meta access tokens, Claude / Gemini / OpenAI keys,
 * HeyGen tokens, and Supabase service-role secrets. A stray
 * `throw new Error(...)` including one of those strings in its
 * message would end up on either Sentry OR our own admin/errors
 * table — both unacceptable for a paid product.
 *
 * Errs on the side of over-redacting — a false positive is a
 * slightly harder-to-debug event; a false negative is a leaked key.
 */

const CREDENTIAL_REGEXES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /EAA[A-Za-z0-9]{40,}/g,
  /Bearer\s+[A-Za-z0-9_.-]{20,}/gi,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

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

export const REDACTED = '[REDACTED]';

export function scrubString(s: string): string {
  let out = s;
  for (const re of CREDENTIAL_REGEXES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_HINTS.some((hint) => lower.includes(hint));
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
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
