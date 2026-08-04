import { computeGeminiImageCost, computeGeminiTextCost } from '@mbb/shared';
import { callProvider, type CallProviderResult } from './chokepoint';

/**
 * Gemini 2.5 Flash (vision) + Nano Banana 2 (image gen) clients.
 *
 * Endpoints (verified against Google's public API docs):
 *   - Vision/text:  POST .../models/gemini-2.5-flash:generateContent
 *   - Image gen:    POST .../models/{NANO_BANANA_MODEL_ID}:generateContent
 *                   default `gemini-3.1-flash-image` (Nano Banana 2 —
 *                   Polish-21.0.8 upgrade). Override via
 *                   NANO_BANANA_MODEL_ID env for A/B testing.
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

/**
 * Polish-25.8 Commit 53: swapped default from `gemini-2.5-flash` to
 * `gemini-flash-latest`. Beta tester Eric hit a "model not available"
 * error on Feb 2026-ish traffic; Google's public roster kept the
 * `-latest` alias pointing at the current-gen Flash text/vision model
 * while `gemini-2.5-flash` slid into deprecation.
 *
 * `-latest` is the safest default because Google publicly commits to
 * keeping the alias resolving to a supported model; when they cut a
 * generation, `-latest` follows without a code change.
 *
 * Override via GEMINI_VISION_MODEL env for A/B testing or hard-pinning
 * (e.g. `GEMINI_VISION_MODEL=gemini-2.5-flash` to force the old
 * generation while it's still available).
 */
export const DEFAULT_GEMINI_VISION_MODEL = 'gemini-flash-latest';

function visionModel(): string {
  const override = process.env['GEMINI_VISION_MODEL']?.trim();
  return override && override.length > 0 ? override : DEFAULT_GEMINI_VISION_MODEL;
}

/**
 * Polish-21.0.8 hotfix: default Nano Banana image model.
 *
 * Migrated from Nano Banana Pro (`gemini-2.5-flash-image`, ~$0.15/img,
 * 10-20s, character faces smart-downgraded per widespread April 2026
 * complaints) to Nano Banana 2 (`gemini-3.1-flash-image`, ~$0.08/img,
 * 4-8s, better character consistency per Melies review).
 *
 * The operator's manually-verified Linda-pattern outputs were run in
 * the Gemini app (which defaulted to NB2 at Feb 2026 launch); the
 * bot was silently on Pro and getting the plastic-face downgrade.
 * Model swap only — Polish-21.0.7 Linda prompt stays intact.
 *
 * Override via NANO_BANANA_MODEL_ID env for A/B testing without a
 * redeploy (e.g. `NANO_BANANA_MODEL_ID=gemini-2.5-flash-image` to
 * flip back to Pro).
 */
export const DEFAULT_NANO_BANANA_MODEL_ID = 'gemini-3.1-flash-image';

export function getNanoBananaModelId(): string {
  const override = process.env['NANO_BANANA_MODEL_ID']?.trim();
  return override && override.length > 0 ? override : DEFAULT_NANO_BANANA_MODEL_ID;
}

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

/**
 * Polish-19.0.1: explicit output-token cap for vision analysis. Pre-
 * Polish-19.0.1 we left this unset, which let Gemini pick its silent
 * default (~8192 tokens). For long-form sources (multi-minute UGC
 * monologues asking for full transcription + analysis) that default
 * truncated the response mid-JSON-string and tripped tryParseGeminiJson,
 * surfacing as a confusing "not parseable as JSON" error.
 *
 * 16384 covers ~95% of UGC ad analyses observed in production. When
 * the cap is hit anyway (finishReason='MAX_TOKENS' or usage within
 * 95% of cap) callGeminiVision auto-retries once with doubled budget,
 * capped at GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS (Gemini 2.5 Flash's
 * documented per-call ceiling).
 */
export const GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS = 65_536;
/**
 * Polish-19.0.1: fallback truncation heuristic when finishReason isn't
 * populated (older response shapes, edge cases). If candidatesTokenCount
 * is within 95% of the requested cap, treat as truncated — the false-
 * positive rate is acceptable since the retry just re-runs with a
 * higher cap, and the false-negative cost is exactly the bug we're
 * fixing (silent mid-string truncation).
 */
const GEMINI_VISION_TRUNCATION_RATIO = 0.95;

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
  /**
   * Polish-19.0.1: cap on output tokens. Optional; defaults to
   * GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS (16384). Long UGC sources
   * (multi-minute monologues with full transcription requests) blew
   * past the prior implicit ceiling (Gemini's silent default ≈ 8192),
   * truncated the response mid-JSON-string, and tripped tryParseGeminiJson.
   * Callers can override; callGeminiVision auto-retries with doubled
   * budget on truncation up to GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS.
   */
  maxOutputTokens?: number;
}

export interface GeminiVisionResult {
  ok: boolean;
  /** Parsed JSON if Gemini followed the system prompt's "ONLY JSON" rule. */
  json?: unknown;
  rawText?: string;
  /**
   * Polish-19.0.1: true when Gemini stopped emitting because it hit
   * the output-token cap (finishReason='MAX_TOKENS' OR token usage
   * within 95% of the cap). callGeminiVision uses this to drive its
   * one-shot retry with doubled cap.
   */
  truncated?: boolean;
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

  // Polish-19.0.1: clamp the requested cap into the supported range so
  // an out-of-bounds override doesn't surprise Gemini at the wire layer.
  const baseCap = clampGeminiOutputTokens(
    input.maxOutputTokens ?? GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const inputWithCap: GeminiVisionInput = { ...input, maxOutputTokens: baseCap };
  const first =
    binarySize <= INLINE_LIMIT_BYTES
      ? await callGeminiVisionInline(inputWithCap)
      : await callGeminiVisionViaFiles(inputWithCap);

  // Polish-19.0.1: one-shot retry with doubled budget when the first
  // attempt truncated. Cap stops at GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS
  // so a degenerate case doesn't keep doubling forever.
  if (!first.truncated || baseCap >= GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS) {
    return first;
  }
  const retryCap = clampGeminiOutputTokens(baseCap * 2);
  console.log(
    `[gemini-vision] response truncated at maxOutputTokens=${baseCap}; ` +
      `retrying once with doubled cap=${retryCap}`,
  );
  const retryInput: GeminiVisionInput = { ...input, maxOutputTokens: retryCap };
  return binarySize <= INLINE_LIMIT_BYTES
    ? callGeminiVisionInline(retryInput)
    : callGeminiVisionViaFiles(retryInput);
}

/** Polish-19.0.1: clamp into [1, GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS]. */
export function clampGeminiOutputTokens(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(Math.floor(raw), GEMINI_VISION_HARD_MAX_OUTPUT_TOKENS);
}

/** Path 1: inline base64 (≤ 20 MB). The original Phase 3b implementation. */
async function callGeminiVisionInline(input: GeminiVisionInput): Promise<GeminiVisionResult> {
  const url = `${GEMINI_BASE}/models/${visionModel()}:generateContent`;
  const maxOutputTokens = input.maxOutputTokens ?? GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS;
  const body = buildVisionBody(
    input.systemPrompt,
    [
      {
        inline_data: {
          mime_type: input.videoMimeType,
          data: input.videoBase64,
        },
      },
    ],
    maxOutputTokens,
  );

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
      model: visionModel(),
      system_prompt_chars: input.systemPrompt.length,
      video_mime: input.videoMimeType,
      video_base64_size_chars: input.videoBase64.length,
      max_output_tokens: maxOutputTokens,
      path: 'inline',
    },
    generationJobId: input.generationJobId,
  });

  return interpretVisionResponse(result, maxOutputTokens);
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

    const url = `${GEMINI_BASE}/models/${visionModel()}:generateContent`;
    const maxOutputTokens = input.maxOutputTokens ?? GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS;
    const body = buildVisionBody(
      input.systemPrompt,
      [{ file_data: { mime_type: input.videoMimeType, file_uri: fileUri } }],
      maxOutputTokens,
    );
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
        model: visionModel(),
        system_prompt_chars: input.systemPrompt.length,
        video_mime: input.videoMimeType,
        file_name: fileName,
        max_output_tokens: maxOutputTokens,
        path: 'files_api',
      },
      generationJobId: input.generationJobId,
    });
    return interpretVisionResponse(result, maxOutputTokens);
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
  maxOutputTokens: number,
) {
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user' as const, parts: videoPart }],
    generationConfig: {
      temperature: 0.4,
      response_mime_type: 'application/json',
      // Polish-19.0.1: explicit cap. See GEMINI_VISION_DEFAULT_MAX_OUTPUT_TOKENS
      // for why we no longer leave this implicit.
      maxOutputTokens,
    },
  };
}

/**
 * Polish-19.0.1: pure decision helper — given a Gemini response's
 * finishReason + token usage + the cap we requested, decide whether
 * the response was truncated by the cap. Two signals, OR'd:
 *
 *   1. finishReason === 'MAX_TOKENS' (authoritative when Gemini sets it)
 *   2. candidatesTokenCount ≥ cap × GEMINI_VISION_TRUNCATION_RATIO
 *      (fallback for older response shapes where finishReason isn't
 *      populated — a false positive just triggers one extra retry)
 *
 * Exported so the truncation branches can be unit-tested without
 * spinning up the whole vision call.
 */
export function isGeminiVisionTruncated(input: {
  finishReason?: string | null;
  candidatesTokenCount?: number | null;
  maxOutputTokens: number;
}): boolean {
  if (input.finishReason === 'MAX_TOKENS') return true;
  if (
    typeof input.candidatesTokenCount === 'number' &&
    input.candidatesTokenCount >= input.maxOutputTokens * GEMINI_VISION_TRUNCATION_RATIO
  ) {
    return true;
  }
  return false;
}

function interpretVisionResponse(
  result: CallProviderResult<GeminiResponse>,
  maxOutputTokens: number,
): GeminiVisionResult {
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
  const finishReason = result.data.candidates?.[0]?.finishReason ?? null;
  const truncated = isGeminiVisionTruncated({
    finishReason,
    candidatesTokenCount: usage.candidatesTokenCount ?? null,
    maxOutputTokens,
  });

  if (!text) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      truncated,
      errorMessage: truncated
        ? `Gemini hit output-token cap (${maxOutputTokens}t, finishReason=${finishReason ?? 'unset'}) before producing any text. Retry with a higher cap.`
        : 'Gemini returned no text content',
    };
  }

  const parseResult = tryParseGeminiJson(text);
  if (!parseResult.ok) {
    // Polish-19.0.1: log the FULL response to Inngest so a diagnostic
    // doesn't get truncated by the parse-error preview. The error
    // message bubbled to the operator stays bounded; the verbose
    // diagnostic lives in the Inngest logs.
    console.log(
      `[gemini-vision] parse failure: finishReason=${finishReason ?? 'unset'} ` +
        `tokens=${usage.candidatesTokenCount ?? '?'} / cap=${maxOutputTokens} ` +
        `truncated=${truncated} text_chars=${text.length}\n` +
        `--- FULL TEXT ---\n${text}\n--- END FULL TEXT ---`,
    );
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      rawText: text,
      truncated,
      // Polish-19.0.1: when the parse failure correlates with a
      // truncated response, prefer the truncation framing — that's
      // the actionable signal for the operator (raise the cap, or
      // wait for callGeminiVision's retry to take effect).
      errorMessage: truncated
        ? `Gemini response truncated at maxOutputTokens=${maxOutputTokens} (finishReason=${finishReason ?? 'unset'}, ${usage.candidatesTokenCount ?? '?'} tokens emitted). ${parseResult.error}`
        : parseResult.error,
    };
  }

  return {
    ok: true,
    json: parseResult.value,
    rawText: text,
    costUsd,
    latencyMs: result.latencyMs,
    truncated,
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

  // Polish-19.0.1: bumped preview from 500 → 2000 chars. The 500-char
  // cap was truncating the diagnostic itself — a Gemini response that
  // grew large enough to truncate mid-string was also large enough that
  // the operator-facing error couldn't show where the JSON broke. 2000
  // chars usually reaches the failure point; the full response also
  // lands in Inngest console logs via interpretVisionResponse.
  return {
    ok: false,
    error:
      `Gemini response was not parseable as JSON (tried direct, fenced, brace-bounded, ` +
      `bracket-bounded). First 2000 chars: ${text.slice(0, 2000)}`,
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
  // Polish-21.0.8: resolve the model id at call time so env override
  // (NANO_BANANA_MODEL_ID) is picked up without a redeploy. Default
  // is Nano Banana 2 (`gemini-3.1-flash-image`).
  const nanoBananaModelId = getNanoBananaModelId();
  const url = `${GEMINI_BASE}/models/${nanoBananaModelId}:generateContent`;
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
      model: nanoBananaModelId,
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

/**
 * Polish-12.8 v2: rate how strongly an AI-generated face resembles
 * any specific real-world public figure. Used to pre-validate Nano
 * Banana reference frames before sending them through Omni Flash —
 * Gemini's video safety classifier rejects celebrity-resembling
 * output downstream, and that's a $5+ wasted generation per trip.
 *
 * Cheap (~$0.0005 - $0.005 per call) — uses the same gemini-2.5-flash
 * text/vision model the deconstructor uses. The validator is the same
 * model family as the downstream Omni Flash filter, so the signals
 * are aligned: a low validator score correlates strongly with a clean
 * downstream filter pass.
 *
 * The image is fetched and inlined as base64 so the call doesn't
 * depend on Gemini Files API (which adds its own polling latency).
 * Assumes the image is small (a single Nano Banana frame, typically
 * < 2 MB) so the inline path is fast.
 */
export interface GeminiFaceSimilarityInput {
  userId: string;
  apiKey: string;
  /** Public URL of the face to validate — typically a Supabase-hosted Nano Banana frame. */
  imageUrl: string;
  generationJobId?: string;
}

export interface GeminiFaceSimilarityResult {
  ok: boolean;
  /** Integer 0-10. Higher = more celebrity-resembling. Undefined when ok=false. */
  similarityScore?: number;
  /** Raw Gemini text response (for diagnostics when the parse fails). */
  rawResponse?: string;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

const FACE_SIMILARITY_PROMPT = `You are evaluating an AI-generated face. Rate how strongly this person's face resembles any specific real-world public figure (celebrity actor, musician, athlete, politician, influencer, business figure, or well-known personality from anywhere in the world).

Score from 0 to 10:
- 0 = looks like a completely generic, forgettable person you'd pass on the street and never recognize
- 5 = some superficial resemblance to a public figure (similar hair, general age/ethnicity vibe) but not enough to mistake them
- 10 = could be mistaken for a specific famous person, family member of one, or strongly evokes a particular celebrity

Respond with ONLY the number, no explanation. Just a single integer 0 through 10.`;

/**
 * Polish-12.8 v2: parse Gemini's single-digit response. Returns the
 * number in [0, 10] when present; undefined when the response is
 * malformed (caller's worker treats undefined as validator failure
 * and proceeds with the current image rather than burning more
 * Nano Banana cycles).
 */
export function parseFaceSimilarityScore(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  // Gemini sometimes wraps the digit in markdown / sentences despite
  // the "ONLY the number" instruction. Pull the first 1-2 digit run
  // and clamp to [0, 10].
  const match = raw.match(/\b(10|[0-9])\b/);
  if (!match) return undefined;
  const score = Number(match[1]);
  if (!Number.isFinite(score) || score < 0 || score > 10) return undefined;
  return score;
}

export async function rateGeminiFaceSimilarity(
  input: GeminiFaceSimilarityInput,
): Promise<GeminiFaceSimilarityResult> {
  // 1. Download the image and inline as base64. The Nano Banana frame
  //    lives in Supabase storage at a public URL — we fetch + re-inline
  //    rather than using Files API because the image is small and the
  //    Files API path adds ~5s of polling latency we don't need.
  let inlineData: { mimeType: string; data: string };
  const fetchStart = Date.now();
  try {
    const response = await fetch(input.imageUrl);
    if (!response.ok) {
      return {
        ok: false,
        costUsd: 0,
        latencyMs: Date.now() - fetchStart,
        errorMessage: `Failed to fetch face image (HTTP ${response.status})`,
      };
    }
    const mimeType = response.headers.get('content-type') ?? 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    inlineData = {
      mimeType,
      data: Buffer.from(arrayBuffer).toString('base64'),
    };
  } catch (err) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: Date.now() - fetchStart,
      errorMessage: `Face image fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Call gemini-2.5-flash with the inlined image + similarity prompt.
  const url = `${GEMINI_BASE}/models/${visionModel()}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user' as const,
        parts: [
          { inline_data: { mime_type: inlineData.mimeType, data: inlineData.data } },
          { text: FACE_SIMILARITY_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      // Constrain to a single integer — no JSON wrapper needed.
      maxOutputTokens: 8,
    },
  };
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
      model: visionModel(),
      purpose: 'face_similarity_validation',
      image_mime: inlineData.mimeType,
      image_base64_chars: inlineData.data.length,
    },
    generationJobId: input.generationJobId,
  });

  if (!result.ok) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const rawText = extractText(result.data) ?? undefined;
  const usage = result.data.usageMetadata ?? {};
  const costUsd = computeGeminiTextCost(usage);
  const score = parseFaceSimilarityScore(rawText);
  if (score === undefined) {
    return {
      ok: false,
      rawResponse: rawText,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: `Could not parse similarity score from response: "${rawText ?? '(empty)'}"`,
    };
  }
  return {
    ok: true,
    similarityScore: score,
    rawResponse: rawText,
    costUsd,
    latencyMs: result.latencyMs,
  };
}

/**
 * Polish-25 Commit 7: analyze a MakeUGC avatar thumbnail image and
 * return structured descriptor JSON (age bucket, ethnicity, hair,
 * facial hair, wardrobe, background). Backs the enriched
 * makeugc_avatar_index refresh worker.
 *
 * Same shape as rateGeminiFaceSimilarity: fetch the imageUrl,
 * inline as base64, call gemini-2.5-flash with a text prompt that
 * demands strict JSON output, return raw string + parsed JSON to
 * the caller. Zod validation lives in
 * packages/jobs/src/lib/makeugc-avatar-vision-prompt.ts so this
 * layer stays generic — the caller owns schema semantics.
 *
 * Real cost: gemini-2.5-flash vision call on a single small
 * thumbnail is ~$0.0005 - $0.002 per image. For a full 500-avatar
 * MakeUGC library the one-time build is ~$0.25 - $1.
 */
export interface AnalyzeMakeugcAvatarThumbnailInput {
  userId: string;
  apiKey: string;
  /** Public MakeUGC thumbnail URL — fetched, inlined as base64. */
  imageUrl: string;
  /** System prompt supplied by caller so operator-tuned wording
   * stays out of this layer. */
  systemPrompt: string;
  generationJobId?: string;
}

export interface AnalyzeMakeugcAvatarThumbnailResult {
  ok: boolean;
  /** Raw Gemini text response — caller Zod-parses. Undefined when ok=false. */
  rawText?: string;
  /** Best-effort JSON.parse of rawText (with markdown-fence strip).
   *  Undefined when the response wasn't JSON-shaped. */
  parsedJson?: unknown;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

export async function analyzeMakeugcAvatarThumbnail(
  input: AnalyzeMakeugcAvatarThumbnailInput,
): Promise<AnalyzeMakeugcAvatarThumbnailResult> {
  // Fetch + inline the thumbnail (mirror rateGeminiFaceSimilarity —
  // Files API adds ~5s polling latency that we don't need for a
  // <2 MB PNG).
  let inlineData: { mimeType: string; data: string };
  const fetchStart = Date.now();
  try {
    const response = await fetch(input.imageUrl);
    if (!response.ok) {
      return {
        ok: false,
        costUsd: 0,
        latencyMs: Date.now() - fetchStart,
        errorMessage: `Failed to fetch avatar thumbnail (HTTP ${response.status})`,
      };
    }
    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    inlineData = {
      mimeType,
      data: Buffer.from(arrayBuffer).toString('base64'),
    };
  } catch (err) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: Date.now() - fetchStart,
      errorMessage: `Avatar thumbnail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const url = `${GEMINI_BASE}/models/${visionModel()}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user' as const,
        parts: [
          { inline_data: { mime_type: inlineData.mimeType, data: inlineData.data } },
          { text: input.systemPrompt },
        ],
      },
    ],
    generationConfig: {
      // Low temperature — descriptors, not creative writing.
      temperature: 0.1,
      // Ask Gemini to emit JSON directly. gemini-2.5-flash honors
      // responseMimeType per REST v1beta docs.
      responseMimeType: 'application/json',
      maxOutputTokens: 1024,
    },
  };

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
      model: visionModel(),
      purpose: 'makeugc_avatar_descriptor_vision',
      image_mime: inlineData.mimeType,
      image_base64_chars: inlineData.data.length,
    },
    generationJobId: input.generationJobId,
  });

  if (!result.ok) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    };
  }

  const rawText = extractText(result.data) ?? undefined;
  const usage = result.data.usageMetadata ?? {};
  const costUsd = computeGeminiTextCost(usage);
  if (!rawText || rawText.length === 0) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: 'Gemini returned an empty text response for avatar thumbnail analysis',
    };
  }
  // Strip a potential markdown fence — responseMimeType:'application/json'
  // should suppress it, but Gemini occasionally still emits ```json...```
  // per REST-mode drift observed on gemini-2.5-flash.
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsedJson: unknown = undefined;
  try {
    parsedJson = JSON.parse(stripped);
  } catch {
    // Leave undefined — caller decides whether the raw text is
    // usable or the call must be retried.
  }
  return {
    ok: true,
    rawText,
    parsedJson,
    costUsd,
    latencyMs: result.latencyMs,
  };
}

/** Lightweight verify: 1-token text request. Returns 200 on valid key. */
export async function verifyGeminiKey(
  apiKey: string,
  userId: string,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const url = `${GEMINI_BASE}/models/${visionModel()}:generateContent`;
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
