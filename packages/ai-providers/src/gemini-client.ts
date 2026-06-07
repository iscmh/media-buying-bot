import { computeGeminiImageCost, computeGeminiTextCost } from '@mbb/shared';
import { callProvider, type CallProviderResult } from './chokepoint';

/**
 * Gemini 2.5 Flash + 2.5 Flash Image (a.k.a. nano-banana) clients.
 *
 * Endpoints (verified against Google's public API docs, May 2025):
 *   - Vision/text:  POST .../models/gemini-2.5-flash:generateContent
 *   - Image gen:    POST .../models/gemini-2.5-flash-image:generateContent
 *   - Files API:    POST /upload/v1beta/files?uploadType=multipart
 *                   GET  /v1beta/files/{name}      (poll state)
 *                   DELETE /v1beta/files/{name}    (cleanup)
 *
 * Auth: `x-goog-api-key` header. NEVER pass via query string — leaks to logs.
 *
 * Phase 3h: video routing.
 *   - <= 20 MB → inline base64 path (faster, no upload step)
 *   - 20 MB–2 GB → Files API path (upload, poll until ACTIVE, reference
 *                  by uri in generateContent, delete on cleanup)
 *   - > 2 GB → fail-fast with "Video too large, max 2GB"
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';
const VISION_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image';

// Polish-9.6: env-overridable. IMAGE_TIMEOUT_MS bumped 30→90s — Nano
// Banana image gen for the Kling pipeline routinely runs 30-60s; 30s
// fired before the response landed. VISION_TIMEOUT_MS stays at 60s
// (one-shot analysis call, not on the multi-clip hot path).
const VISION_TIMEOUT_MS = Number(process.env.GEMINI_API_TIMEOUT_MS) || 60_000;
const IMAGE_TIMEOUT_MS = Number(process.env.GEMINI_IMAGE_TIMEOUT_MS) || 90_000;
const UPLOAD_TIMEOUT_MS = 180_000; // big videos can take a while

/** 20 MB — Google's documented inline cap for generateContent. */
const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
/** 2 GB — Files API documented per-file maximum. */
const FILES_API_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Poll cadence for file state. ACTIVE usually reached in 5-30s. */
const FILE_POLL_INTERVAL_MS = 1_500;
const FILE_POLL_TIMEOUT_MS = 120_000;

interface GeminiContent {
  role?: 'user' | 'model';
  parts: Array<
    | { text: string }
    | { inline_data: { mime_type: string; data: string } }
    | { inlineData: { mimeType: string; data: string } } // some SDK responses use camelCase
    | { file_data: { mime_type: string; file_uri: string } }
  >;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiVisionInput {
  userId: string;
  apiKey: string;
  systemPrompt: string;
  videoBase64: string;
  videoMimeType: string;
  generationJobId?: string;
}

export interface GeminiVisionResult {
  ok: boolean;
  /** Parsed JSON if Gemini followed the system prompt's "ONLY JSON" rule. */
  json?: unknown;
  rawText?: string;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Phase 3h: routes the call by source-video size.
 *   - <= 20 MB binary → inline base64 (single generateContent call)
 *   - 20 MB–2 GB → Gemini Files API (upload, poll, generateContent
 *     referencing the file uri, then delete the file)
 *   - > 2 GB → fail fast
 *
 * Same input/output contract as Phase 3b — caller still passes
 * videoBase64. We estimate binary size from the base64 length
 * (binary = chars * 3 / 4, ±2 bytes for padding).
 */
export async function callGeminiVision(input: GeminiVisionInput): Promise<GeminiVisionResult> {
  const binarySize = Math.floor((input.videoBase64.length * 3) / 4);

  if (binarySize > FILES_API_MAX_BYTES) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: 0,
      errorMessage: `Video too large (${Math.round(binarySize / (1024 * 1024))} MB). Maximum supported is 2 GB.`,
    };
  }

  if (binarySize <= INLINE_LIMIT_BYTES) {
    return callGeminiVisionInline(input);
  }

  return callGeminiVisionViaFiles(input);
}

/** Path 1: inline base64 (≤ 20 MB). The original Phase 3b implementation. */
async function callGeminiVisionInline(input: GeminiVisionInput): Promise<GeminiVisionResult> {
  const url = `${GEMINI_BASE}/models/${VISION_MODEL}:generateContent`;
  const body = buildVisionBody(input.systemPrompt, [
    {
      inline_data: {
        mime_type: input.videoMimeType,
        data: input.videoBase64,
      },
    },
  ]);

  const result: CallProviderResult<GeminiResponse> = await callProvider<GeminiResponse>({
    userId: input.userId,
    provider: 'gemini',
    url,
    method: 'POST',
    headers: {
      'x-goog-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: VISION_TIMEOUT_MS,
    // Don't log the base64 video; just shape + system prompt size for debug.
    requestBodyForLog: {
      model: VISION_MODEL,
      system_prompt_chars: input.systemPrompt.length,
      video_mime: input.videoMimeType,
      video_base64_size_chars: input.videoBase64.length,
      path: 'inline',
    },
    generationJobId: input.generationJobId,
  });

  return interpretVisionResponse(result);
}

/**
 * Path 2: Files API (> 20 MB). Upload → poll until ACTIVE → generateContent
 * referencing the file uri → DELETE the file (best-effort cleanup, runs even
 * if generateContent errors).
 */
async function callGeminiVisionViaFiles(input: GeminiVisionInput): Promise<GeminiVisionResult> {
  const buffer = Buffer.from(input.videoBase64, 'base64');

  const upload = await uploadGeminiFile({
    userId: input.userId,
    apiKey: input.apiKey,
    fileBuffer: buffer,
    mimeType: input.videoMimeType,
    generationJobId: input.generationJobId,
  });
  if (!upload.ok || !upload.fileName || !upload.fileUri) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: 0,
      errorMessage: `Gemini Files upload failed: ${upload.errorMessage ?? 'unknown error'}. Try compressing the video under 100 MB.`,
    };
  }

  const fileName = upload.fileName;
  const fileUri = upload.fileUri;

  try {
    const ready = await pollGeminiFileReady({
      userId: input.userId,
      apiKey: input.apiKey,
      fileName,
      timeoutMs: FILE_POLL_TIMEOUT_MS,
    });
    if (!ready.ok) {
      return {
        ok: false,
        costUsd: 0,
        latencyMs: 0,
        errorMessage: ready.errorMessage ?? 'Gemini did not finish processing the video',
      };
    }

    const url = `${GEMINI_BASE}/models/${VISION_MODEL}:generateContent`;
    const body = buildVisionBody(input.systemPrompt, [
      { file_data: { mime_type: input.videoMimeType, file_uri: fileUri } },
    ]);
    const result = await callProvider<GeminiResponse>({
      userId: input.userId,
      provider: 'gemini',
      url,
      method: 'POST',
      headers: {
        'x-goog-api-key': input.apiKey,
        'content-type': 'application/json',
      },
      body,
      timeoutMs: VISION_TIMEOUT_MS,
      requestBodyForLog: {
        model: VISION_MODEL,
        system_prompt_chars: input.systemPrompt.length,
        video_mime: input.videoMimeType,
        file_name: fileName,
        path: 'files_api',
      },
      generationJobId: input.generationJobId,
    });
    return interpretVisionResponse(result);
  } finally {
    // Always attempt cleanup — Gemini Files quota is per-account and a leaked
    // file lingers for 48h. We don't block the response on the delete result.
    void deleteGeminiFile({
      userId: input.userId,
      apiKey: input.apiKey,
      fileName,
    }).catch(() => {
      // Silent — surfaced only via the audit log inside deleteGeminiFile.
    });
  }
}

function buildVisionBody(
  systemPrompt: string,
  videoPart:
    | Array<{ inline_data: { mime_type: string; data: string } }>
    | Array<{ file_data: { mime_type: string; file_uri: string } }>,
) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user' as const, parts: videoPart }],
    generationConfig: {
      temperature: 0.4,
      response_mime_type: 'application/json',
    },
  };
}

function interpretVisionResponse(result: CallProviderResult<GeminiResponse>): GeminiVisionResult {
  if (!result.ok) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const text = extractText(result.data);
  const usage = result.data.usageMetadata ?? {};
  const costUsd = computeGeminiTextCost(usage);

  if (!text) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: 'Gemini returned no text content',
    };
  }

  const parseResult = tryParseGeminiJson(text);
  if (!parseResult.ok) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      rawText: text,
      errorMessage: parseResult.error,
    };
  }

  return {
    ok: true,
    json: parseResult.value,
    rawText: text,
    costUsd,
    latencyMs: result.latencyMs,
  };
}

/**
 * Polish-9.11: Gemini ignores `response_mime_type: 'application/json'`
 * roughly 1 in 10 calls and returns the JSON wrapped in markdown
 * fences, prefixed with a preamble ("Here is the analysis: ..."), or
 * followed by a trailing politeness ("hope this helps"). The previous
 * naive JSON.parse() crashed analyze-concept with a generic "not
 * valid JSON" error and no diagnostic.
 *
 * Try strategies in order:
 *   1. strip ``` / ```json fences if present, then JSON.parse
 *   2. direct JSON.parse on the stripped text
 *   3. slice from first `{` to last `}` and parse
 *   4. slice from first `[` to last `]` (array root) and parse
 *
 * On all-fail, return the first 500 chars so the Inngest log shows
 * EXACTLY what Gemini emitted.
 */
export function tryParseGeminiJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let candidate = text.trim();

  const fenceMatch = candidate.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch && fenceMatch[1]) {
    candidate = fenceMatch[1].trim();
  }

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    // fall through
  }

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { ok: true, value: JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) };
    } catch {
      // fall through
    }
  }

  const firstBracket = candidate.indexOf('[');
  const lastBracket = candidate.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return { ok: true, value: JSON.parse(candidate.slice(firstBracket, lastBracket + 1)) };
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    error:
      `Gemini response was not parseable as JSON (tried direct, fenced, brace-bounded, ` +
      `bracket-bounded). First 500 chars: ${text.slice(0, 500)}`,
  };
}

// =========================================================================
// Phase 3h — Gemini Files API helpers (used internally + exported for tests).
// =========================================================================

export interface UploadGeminiFileInput {
  userId: string;
  apiKey: string;
  fileBuffer: Buffer;
  mimeType: string;
  displayName?: string;
  generationJobId?: string;
}

export interface UploadGeminiFileResult {
  ok: boolean;
  /** `files/abc123` — used for poll + delete. */
  fileName?: string;
  /** Full https URL — referenced in generateContent's file_data.file_uri. */
  fileUri?: string;
  errorMessage?: string;
}

/**
 * Upload a video to Gemini's Files API via a single multipart/related POST.
 * Caller must follow up with pollGeminiFileReady before referencing the
 * URI in generateContent (the file starts in PROCESSING state).
 *
 * Resumable upload would also work, but for files up to 2 GB the single
 * multipart request is simpler and saves a round-trip. Gemini's gateway
 * accepts up to ~256 MB inline; beyond that the resumable protocol is
 * required — left as a future improvement (TODO: bigger-than-256MB).
 */
export async function uploadGeminiFile(
  input: UploadGeminiFileInput,
): Promise<UploadGeminiFileResult> {
  const boundary = `mbb_boundary_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const metadata = JSON.stringify({
    file: { display_name: input.displayName ?? 'source_video' },
  });

  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${input.mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    input.fileBuffer,
    Buffer.from(tail, 'utf8'),
  ]);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEMINI_UPLOAD_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': input.apiKey,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      // Node's fetch accepts Buffer here; the BodyInit lib type is
      // browser-flavored (URLSearchParams etc.) and varies across
      // consumers' tsconfig lib settings — widen with an any cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: body as any,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: { file?: { name?: string; uri?: string }; error?: { message?: string } } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON — surface the raw body fragment as the error message below.
    }

    if (!res.ok) {
      return {
        ok: false,
        errorMessage: parsed.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const file = parsed.file;
    if (!file?.name || !file?.uri) {
      return { ok: false, errorMessage: 'Gemini Files response missing file.name / file.uri' };
    }
    return { ok: true, fileName: file.name, fileUri: file.uri };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, errorMessage: reason };
  } finally {
    clearTimeout(timeout);
  }
}

export interface PollGeminiFileInput {
  userId: string;
  apiKey: string;
  fileName: string;
  /** Defaults to 2 min — Gemini's documented ceiling for video processing. */
  timeoutMs?: number;
  generationJobId?: string;
}

export interface PollGeminiFileResult {
  ok: boolean;
  state?: 'ACTIVE' | 'PROCESSING' | 'FAILED';
  errorMessage?: string;
}

/**
 * Poll a Files API resource until it reaches ACTIVE (ready to reference)
 * or FAILED. Returns ok=false on timeout — caller treats as a soft error
 * and surfaces a "compress your video" message.
 */
export async function pollGeminiFileReady(
  input: PollGeminiFileInput,
): Promise<PollGeminiFileResult> {
  const deadline = Date.now() + (input.timeoutMs ?? FILE_POLL_TIMEOUT_MS);
  let lastState: string | undefined;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE}/${input.fileName}`, {
        headers: { 'x-goog-api-key': input.apiKey },
      });
    } catch (err) {
      return {
        ok: false,
        errorMessage: `Gemini Files poll failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!res.ok) {
      // 404 right after upload sometimes happens; keep polling. Other 4xx /
      // 5xx is fatal.
      if (res.status === 404 && Date.now() < deadline) {
        await sleep(FILE_POLL_INTERVAL_MS);
        continue;
      }
      return { ok: false, errorMessage: `Gemini Files poll HTTP ${res.status}` };
    }

    const data = (await res.json().catch(() => ({}))) as { state?: string };
    lastState = data.state;
    if (data.state === 'ACTIVE') {
      return { ok: true, state: 'ACTIVE' };
    }
    if (data.state === 'FAILED') {
      return {
        ok: false,
        state: 'FAILED',
        errorMessage: 'Gemini reported FAILED processing state',
      };
    }

    await sleep(FILE_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    state: lastState === 'ACTIVE' ? 'ACTIVE' : 'PROCESSING',
    errorMessage: `Gemini Files processing did not complete within ${(input.timeoutMs ?? FILE_POLL_TIMEOUT_MS) / 1000}s`,
  };
}

/** Best-effort cleanup. Failures are logged but never thrown. */
export async function deleteGeminiFile(input: {
  userId: string;
  apiKey: string;
  fileName: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  try {
    const res = await fetch(`${GEMINI_BASE}/${input.fileName}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': input.apiKey },
    });
    if (!res.ok && res.status !== 404) {
      return { ok: false, errorMessage: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GeminiImageInput {
  userId: string;
  apiKey: string;
  prompt: string;
  /**
   * Phase 3d: separate system instruction lets us frame the call as an
   * EDIT operation ("preserve reference style, replace text only") rather
   * than a free-form generation. Without this, nano-banana ignored the
   * reference image and invented unrelated scenes.
   */
  systemInstruction?: string;
  /** Reference image as base64 + mime; nano-banana uses it as a style reference. */
  referenceImageBase64?: string;
  referenceImageMimeType?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface GeminiImageResult {
  ok: boolean;
  /** Generated image as base64 (PNG). Caller writes to Supabase Storage. */
  imageBase64?: string;
  imageMimeType?: string;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Call Gemini Image (nano-banana) with a JSON prompt + optional reference
 * image. Returns base64 image data; caller uploads to Supabase Storage.
 */
export const GEMINI_IMAGE_TEMPERATURE = 0.4;

export async function callGeminiImage(input: GeminiImageInput): Promise<GeminiImageResult> {
  const url = `${GEMINI_BASE}/models/${IMAGE_MODEL}:generateContent`;
  // Order matters: put the reference image FIRST so the model anchors on
  // it as the thing to edit, then the text instructions referring to it.
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [];
  if (input.referenceImageBase64 && input.referenceImageMimeType) {
    parts.push({
      inline_data: {
        mime_type: input.referenceImageMimeType,
        data: input.referenceImageBase64,
      },
    });
  }
  parts.push({ text: input.prompt });

  const body: Record<string, unknown> = {
    contents: [{ role: 'user' as const, parts }],
    generationConfig: {
      // Phase 3d: down from default. We're cloning style, not inventing —
      // lower temperature keeps the model anchored to the reference image.
      temperature: GEMINI_IMAGE_TEMPERATURE,
      // nano-banana defaults to image output; this is belt-and-suspenders
      // and matches the v1beta REST docs.
      responseModalities: ['Image'],
    },
  };
  if (input.systemInstruction) {
    body.systemInstruction = { parts: [{ text: input.systemInstruction }] };
  }

  const result = await callProvider<GeminiResponse>({
    userId: input.userId,
    provider: 'gemini',
    url,
    method: 'POST',
    headers: {
      'x-goog-api-key': input.apiKey,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: IMAGE_TIMEOUT_MS,
    requestBodyForLog: {
      model: IMAGE_MODEL,
      prompt_chars: input.prompt.length,
      has_system_instruction: !!input.systemInstruction,
      has_reference_image: !!input.referenceImageBase64,
      temperature: GEMINI_IMAGE_TEMPERATURE,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const imagePart = extractImage(result.data);
  if (!imagePart) {
    return {
      ok: false,
      costUsd: computeGeminiImageCost(0),
      latencyMs: result.latencyMs,
      errorMessage: 'Gemini Image returned no image data',
    };
  }

  return {
    ok: true,
    imageBase64: imagePart.data,
    imageMimeType: imagePart.mimeType,
    costUsd: computeGeminiImageCost(1),
    latencyMs: result.latencyMs,
  };
}

function extractText(response: GeminiResponse): string | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const out: string[] = [];
  for (const p of parts) {
    if ('text' in p && typeof p.text === 'string') out.push(p.text);
  }
  return out.length > 0 ? out.join('') : null;
}

function extractImage(response: GeminiResponse): { data: string; mimeType: string } | null {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    // Some responses use snake_case, some camelCase. Handle both.
    if ('inline_data' in p) {
      return { data: p.inline_data.data, mimeType: p.inline_data.mime_type };
    }
    if ('inlineData' in p) {
      return { data: p.inlineData.data, mimeType: p.inlineData.mimeType };
    }
  }
  return null;
}

/** Lightweight verify: 1-token text request. Returns 200 on valid key. */
export async function verifyGeminiKey(
  apiKey: string,
  userId: string,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const url = `${GEMINI_BASE}/models/${VISION_MODEL}:generateContent`;
  const result = await callProvider<GeminiResponse>({
    userId,
    provider: 'gemini',
    url,
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'pong' }] }],
      generationConfig: { maxOutputTokens: 4 },
    },
    timeoutMs: 10_000,
    requestBodyForLog: { _verify: true },
  });
  return result.ok ? { ok: true } : { ok: false, errorMessage: result.errorMessage };
}
