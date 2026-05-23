import { getDb } from './client';
import { aiProviderApiCallLogs } from './schema/logs';

const RESPONSE_BODY_EXCERPT_BYTES = 2048;

/**
 * Phase 3b: log every Gemini / Claude / Kie.ai / HeyGen / etc. call from
 * inside an Inngest generation job. Same sanitization contract as Phase
 * 1's logMetaApiCall:
 *
 *   - Drop API keys + Authorization headers from the request body before
 *     persisting (recursive, matches /key|secret|token|password|authorization/i)
 *   - Excerpt response bodies at ~2 KB; full responses go to the
 *     dryRun=true sink only when explicitly requested
 *
 * Required for liability defense if a customer disputes an AI-generated
 * variant ("the bot generated something I didn't ask for"). Also drives
 * actual_cost_usd rollups per job.
 */
export async function logAiProviderApiCall(input: {
  userId: string;
  // Polish-4: + kling (Replicate cinematic video gen), replicate
  // (generic Replicate calls), elevenlabs (TTS voiceover).
  provider:
    | 'gemini'
    | 'claude'
    | 'kie_ai'
    | 'heygen'
    | 'arcads'
    | 'creatify'
    | 'kling'
    | 'replicate'
    | 'elevenlabs';
  endpoint: string;
  method: string;
  requestBody?: Record<string, unknown>;
  responseStatus?: number;
  responseBody?: unknown;
  latencyMs?: number;
  costUsd?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}): Promise<void> {
  const db = getDb();
  const sanitized = sanitize(input.requestBody ?? {});
  const excerpt = excerptResponse(input.responseBody);

  await db.insert(aiProviderApiCallLogs).values({
    userId: input.userId,
    provider: input.provider,
    endpoint: input.endpoint,
    method: input.method,
    requestBodySanitized: sanitized,
    responseStatus: input.responseStatus ?? null,
    responseBodyExcerpt: excerpt,
    latencyMs: input.latencyMs ?? null,
    costUsd: input.costUsd != null ? input.costUsd.toFixed(4) : null,
    generationJobId: input.generationJobId ?? null,
    generatedCreativeId: input.generatedCreativeId ?? null,
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
    } else if (typeof v === 'string' && v.length > 4096) {
      // Large string fields (base64 video frames, generated image data)
      // get truncated so the audit log isn't bloated.
      out[k] = `[TRUNCATED ${v.length} chars]`;
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
