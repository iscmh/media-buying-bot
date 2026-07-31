import { createHash } from 'node:crypto';
import { scrubString, scrubValue } from '@mbb/shared';
import { getDb } from './client';
import { errorLog, type ErrorLogSeverity, type ErrorLogSource } from './schema/error-log';

/**
 * Polish-25.7 Commit 46: first-party error logger.
 *
 * Called by every server-side error catch:
 *   - server-action wrapper (apps/web/lib/with-error-logging.ts)
 *   - API-route wrapper (apps/web/lib/with-api-error-logging.ts)
 *   - Inngest onFailure hook (packages/jobs/src/error-hook.ts)
 *   - /api/log-error POST endpoint (relaying client errors)
 *
 * Design rules:
 *   1. NEVER throws. Errors during error logging must not cascade
 *      into user-facing failures. Console.error fallback + swallow.
 *   2. All string + jsonb fields run through @mbb/shared/redact
 *      before write. Same rules as sentry-redact so no split brain.
 *   3. Truncates message to 2000 chars, stack to 8000 chars — Sentry
 *      does the same. Keeps rows bounded even on absurd payloads.
 *   4. Fingerprint = sha1(source|source_name|normalized_message).
 *      Powers the "grouped" admin view. Message normalization
 *      strips UUIDs / numbers / timestamps so 'Job abc-def failed
 *      at 12:31:05' groups with 'Job xyz-uvw failed at 14:02:11'.
 */

const MESSAGE_MAX = 2000;
const STACK_MAX = 8000;

export interface LogErrorInput {
  userId?: string | null;
  source: ErrorLogSource;
  sourceName?: string | null;
  error: unknown;
  /** Extra structured context. Redacted before write. */
  context?: Record<string, unknown>;
  /** Optional pre-collected breadcrumbs (server-side calls rarely supply). */
  breadcrumbs?: Array<Record<string, unknown>>;
  severity?: ErrorLogSeverity;
}

export async function logError(input: LogErrorInput): Promise<void> {
  try {
    const { message, stack } = extractErrorFields(input.error);
    const truncatedMessage = truncate(scrubString(message), MESSAGE_MAX);
    const truncatedStack = stack ? truncate(scrubString(stack), STACK_MAX) : null;
    const scrubbedContext = (scrubValue(input.context ?? {}) as Record<string, unknown>) ?? {};
    const scrubbedBreadcrumbs =
      (scrubValue(input.breadcrumbs ?? []) as Array<Record<string, unknown>>) ?? [];

    const fingerprint = computeFingerprint(
      input.source,
      input.sourceName ?? null,
      truncatedMessage,
    );

    const db = getDb();
    await db.insert(errorLog).values({
      userId: input.userId ?? null,
      source: input.source,
      sourceName: input.sourceName ?? null,
      message: truncatedMessage,
      stack: truncatedStack,
      context: scrubbedContext,
      breadcrumbs: scrubbedBreadcrumbs,
      severity: input.severity ?? 'error',
      fingerprint,
    });
  } catch (writeErr) {
    // Never let the logger itself throw. Fallback = console so at
    // least stdout captures the original error + the logger failure.
     
    console.error('[error-log] insert failed', {
      writeErr: writeErr instanceof Error ? writeErr.message : String(writeErr),
      originalErrorPreview:
        input.error instanceof Error
          ? input.error.message.slice(0, 200)
          : String(input.error).slice(0, 200),
    });
  }
}

function extractErrorFields(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: err.message || err.name || 'Unknown error', stack: err.stack ?? null };
  }
  if (typeof err === 'string') return { message: err, stack: null };
  try {
    return { message: JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Fingerprint groups repeated errors. Normalization:
 *   - lowercase
 *   - UUIDs → `<uuid>`
 *   - long numeric ids (>=8 digits) → `<num>`
 *   - ISO timestamps → `<time>`
 *   - collapse whitespace
 *
 * Then sha1 the source|source_name|normalized for a stable 40-char
 * key. Callers can then GROUP BY fingerprint in admin queries.
 */
export function computeFingerprint(
  source: string,
  sourceName: string | null,
  message: string,
): string {
  const normalized = message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<time>')
    .replace(/\b\d{8,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
  const input = `${source}|${sourceName ?? ''}|${normalized}`;
  return createHash('sha1').update(input).digest('hex');
}
