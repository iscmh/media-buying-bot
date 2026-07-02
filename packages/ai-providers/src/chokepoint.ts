import { logAiProviderApiCall } from '@mbb/db';

/**
 * Single chokepoint for every Phase 3b AI provider HTTP call. Same pattern
 * as Phase 1's `callMeta()` — direct fetch goes through here so logging,
 * timeouts, and error sanitization happen in one place.
 *
 * Responsibilities:
 *   1. Timeout enforcement via AbortController (caller passes per-provider
 *      duration; defaults supplied by provider clients).
 *   2. Audit log every call to ai_provider_api_call_logs, success or fail.
 *   3. Sanitized error reporting (no API keys leak into logs / UI).
 *   4. JSON parse with graceful fallback (some providers return text/event
 *      streams or plaintext error bodies).
 *
 * Caller is responsible for:
 *   - Building the request URL + headers + body
 *   - Computing `cost_usd` from the response body (we just persist what
 *     they pass)
 *   - Linking to the generation_job + variant the call belongs to
 *
 * Always returns a result — never throws — so generation jobs can collect
 * partial successes without crashing the whole function.
 */

// Polish-20 Commit 4: elevenlabs removed with the legacy pipelines
// that used it. The 'kling' name is retained because it's the label
// under which the Replicate BYOK key is stored (tool_connections
// records) — the shared Replicate helpers (concat / lipsync / audio-
// trim / frame-extract) still tag their chokepoint audit rows with
// it. Do NOT rename this without a schema migration.
export type ProviderName =
  | 'gemini'
  | 'claude'
  | 'kie_ai'
  | 'heygen'
  | 'arcads'
  | 'creatify'
  | 'kling'
  | 'replicate'
  | 'openai'
  // Polish-21: Hedra Character 3 image-to-talking-avatar.
  | 'hedra';

export interface CallProviderInput {
  userId: string;
  provider: ProviderName;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
  /** Timeout in ms. Provider clients pass sensible defaults; caller can override per call. */
  timeoutMs: number;
  /** Sanitized version of body for audit log. Caller strips secrets here. */
  requestBodyForLog?: Record<string, unknown>;
  /** Optional foreign keys for cost rollup queries. */
  generationJobId?: string;
  generatedCreativeId?: string;
}

export type CallProviderResult<T> =
  | {
      ok: true;
      status: number;
      latencyMs: number;
      data: T;
      rawBody: unknown;
    }
  | {
      ok: false;
      status: number;
      latencyMs: number;
      errorMessage: string;
      rawBody: unknown;
      reason: 'timeout' | 'network' | 'http_error' | 'parse_error';
    };

export async function callProvider<T>(input: CallProviderInput): Promise<CallProviderResult<T>> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  let status = 0;
  let rawBody: unknown = null;
  let parseError: string | null = null;

  try {
    const res = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body == null ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    status = res.status;

    // Try JSON first (most providers); fall back to text on parse error.
    const text = await res.text();
    if (text) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        rawBody = { _non_json_body: text.slice(0, 4096) };
        parseError = 'response was not JSON';
      }
    }

    const latencyMs = Date.now() - t0;
    const ok = status >= 200 && status < 300 && !parseError;

    // Always log, success or fail.
    await logCall(input, status, rawBody, latencyMs);

    if (!ok) {
      return {
        ok: false,
        status,
        latencyMs,
        errorMessage: extractErrorMessage(rawBody) ?? `HTTP ${status}`,
        rawBody,
        reason: parseError ? 'parse_error' : 'http_error',
      };
    }

    return {
      ok: true,
      status,
      latencyMs,
      data: rawBody as T,
      rawBody,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const reason: 'timeout' | 'network' = isAbort ? 'timeout' : 'network';
    const errorMessage = isAbort
      ? `Provider call timed out after ${input.timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);

    await logCall(input, status, { _error: errorMessage, _reason: reason }, latencyMs);

    return {
      ok: false,
      status,
      latencyMs,
      errorMessage,
      rawBody: { _error: errorMessage },
      reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function logCall(
  input: CallProviderInput,
  status: number,
  rawBody: unknown,
  latencyMs: number,
): Promise<void> {
  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: input.provider,
      endpoint: input.url,
      method: input.method,
      requestBody: input.requestBodyForLog ?? {},
      responseStatus: status,
      responseBody: rawBody,
      latencyMs,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
    });
  } catch {
    // Don't let a logging failure crash the calling job. Phase 3b accepts
    // missed audit rows under DB outage; production would want a retry
    // queue here, but it's not worth the complexity for Phase 3b's
    // founding-member scale.
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  // Anthropic format: { error: { message } }
  if (obj.error && typeof obj.error === 'object') {
    const msg = (obj.error as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  // Gemini format: { error: { code, message } } at top level
  if (typeof obj.message === 'string') return obj.message;
  // Kie.ai/HeyGen often surface { msg } or { errorMessage }
  if (typeof obj.msg === 'string') return obj.msg;
  if (typeof obj.errorMessage === 'string') return obj.errorMessage;
  return null;
}
