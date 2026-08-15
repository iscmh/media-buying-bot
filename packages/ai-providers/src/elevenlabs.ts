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
    return (
      'ElevenLabs authentication failed. Re-paste your key at /connections/ai-provider.' +
      (fallback ? ` ElevenLabs said: ${fallback}` : '')
    );
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

// -------------------------------------------------------------------
// Polish-28.0.0 Commit 64: Instant Voice Clone (IVC)
// -------------------------------------------------------------------
//
// Endpoint (verified via elevenlabs.io/docs 2026):
//   POST https://api.elevenlabs.io/v1/voices/add
//   Auth : xi-api-key: <key>
//   Body : multipart/form-data
//     - name (str, required)
//     - files (one or more audio blobs, required)
//     - description (str, optional)
//     - labels (JSON string, optional)
//     - remove_background_noise (bool, optional)
//   Response 200: { voice_id: string, requires_verification: false }
//
// IVC is FREE to create — no character credits consumed at creation
// time. Slots are the hard cap: Starter 10 / Creator 30 / Pro 160 /
// Scale 660 / Business 1660. Slots are lifetime holdings; deleting a
// voice frees the slot immediately. Polish-28 uses one temp voice
// per generation + deletes it in the cleanup step (with a daily
// orphan-reaper cron as backstop).
//
// Sample requirements: ≥1 min of clean speech; 1-2 min sweet spot.
// Source ads shorter than 60s are LOOPED by extract-source-audio.ts
// before submission (Polish-28 spec).

const IVC_TIMEOUT_MS = 45_000;
const DELETE_VOICE_TIMEOUT_MS = 15_000;

/**
 * Polish-28.0.0 Commit 64: name prefix for temp voices created by the
 * Polish-28 worker. The daily orphaned-voice reaper cron uses this
 * prefix to identify + delete voices that outlived their generation
 * job (i.e. cleanup step didn't fire cleanly).
 */
export const POLISH28_TEMP_VOICE_NAME_PREFIX = 'polish28_temp_';

export interface CreateInstantVoiceCloneInput {
  userId: string;
  apiKey: string;
  /**
   * Voice name. Should start with POLISH28_TEMP_VOICE_NAME_PREFIX so
   * the orphan reaper can identify it. Downstream `deleteElevenLabsVoice`
   * cleanup happens after successful generation.
   */
  name: string;
  /**
   * The source ad's audio bytes (after ffmpeg extraction + loop
   * mitigation). ElevenLabs accepts MP3 / WAV / FLAC / M4A / OGG /
   * WebM. ≤10 MB per file, ≤25 files per clone.
   */
  audioBytes: Uint8Array;
  audioMimeType: string;
  /** Suggested filename for the multipart part (e.g. 'source.mp3'). */
  audioFilename: string;
  description?: string;
  removeBackgroundNoise?: boolean;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface CreateInstantVoiceCloneResult {
  ok: boolean;
  voiceId?: string;
  latencyMs: number;
  status?: number;
  errorMessage?: string;
  /** True when ElevenLabs flagged the voice as needing manual verification
   *  (never expected for IVC — PVC only — but surfaced for forensics). */
  requiresVerification?: boolean;
}

/**
 * Create an Instant Voice Clone. Multipart upload of the source-ad
 * audio bytes; returns a voice_id ready for immediate TTS use.
 *
 * Cost: FREE at creation (only a slot is consumed). Slot pressure is
 * the real constraint — the caller MUST call deleteElevenLabsVoice
 * after use (or the reaper will collect it within 24h).
 */
export async function createInstantVoiceClone(
  input: CreateInstantVoiceCloneInput,
): Promise<CreateInstantVoiceCloneResult> {
  const t0 = Date.now();
  const url = `${ELEVENLABS_BASE}/v1/voices/add`;

  const form = new FormData();
  form.append('name', input.name);
  // Copy the Uint8Array bytes into a fresh ArrayBuffer so Blob's
  // BlobPart typing accepts it (Buffer's SharedArrayBuffer-tagged
  // backing store fails the ArrayBuffer constraint in TS strict).
  const audioCopy = new Uint8Array(input.audioBytes.byteLength);
  audioCopy.set(input.audioBytes);
  const blob = new Blob([audioCopy], { type: input.audioMimeType });
  form.append('files', blob, input.audioFilename);
  if (input.description) form.append('description', input.description);
  if (input.removeBackgroundNoise) form.append('remove_background_noise', 'true');

  logElevenLabsRequest('ivc-create', 'POST', url, input.apiKey, {
    name: input.name,
    audio_bytes: input.audioBytes.byteLength,
    audio_mime: input.audioMimeType,
    audio_filename: input.audioFilename,
    remove_background_noise: input.removeBackgroundNoise ?? false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IVC_TIMEOUT_MS);
  let status = 0;
  let errorMessage: string | undefined;
  let voiceId: string | undefined;
  let requiresVerification: boolean | undefined;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        // NOTE: do NOT set content-type — fetch will set the correct
        // multipart boundary automatically when body is FormData.
        'xi-api-key': input.apiKey,
        accept: 'application/json',
      },
      body: form,
      signal: controller.signal,
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      const body = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
      voiceId = typeof body.voice_id === 'string' ? body.voice_id : undefined;
      requiresVerification = body.requires_verification === true;
      if (!voiceId) {
        errorMessage = `ElevenLabs IVC-create response missing voice_id: ${JSON.stringify(body).slice(0, 400)}`;
      }
    } else {
      let errBody: unknown = undefined;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      const detail = extractElevenLabsErrorMessage(errBody) ?? undefined;
      errorMessage = translateElevenLabsErrorStatus(status, detail);
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `ElevenLabs IVC-create timed out after ${IVC_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  logElevenLabsResponse('ivc-create', 'POST', url, status, 0, errorMessage);
  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: 'elevenlabs' as AIProviderName,
      endpoint: 'POST /v1/voices/add',
      method: 'POST',
      responseStatus: status,
      latencyMs,
      requestBody: {
        purpose: 'polish28_ivc_create',
        name: input.name,
        audio_bytes: input.audioBytes.byteLength,
      },
      ...(errorMessage ? { errorMessage } : {}),
      ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
      ...(input.generatedCreativeId ? { generatedCreativeId: input.generatedCreativeId } : {}),
    });
  } catch (logErr) {
    console.error('[elevenlabs] IVC-create audit log failed:', logErr);
  }

  if (voiceId) {
    return {
      ok: true,
      voiceId,
      latencyMs,
      status,
      ...(requiresVerification !== undefined ? { requiresVerification } : {}),
    };
  }
  return {
    ok: false,
    latencyMs,
    status,
    errorMessage: errorMessage ?? 'ElevenLabs IVC-create failed with no error message.',
  };
}

// -------------------------------------------------------------------
// Delete voice — DELETE /v1/voices/{voice_id}
// -------------------------------------------------------------------

export interface DeleteElevenLabsVoiceInput {
  userId: string;
  apiKey: string;
  voiceId: string;
  generationJobId?: string;
}

export interface DeleteElevenLabsVoiceResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  errorMessage?: string;
}

/**
 * DELETE /v1/voices/{voice_id}. Frees a voice slot immediately.
 * Used by the Polish-28 worker's cleanup step (post-generation) and
 * the daily orphaned-voice reaper cron (backstop).
 *
 * Idempotent: a 404 on delete is treated as success (voice already
 * gone — nothing to clean up). Any other non-2xx is surfaced.
 */
export async function deleteElevenLabsVoice(
  input: DeleteElevenLabsVoiceInput,
): Promise<DeleteElevenLabsVoiceResult> {
  const t0 = Date.now();
  const url = `${ELEVENLABS_BASE}/v1/voices/${encodeURIComponent(input.voiceId)}`;
  logElevenLabsRequest('voice-delete', 'DELETE', url, input.apiKey, { voice_id: input.voiceId });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELETE_VOICE_TIMEOUT_MS);
  let status = 0;
  let errorMessage: string | undefined;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'xi-api-key': input.apiKey, accept: 'application/json' },
      signal: controller.signal,
    });
    status = res.status;
    if (status === 404) {
      // Idempotent — voice already gone.
      return { ok: true, latencyMs: Date.now() - t0, status };
    }
    if (status < 200 || status >= 300) {
      let errBody: unknown = undefined;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      errorMessage = translateElevenLabsErrorStatus(
        status,
        extractElevenLabsErrorMessage(errBody) ?? undefined,
      );
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    errorMessage = isAbort
      ? `ElevenLabs voice-delete timed out after ${DELETE_VOICE_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - t0;
  logElevenLabsResponse('voice-delete', 'DELETE', url, status, 0, errorMessage);
  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: 'elevenlabs' as AIProviderName,
      endpoint: 'DELETE /v1/voices/{id}',
      method: 'DELETE',
      responseStatus: status,
      latencyMs,
      requestBody: { purpose: 'polish28_ivc_delete', voice_id: input.voiceId },
      ...(errorMessage ? { errorMessage } : {}),
      ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    });
  } catch (logErr) {
    console.error('[elevenlabs] voice-delete audit log failed:', logErr);
  }

  return {
    ok: !errorMessage,
    latencyMs,
    status,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

// -------------------------------------------------------------------
// List voices — GET /v1/voices  (used by the orphan-reaper cron)
// -------------------------------------------------------------------

export interface ListElevenLabsVoicesInput {
  userId: string;
  apiKey: string;
}

export interface ListedElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  /** Milliseconds since epoch when the voice was created. Present on
   *  cloned voices; may be missing on stock voices. */
  created_at_unix?: number;
}

export interface ListElevenLabsVoicesResult {
  ok: boolean;
  voices: ListedElevenLabsVoice[];
  latencyMs: number;
  status?: number;
  errorMessage?: string;
}

/**
 * List all voices on the account. Used by the Polish-28 daily
 * orphan-reaper to find polish28_temp_ voices older than 24h.
 */
export async function listElevenLabsVoices(
  input: ListElevenLabsVoicesInput,
): Promise<ListElevenLabsVoicesResult> {
  const t0 = Date.now();
  const url = `${ELEVENLABS_BASE}/v1/voices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let status = 0;
  let voices: ListedElevenLabsVoice[] = [];
  let errorMessage: string | undefined;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'xi-api-key': input.apiKey, accept: 'application/json' },
      signal: controller.signal,
    });
    status = res.status;
    if (status >= 200 && status < 300) {
      const body = (await res.json()) as { voices?: ListedElevenLabsVoice[] };
      voices = Array.isArray(body.voices) ? body.voices : [];
    } else {
      let errBody: unknown = undefined;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      errorMessage = translateElevenLabsErrorStatus(
        status,
        extractElevenLabsErrorMessage(errBody) ?? undefined,
      );
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  return {
    ok: !errorMessage,
    voices,
    latencyMs,
    status,
    ...(errorMessage ? { errorMessage } : {}),
  };
}
