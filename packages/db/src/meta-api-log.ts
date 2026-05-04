import { getDb } from './client.js';
import { metaApiCallLogs } from './schema/logs.js';

const RESPONSE_BODY_EXCERPT_BYTES = 2048;

/**
 * Record a Meta Graph API call. MUST be called for every Meta mutation,
 * dry-run or not. This is a non-negotiable anti-ban guardrail (#6).
 *
 * Sanitization: drop access_token, app_secret, and any field name matching
 * /token|secret|key|password/i from the request body before persisting.
 */
export async function logMetaApiCall(input: {
  userId: string;
  endpoint: string;
  method: string;
  requestBody?: Record<string, unknown>;
  responseStatus?: number;
  responseBody?: unknown;
  latencyMs?: number;
  dryRun?: boolean;
}): Promise<void> {
  const db = getDb();

  const sanitized = sanitize(input.requestBody ?? {});
  const excerpt = excerptResponse(input.responseBody);

  await db.insert(metaApiCallLogs).values({
    userId: input.userId,
    endpoint: input.endpoint,
    method: input.method,
    requestBodySanitized: sanitized,
    responseStatus: input.responseStatus ?? null,
    responseBodyExcerpt: excerpt,
    latencyMs: input.latencyMs ?? null,
    dryRun: input.dryRun ? 1 : 0,
  });
}

const SECRET_KEY_RE = /token|secret|key|password|authorization/i;

function sanitize(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitize(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function excerptResponse(body: unknown): unknown {
  if (body == null) return null;
  try {
    const json = JSON.stringify(body);
    if (json.length <= RESPONSE_BODY_EXCERPT_BYTES) {
      return body;
    }
    return { _truncated: true, excerpt: json.slice(0, RESPONSE_BODY_EXCERPT_BYTES) };
  } catch {
    return { _unserializable: true };
  }
}
