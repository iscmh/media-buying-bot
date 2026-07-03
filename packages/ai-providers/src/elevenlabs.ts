import { Buffer } from 'node:buffer';
import { logAiProviderApiCall } from '@mbb/db';
import type { AIProviderName, VerifyKeyResult } from '@mbb/shared';
import type { AIProvider } from './types';

/**
 * Polish-21.0.4 hotfix: ElevenLabs Text-to-Speech BYOK client.
 *
 * Replaces Hedra's native TTS in the Polish-21 Character 3 pipeline.
 * The Polish-21.0.1-.0.3 attempts to use Hedra's built-in voices
 * failed on real accounts — Hedra's `voice_asset f412c62f-...
 * not found` at submit time — because the built-in voice UUIDs
 * published in hedra-labs/hedra-api-starter aren't accessible on
 * regular Creator plans. Rather than block on Hedra support, we
 * generate audio via ElevenLabs BYOK and hand the mp3 to Hedra as
 * an audio_id asset. Better long-term architecture:
 *   - user controls voice choice via their ElevenLabs library
 *   - no Hedra voice-UUID dependency
 *   - clean path to source-voice-cloning in Polish-22 (analyze
 *     source audio → ElevenLabs Instant Voice Clone → use that
 *     voice for all variants)
 *
 * Endpoint contract (verified against elevenlabs.io/docs and the
 * elevenlabs-python starter):
 *
 *   Base URL : https://api.elevenlabs.io
 *   Auth     : xi-api-key: <API_KEY>  (LOWERCASE header)
 *   TTS      : POST /v1/text-to-speech/{voice_id}
 *              body: {text, model_id, voice_settings: {...}}
 *              returns: audio/mpeg binary
 *   Verify   : GET  /v1/user  (cheapest authenticated read)
 *
 * Design decisions:
 *   - Binary response BYPASSES chokepoint (which JSON.stringifies +
 *     JSON.parses the body). We call fetch() directly and log
 *     manually via logAiProviderApiCall so audit coverage stays
 *     intact.
 *   - Model id defaults to `eleven_multilingual_v2` (most balanced
 *     quality + latency at the price tier the operator's on).
 *   - Voice settings match the ElevenLabs "conversational" preset
 *     that pairs well with confessional UGC ad copy.
 */

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const TTS_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 15_000;

export interface ElevenLabsTtsInput {
  userId: string;
  apiKey: string;
  voiceId: string;
  text: string;
  /** Defaults to `eleven_multilingual_v2`. */
  modelId?: string;
  /**
   * Voice settings. Defaults to conversational-UGC preset:
   * stability 0.5, similarity_boost 0.75.
   */
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface ElevenLabsTtsResult {
  ok: boolean;
  /** MP3 bytes. Undefined on failure. */
  audio?: Uint8Array;
  /** Response Content-Type (usually 'audio/mpeg'). */
  contentType?: string;
  latencyMs: number;
  errorMessage?: string;
  status?: number;
}

/**
 * Polish-21.0.4: preset for confessional UGC ad copy. The
 * ElevenLabs Multilingual v2 sits stable here for the ranges of
 * emotion the Polish-19.4.2 verbatim source-script preservation
 * produces (hook openers + product/offer phrases).
 */
export const ELEVENLABS_UGC_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
} as const;

/**
 * Redacts the ElevenLabs key to first-4 + trailing-4 for logs so
 * audit rows are safe to paste into support tickets. Mirrors the
 * Polish-21.0.2 redactHedraApiKey helper.
 */
export function redactElevenLabsApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 12) return 'xi-api-key:(short-key)';
  return `xi-api-key:${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export function logElevenLabsRequest(
  kind: string,
  method: string,
  url: string,
  apiKey: string,
  body: unknown,
): void {
  const bodyStr = body == null ? '(no body)' : JSON.stringify(body).slice(0, 3000);
  console.log(
    `[elevenlabs] ${kind} REQUEST: ${method} ${url} ` +
      `auth=${redactElevenLabsApiKey(apiKey)} body=${bodyStr}`,
  );
}

export function logElevenLabsResponse(
  kind: string,
  method: string,
  url: string,
  status: number,
  bytes: number,
  errorBody?: unknown,
): void {
  const suffix = errorBody != null ? ` error=${JSON.stringify(errorBody).slice(0, 2000)}` : '';
  console.log(
    `[elevenlabs] ${kind} RESPONSE: ${method} ${url} → ${status} bytes=${bytes}${suffix}`,
  );
}

// -------------------------------------------------------------------
// TTS — POST /v1/text-to-speech/{voice_id}
// -------------------------------------------------------------------

export async function submitElevenLabsTts(input: ElevenLabsTtsInput): Promise<ElevenLabsTtsResult> {
  const t0 = Date.now();
  const url = `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`;
  const body = {
    text: input.text,
    model_id: input.modelId ?? ELEVENLABS_DEFAULT_MODEL_ID,
    voice_settings: {
      ...ELEVENLABS_UGC_VOICE_SETTINGS,
      ...(input.voiceSettings ?? {}),
    },
  };
  logElevenLabsRequest('tts', 'POST', url, input.apiKey, {
    voice_id: input.voiceId,
    model_id: body.model_id,
    text_chars: input.text.length,
    voice_settings: body.voice_settings,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  let status = 0;
  let audio: Uint8Array | undefined;
  let contentType: string | undefined;
  let errorMessage: string | undefined;
  let errorBodyForLog: unknown = undefined;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': input.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    status = res.status;
    contentType = res.headers.get('content-type') ?? undefined;
    if (status >= 200 && status < 300) {
      const buf = await res.arrayBuffer();
      audio = new Uint8Array(buf);
    } else {
      // ElevenLabs returns JSON errors on the same request path when
      // the request fails (401 invalid key, 402 out of credits,
      // 422 validation, etc). Capture the JSON body for the audit
      // log and error surface.
      const text = await res.text();
      try {
        errorBodyForLog = text ? JSON.parse(text) : undefined;
      } catch {
        errorBodyForLog = { _non_json_body: text.slice(0, 2000) };
      }
      errorMessage = translateElevenLabsErrorStatus(
        status,
        extractElevenLabsErrorMessage(errorBodyForLog),
      );
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `ElevenLabs TTS timed out after ${TTS_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    errorBodyForLog = { _error: errorMessage };
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  logElevenLabsResponse('tts', 'POST', url, status, audio?.byteLength ?? 0, errorBodyForLog);

  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: 'elevenlabs',
      endpoint: url,
      method: 'POST',
      requestBody: {
        voice_id: input.voiceId,
        model_id: body.model_id,
        text_chars: input.text.length,
        voice_settings: body.voice_settings,
      },
      responseStatus: status,
      responseBody: errorBodyForLog ?? { audio_bytes: audio?.byteLength ?? 0 },
      latencyMs,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
    });
  } catch {
    // See chokepoint rationale: audit-log failures don't crash the
    // caller.
  }

  if (errorMessage) return { ok: false, latencyMs, errorMessage, status };
  if (!audio) {
    return {
      ok: false,
      latencyMs,
      errorMessage: 'ElevenLabs TTS returned no audio bytes',
      status,
    };
  }
  return { ok: true, audio, contentType, latencyMs, status };
}

// -------------------------------------------------------------------
// Verify — GET /v1/user
// -------------------------------------------------------------------

export async function verifyElevenLabsKey(
  apiKey: string,
): Promise<
  | { ok: true; method: 'api'; statusCode: number }
  | { ok: false; method: 'api'; reason: string; statusCode?: number }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/user`, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      signal: controller.signal,
    });
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, method: 'api', statusCode: status };
    let msg = `ElevenLabs rejected the key (HTTP ${status})`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      const extracted = extractElevenLabsErrorMessage(body);
      if (extracted) msg = extracted;
    } catch {
      // fall through
    }
    return { ok: false, method: 'api', reason: msg, statusCode: status };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const msg = isAbort
      ? `ElevenLabs verify timed out after ${VERIFY_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, method: 'api', reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------
// Error translation
// -------------------------------------------------------------------

export function translateElevenLabsErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `ElevenLabs validation failed${fallback ? `: ${fallback}` : ' (check inputs)'}.`;
  if (status === 401)
    return 'ElevenLabs authentication failed. Re-paste your key at /connections/ai-provider.';
  if (status === 402)
    return 'Insufficient ElevenLabs credits. Top up at elevenlabs.io/app/settings/billing.';
  if (status === 403)
    return 'ElevenLabs forbidden — the API key may lack TTS access. Check your ElevenLabs plan.';
  if (status === 404)
    return `ElevenLabs voice_id not found — the voice may have been deleted or is not on this account plan${fallback ? ` (${fallback})` : ''}.`;
  if (status === 422)
    return `ElevenLabs parameter validation failed${fallback ? `: ${fallback}` : ''}.`;
  if (status === 429) return 'ElevenLabs rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `ElevenLabs upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `ElevenLabs request failed${status ? ` (status ${status})` : ''}.`;
}

export function extractElevenLabsErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  if (typeof obj['detail'] === 'string') return obj['detail'];
  // ElevenLabs sometimes wraps in {detail: {status, message}}
  const detail = obj['detail'];
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    if (typeof d['message'] === 'string') return d['message'];
    if (typeof d['status'] === 'string') return d['status'];
  }
  if (typeof obj['message'] === 'string') return obj['message'];
  if (typeof obj['error'] === 'string') return obj['error'];
  return undefined;
}

// -------------------------------------------------------------------
// AIProvider adapter for the BYOK connect UI
// -------------------------------------------------------------------

export class ElevenLabsProvider implements AIProvider {
  readonly name: AIProviderName = 'elevenlabs';

  async verifyKey(apiKey: string): Promise<VerifyKeyResult> {
    return verifyElevenLabsKey(apiKey);
  }

  async generateVariants(): Promise<never> {
    throw new Error(
      'ElevenLabsProvider.generateVariants is not used — the Polish-21 video-variant worker ' +
        'calls submitElevenLabsTts directly.',
    );
  }
}

/** Buffer helper — Uint8Array → Buffer without extra copy. */
export function bytesToBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
