/**
 * Polish-4: ElevenLabs text-to-speech client. Paired with Kling video
 * to produce the cinematic_voiceover creative format — Kling generates
 * the visuals, ElevenLabs generates the voiceover audio.
 *
 * The serverless ffmpeg path is brittle on Vercel functions, so the
 * pipeline stores audio + video as separate URLs on the variant's
 * generationMetadata. The job-review UI plays them together; Meta
 * ads ingestion currently uploads video-only (audio-on-video muxing
 * is the deferred ffmpeg path).
 *
 * Auth: `xi-api-key` header (ElevenLabs convention).
 *
 * ELEVENLABS_DEFAULT_VOICE_ID env override picks the default voice
 * when the caller doesn't specify one. Sensible default: 'Rachel'
 * (21m00Tcm4TlvDq8ikWAM), the most popular voice in ElevenLabs' free
 * tier.
 */

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const SUBMIT_TIMEOUT_MS = 60_000;
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export function getDefaultElevenLabsVoiceId(): string {
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
}

/**
 * ElevenLabs charges per character. List price as of May 2026:
 *   - Free / Starter: 30k chars/mo
 *   - Pro: $0.30 / 1k chars (≈$0.005-0.02 per ad-length script)
 *
 * The variant cost estimator surfaces this to the user before submit.
 */
const ELEVENLABS_USD_PER_1K_CHARS = 0.3;

export function estimateElevenLabsCostUsd(scriptChars: number): number {
  return (scriptChars / 1000) * ELEVENLABS_USD_PER_1K_CHARS;
}

export interface ElevenLabsTtsInput {
  userId: string;
  apiKey: string;
  text: string;
  /** ElevenLabs voice id. Falls back to ELEVENLABS_DEFAULT_VOICE_ID. */
  voiceId?: string;
  /** Model id; defaults to ElevenLabs' multilingual model. */
  modelId?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface ElevenLabsTtsResult {
  ok: boolean;
  /** Base64-encoded MP3 — caller uploads to storage and persists the URL. */
  audioBase64?: string;
  contentType?: string;
  costUsd: number;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Synth a single voiceover. Returns base64 audio so the caller can
 * push it to whatever bucket they like — keeps this client storage-
 * agnostic.
 *
 * The chokepoint expects JSON responses, but TTS returns audio/mpeg.
 * We call fetch directly here for the body bytes (still logged via
 * logAiProviderApiCall manually).
 */
export async function submitElevenLabsTts(input: ElevenLabsTtsInput): Promise<ElevenLabsTtsResult> {
  const voiceId = input.voiceId?.trim() || getDefaultElevenLabsVoiceId();
  const modelId = input.modelId?.trim() || 'eleven_multilingual_v2';
  const url = `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const body = {
    text: input.text,
    model_id: modelId,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  };

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
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
    const latencyMs = Date.now() - t0;
    if (res.status < 200 || res.status >= 300) {
      const errorBody = await res.text().catch(() => '');
      const errorMessage = errorBody.slice(0, 512) || `HTTP ${res.status}`;
      // Manual log: chokepoint assumed JSON; this endpoint returns audio.
      await logTtsCall({
        userId: input.userId,
        url,
        status: res.status,
        body: { _error: errorMessage },
        latencyMs,
        generationJobId: input.generationJobId,
        generatedCreativeId: input.generatedCreativeId,
        scriptChars: input.text.length,
      });
      return {
        ok: false,
        costUsd: 0,
        latencyMs,
        httpStatus: res.status,
        errorMessage,
      };
    }

    const arrayBuf = await res.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuf).toString('base64');
    const costUsd = estimateElevenLabsCostUsd(input.text.length);

    await logTtsCall({
      userId: input.userId,
      url,
      status: res.status,
      body: { _audio_bytes: arrayBuf.byteLength, _voice_id: voiceId, _model_id: modelId },
      latencyMs,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
      scriptChars: input.text.length,
      costUsd,
    });

    return {
      ok: true,
      audioBase64,
      contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      costUsd,
      latencyMs,
      httpStatus: res.status,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const errorMessage = isAbort
      ? `ElevenLabs TTS timed out after ${SUBMIT_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    await logTtsCall({
      userId: input.userId,
      url,
      status: 0,
      body: { _error: errorMessage },
      latencyMs,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
      scriptChars: input.text.length,
    });
    return {
      ok: false,
      costUsd: 0,
      latencyMs,
      httpStatus: 0,
      errorMessage,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function logTtsCall(input: {
  userId: string;
  url: string;
  status: number;
  body: unknown;
  latencyMs: number;
  scriptChars: number;
  costUsd?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}): Promise<void> {
  // Inline import to avoid a top-level @mbb/db import in tests that
  // mock the chokepoint but not the logger.
  const { logAiProviderApiCall } = await import('@mbb/db');
  try {
    await logAiProviderApiCall({
      userId: input.userId,
      provider: 'elevenlabs',
      endpoint: input.url,
      method: 'POST',
      requestBody: { script_chars: input.scriptChars },
      responseStatus: input.status,
      responseBody: input.body,
      latencyMs: input.latencyMs,
      costUsd: input.costUsd,
      generationJobId: input.generationJobId,
      generatedCreativeId: input.generatedCreativeId,
    });
  } catch {
    // never crash the job because logging failed
  }
}

/**
 * Per-variant TTS cost — pure helper for the form picker. The script
 * arrives from the generation request; we charge ElevenLabs by char,
 * so the estimate is deterministic.
 */
export function estimateVoiceoverVariantCostUsd(scriptChars: number): number {
  return estimateElevenLabsCostUsd(scriptChars);
}
