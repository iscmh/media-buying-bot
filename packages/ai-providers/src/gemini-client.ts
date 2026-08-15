import { computeGeminiImageCost, computeGeminiTextCost } from '@mbb/shared';
import { callProvider, type CallProviderResult } from './chokepoint';
import { nanoBananaProModel } from './nano-banana-character-clone-prompt';

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
      // Polish-25.8 Commit 54: classify the upload failure before
      // suggesting a fix. "compress the video" is only accurate when
      // the failure is a size limit; on PERMISSION_DENIED / quota
      // exhaustion it misleads the operator into the wrong action.
      errorMessage: `Gemini Files upload failed: ${describeGeminiUploadError(upload.errorMessage ?? 'unknown error')}`,
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

/**
 * Polish-25.8 Commit 54: turn Google's raw Files-API error into an
 * actionable one-liner for the operator.
 *
 * Real cause classes we've seen:
 *   1. "denied access" / PERMISSION_DENIED / "not authorized" — the
 *      user's Google project isn't authorized for the Generative
 *      Language API (Files sub-API). Fix is a one-click enable in the
 *      Cloud Console for that project. Compressing the video does not
 *      help.
 *   2. "quota" / RESOURCE_EXHAUSTED / 429 — per-project rate limit or
 *      daily-quota exhaustion. Fix is to wait (limits reset hourly /
 *      daily) or upgrade the Cloud project's quota.
 *   3. "too large" / "exceeds" / 413 — genuinely a size problem.
 *      Compressing helps.
 *   4. Anything else — pass through Google's message; operator
 *      contacts support if it recurs.
 *
 * We keep the raw error text in the message so the tester can grep
 * for it in Google's docs / support forums. We add the specific
 * remediation suffix in front of it based on the classification.
 */
export function classifyGeminiUploadError(raw: string): {
  category: 'denied_access' | 'quota' | 'too_large' | 'other';
  actionableHint: string;
} {
  const s = raw.toLowerCase();
  if (
    s.includes('denied access') ||
    s.includes('permission_denied') ||
    s.includes('not authorized') ||
    s.includes('please contact support')
  ) {
    return {
      category: 'denied_access',
      actionableHint:
        "Your Gemini API key's Google Cloud project doesn't have the Generative Language API enabled. " +
        'Enable it at https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com ' +
        'for the project the API key belongs to, then retry. This is a project config issue, not a file-size issue.',
    };
  }
  if (
    s.includes('quota') ||
    s.includes('rate limit') ||
    s.includes('resource_exhausted') ||
    s.includes('429')
  ) {
    return {
      category: 'quota',
      actionableHint:
        'Your Gemini API project hit a rate limit or daily quota. ' +
        'Wait a few minutes and retry, or raise the quota at ' +
        'https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas.',
    };
  }
  if (
    s.includes('too large') ||
    s.includes('exceeds') ||
    s.includes('413') ||
    s.includes('payload too large')
  ) {
    return {
      category: 'too_large',
      actionableHint:
        'The source video exceeds Gemini Files-API limits. Compress under 100 MB and retry.',
    };
  }
  return {
    category: 'other',
    actionableHint: 'If this recurs, contact Google support for your project with the error above.',
  };
}

export function describeGeminiUploadError(raw: string): string {
  const { actionableHint } = classifyGeminiUploadError(raw);
  return `${raw} — ${actionableHint}`;
}

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
  /**
   * Polish-26.0.2 Commit 61.2: forensic diagnostics returned on
   * failure so callers can identify the root cause without a
   * round-trip through ai_provider_api_call_logs. All fields
   * optional; MakeUGC refresh worker ignores them (backward-
   * compatible) but the HeyGen refresh worker logs them on the
   * first failure of each analyze batch. Populated whenever we
   * have the data to fill them, even on success.
   */
  diagnostics?: {
    /** Content-Type header returned by the imageUrl fetch. */
    imageMime?: string;
    /** Byte length of the fetched image body. */
    imageBytes?: number;
    /** HTTP status of the imageUrl fetch. */
    imageFetchStatus?: number;
    /** Gemini's HTTP status if we made the request. */
    geminiStatus?: number;
    /** First 2 KB of Gemini's response body (raw JSON stringified). */
    geminiRawBodyExcerpt?: string;
    /** Which stage produced the failure: image-fetch | mime-filter | gemini | parse. */
    failedAt?: 'image-fetch' | 'mime-filter' | 'gemini' | 'parse';
    /**
     * Polish-26.0.3 Commit 61.3: true when the CDN-provided
     * content-type was overridden via URL-extension or magic-byte
     * inference. Present on both success and Gemini-failure paths
     * so operator forensics can spot CDN mis-serving in the field.
     */
    mimeInferred?: boolean;
    /** Which inference source picked the mime when mimeInferred=true. */
    mimeInferredFrom?: 'url-extension' | 'magic-bytes';
    /** The final MIME actually sent to Gemini (post-inference). */
    mimeSentToGemini?: string;
  };
}

/**
 * Polish-26.0.2 Commit 61.2: content-type allowlist for the
 * inline-data path. Gemini's generateContent inline_data accepts
 * PNG / JPEG / WebP / HEIC / HEIF (per REST v1beta docs). Anything
 * else — animated WebP, GIF, SVG, video — is rejected at the model
 * decode step and surfaces as an opaque "500 Internal error
 * encountered." Filter it BEFORE the Gemini call so we log the
 * real reason instead of burning credits on a guaranteed reject.
 */
const GEMINI_INLINE_SUPPORTED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * Polish-26.0.3 Commit 61.3: generic / unhelpful content-types we
 * treat as "no real answer, please infer." HeyGen's CDN serves
 * every WebP preview_image_url as binary/octet-stream even though
 * the bytes are a valid WebP — Commit-61.2's MIME allowlist
 * correctly rejected these, but at 100% rejection rate the sync
 * was still broken (1264 avatars misrouted). Inference recovers.
 */
const GENERIC_MIMES_NEEDING_INFERENCE = new Set([
  'binary/octet-stream',
  'application/octet-stream',
  'application/binary',
  'application/unknown',
  'text/plain', // some CDNs default to this when they don't know
  '',
]);

function normalizeMimeForFilter(raw: string): string {
  // Strip parameters ("image/webp; charset=binary" → "image/webp"),
  // lowercase, trim.
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function isGeminiInlineImageMimeSupported(rawMime: string | null | undefined): boolean {
  if (!rawMime) return false;
  return GEMINI_INLINE_SUPPORTED_MIMES.has(normalizeMimeForFilter(rawMime));
}

/**
 * Polish-26.0.3 Commit 61.3: URL-extension → MIME lookup for the
 * inference fallback path. Only maps to types Gemini's inline_data
 * accepts; anything else stays null so the caller keeps rejecting.
 */
function mimeFromUrlExtension(url: string): string | null {
  // Strip query + fragment before extracting the extension.
  const cleaned = url.split('?')[0]?.split('#')[0] ?? '';
  const lastDot = cleaned.lastIndexOf('.');
  const lastSlash = cleaned.lastIndexOf('/');
  if (lastDot < 0 || lastDot < lastSlash) return null;
  const ext = cleaned.slice(lastDot + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return null;
  }
}

/**
 * Polish-26.0.3 Commit 61.3: magic-byte MIME detector for images.
 * Belt-and-suspenders against a URL that has no extension (e.g. a
 * signed URL path like "/download/abc123") but genuinely serves a
 * supported image body. Called only after the URL-extension path
 * returns null.
 */
function mimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: RIFF????WEBP → 52 49 46 46 __ __ __ __ 57 45 42 50
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // HEIC / HEIF: 00 00 00 __ 66 74 79 70 (ftyp) followed by brand
  // "heic" (68 65 69 63) or "mif1" (6D 69 66 31) at offset 8.
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    ((bytes[8] === 0x68 && bytes[9] === 0x65 && bytes[10] === 0x69 && bytes[11] === 0x63) ||
      (bytes[8] === 0x6d && bytes[9] === 0x69 && bytes[10] === 0x66 && bytes[11] === 0x31))
  ) {
    return 'image/heic';
  }
  return null;
}

export interface MimeResolutionResult {
  /** Final MIME to send to Gemini. Null when we can't identify one. */
  mime: string | null;
  /** True when we overrode the CDN-provided content-type. */
  inferred: boolean;
  /** Which source picked the mime. */
  source: 'header' | 'url-extension' | 'magic-bytes' | 'none';
}

/**
 * Polish-26.0.3 Commit 61.3: two-step MIME inference for CDN
 * responses that lie about content-type.
 *
 *   1. If the header is ALREADY a supported image type, keep it.
 *   2. If the header is generic (binary/octet-stream + friends),
 *      try URL extension → MIME lookup, then magic bytes.
 *   3. If the header is wrong-but-specific (e.g. "video/mp4"), we
 *      DON'T fight it — return null so the caller rejects. Fighting
 *      a specific-but-wrong header is likely to route real garbage
 *      to Gemini.
 */
export function resolveInlineImageMime(
  rawMime: string | null | undefined,
  imageUrl: string,
  bytes: Uint8Array,
): MimeResolutionResult {
  const normalized = normalizeMimeForFilter(rawMime ?? '');
  if (GEMINI_INLINE_SUPPORTED_MIMES.has(normalized)) {
    return { mime: normalized, inferred: false, source: 'header' };
  }
  if (!GENERIC_MIMES_NEEDING_INFERENCE.has(normalized)) {
    return { mime: null, inferred: false, source: 'none' };
  }
  const fromExt = mimeFromUrlExtension(imageUrl);
  if (fromExt) {
    return { mime: fromExt, inferred: true, source: 'url-extension' };
  }
  const fromMagic = mimeFromMagicBytes(bytes);
  if (fromMagic) {
    return { mime: fromMagic, inferred: true, source: 'magic-bytes' };
  }
  return { mime: null, inferred: false, source: 'none' };
}

export async function analyzeMakeugcAvatarThumbnail(
  input: AnalyzeMakeugcAvatarThumbnailInput,
): Promise<AnalyzeMakeugcAvatarThumbnailResult> {
  // Fetch + inline the thumbnail (mirror rateGeminiFaceSimilarity —
  // Files API adds ~5s polling latency that we don't need for a
  // <2 MB PNG).
  let inlineData: { mimeType: string; data: string };
  let fetchStatus = 0;
  let fetchedBytes = 0;
  // Polish-26.0.3 Commit 61.3: hoisted so the post-Gemini success/
  // failure branches can populate diagnostics.mimeInferred etc.
  let rawMimeReceived = '';
  let mimeInferenceSource: MimeResolutionResult['source'] | null = null;
  const fetchStart = Date.now();
  try {
    const response = await fetch(input.imageUrl);
    fetchStatus = response.status;
    if (!response.ok) {
      return {
        ok: false,
        costUsd: 0,
        latencyMs: Date.now() - fetchStart,
        errorMessage: `Failed to fetch avatar thumbnail (HTTP ${response.status})`,
        diagnostics: { imageFetchStatus: response.status, failedAt: 'image-fetch' },
      };
    }
    const rawMime = response.headers.get('content-type') ?? '';
    rawMimeReceived = rawMime;
    const arrayBuffer = await response.arrayBuffer();
    fetchedBytes = arrayBuffer.byteLength;
    const bodyBytes = new Uint8Array(arrayBuffer);
    // Polish-26.0.2 Commit 61.2: MIME filter — refuse to call Gemini
    // with a content-type it can't decode via inline_data. Without
    // this, HeyGen's animated-WebP / video-container preview URLs
    // returned an opaque "500 Internal error encountered" on every
    // single call (1264/1264 failures observed on run 01KZAPKYZ03W6DA9ZE8D918BHY).
    //
    // Polish-26.0.3 Commit 61.3: extended with URL-extension + magic-
    // bytes inference for CDNs that mis-serve real images as
    // binary/octet-stream. HeyGen's files2.heygen.ai CDN does exactly
    // that for WebP previews — Commit-61.2 correctly rejected them
    // but 100% of avatars looked like malformed content. See
    // resolveInlineImageMime() above for the resolution ladder.
    const resolution = resolveInlineImageMime(rawMime, input.imageUrl, bodyBytes);
    if (!resolution.mime) {
      return {
        ok: false,
        costUsd: 0,
        latencyMs: Date.now() - fetchStart,
        errorMessage:
          `Refusing to send unsupported MIME type "${rawMime || '(empty)'}" to Gemini vision. ` +
          `Supported: PNG, JPEG, WebP (static), HEIC, HEIF. ` +
          `URL-extension and magic-byte inference both failed. ` +
          `URL: ${input.imageUrl.slice(0, 200)} (${fetchedBytes} bytes).`,
        diagnostics: {
          imageMime: rawMime,
          imageBytes: fetchedBytes,
          imageFetchStatus: fetchStatus,
          failedAt: 'mime-filter',
        },
      };
    }
    mimeInferenceSource = resolution.source;
    if (resolution.inferred) {
      console.log(
        `[gemini-vision] MIME inferred via ${resolution.source}: ` +
          `"${rawMime || '(empty)'}" → "${resolution.mime}" ` +
          `for ${input.imageUrl.slice(0, 200)} (${fetchedBytes} bytes)`,
      );
    }
    inlineData = {
      mimeType: resolution.mime,
      data: Buffer.from(arrayBuffer).toString('base64'),
    };
  } catch (err) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: Date.now() - fetchStart,
      errorMessage: `Avatar thumbnail fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      diagnostics: { imageFetchStatus: fetchStatus, failedAt: 'image-fetch' },
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
    // Polish-26.0.2 Commit 61.2: surface the actual Gemini response
    // body (truncated) so the caller can identify what was rejected.
    // Pre-fix, this branch returned only "Google GenAI API 500
    // Internal error encountered" without the request MIME or the
    // Gemini response — leaving the operator blind to WHY the batch
    // was rejecting every image.
    const rawExcerpt = JSON.stringify(result.rawBody ?? {}).slice(0, 2000);
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
      diagnostics: {
        imageMime: rawMimeReceived || '(empty)',
        imageBytes: fetchedBytes,
        imageFetchStatus: fetchStatus,
        geminiStatus: result.status,
        geminiRawBodyExcerpt: rawExcerpt,
        failedAt: 'gemini',
        ...(mimeInferenceSource === 'url-extension' || mimeInferenceSource === 'magic-bytes'
          ? {
              mimeInferred: true,
              mimeInferredFrom: mimeInferenceSource,
              mimeSentToGemini: inlineData.mimeType,
            }
          : {}),
      },
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
      diagnostics: {
        imageMime: rawMimeReceived || '(empty)',
        imageBytes: fetchedBytes,
        imageFetchStatus: fetchStatus,
        geminiStatus: result.status,
        failedAt: 'parse',
        ...(mimeInferenceSource === 'url-extension' || mimeInferenceSource === 'magic-bytes'
          ? {
              mimeInferred: true,
              mimeInferredFrom: mimeInferenceSource,
              mimeSentToGemini: inlineData.mimeType,
            }
          : {}),
      },
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
// =========================================================================
// Polish-28.0.0 Commit 64: Nano Banana Pro character-clone image gen
// =========================================================================
//
// Uses Google's Gemini image-generation head (model
// `gemini-3-pro-image-preview`, aka "Nano Banana Pro"). Same base URL +
// x-goog-api-key auth as the vision / text calls above — only the model
// ID + generationConfig.responseModalities differ.
//
// Retail cost (2026 verified): ~$0.134/image at 1K-2K output resolution
// (~2K output tokens × $120/1M output tokens). Standard Nano Banana
// (`gemini-2.5-flash-image`) is ~$0.039/image — 3× cheaper, lower fidelity;
// Polish-28 defaults to Pro per operator's Phase 1 decision.
//
// The response returns the image as base64 in `inline_data.data` with
// the MIME type on `inline_data.mime_type` — extractImage() (above)
// handles both snake_case + camelCase shapes Google occasionally
// returns.

export interface CloneCharacterReferenceImageInput {
  userId: string;
  apiKey: string;
  /**
   * The persona-clone prompt built via
   * composeNanoBananaCharacterClonePrompt(personaDescription).
   */
  prompt: string;
  /**
   * ONE reference frame from the source ad (Gemini frame extract or
   * ffmpeg-extracted keyframe). Base64-encoded WITHOUT the data-URL
   * prefix. Nano Banana Pro can accept up to 14 refs; we keep it at
   * one for cost + latency determinism.
   */
  referenceImageBase64: string;
  /** MIME of the reference image ('image/png' | 'image/jpeg' | 'image/webp'). */
  referenceImageMimeType: string;
  /**
   * Optional model ID override. Defaults to the env-configurable
   * NANO_BANANA_PRO_DEFAULT_MODEL_ID ('gemini-3-pro-image-preview').
   * Pass NANO_BANANA_STANDARD_MODEL_ID ('gemini-2.5-flash-image')
   * for the cheaper MVP tier.
   */
  modelId?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface CloneCharacterReferenceImageResult {
  ok: boolean;
  /** Generated portrait as base64 (no data-URL prefix). Undefined on failure. */
  imageBase64?: string;
  /** MIME type Google returned (typically 'image/png'). */
  imageMimeType?: string;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
  /** Per-generation diagnostics for logging. */
  diagnostics?: {
    modelId: string;
    referenceBytes: number;
    referenceMime: string;
    geminiStatus?: number;
    geminiRawBodyExcerpt?: string;
    failedAt?: 'gemini' | 'no-image-in-response';
  };
}

/**
 * Nano Banana Pro character-clone. Sends a persona-anchored prompt +
 * ONE reference frame → gets ONE portrait image back. Used by the
 * Polish-28 clone-UGC worker to produce a persona-consistent
 * reference frame that HeyGen Avatar IV animates.
 *
 * Cost (Nano Banana Pro, 1K-2K aspect 1:1): ~$0.13/call. Cost is
 * derived from `usageMetadata.candidatesTokenCount * $120/1M` at
 * response time so the caller's cost estimator is truthful even if
 * Google shifts the rate mid-run.
 */
export async function cloneCharacterReferenceImage(
  input: CloneCharacterReferenceImageInput,
): Promise<CloneCharacterReferenceImageResult> {
  const modelId = input.modelId ?? nanoBananaProModel();
  const url = `${GEMINI_BASE}/models/${modelId}:generateContent`;
  const referenceBytes = Math.floor((input.referenceImageBase64.length * 3) / 4);
  const body = {
    contents: [
      {
        role: 'user' as const,
        parts: [
          {
            inline_data: {
              mime_type: input.referenceImageMimeType,
              data: input.referenceImageBase64,
            },
          },
          { text: input.prompt },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'] as const,
      // Polish-28.2.4 Commit 77: was '1:1' since 28.0.0. Operator flagged
      // that the character output + final HeyGen video weren't vertical
      // — root cause was Gemini emitting square while HeyGen expects
      // 9:16 (portrait); HeyGen was cropping/letterboxing the square
      // input into a 9:16 container, giving weird composition.
      imageConfig: { aspectRatio: '9:16' as const },
      temperature: 0.4,
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
    timeoutMs: 120_000,
    requestBodyForLog: {
      model: modelId,
      purpose: 'polish28_character_clone',
      prompt_chars: input.prompt.length,
      reference_bytes: referenceBytes,
      reference_mime: input.referenceImageMimeType,
    },
    ...(input.generationJobId ? { generationJobId: input.generationJobId } : {}),
    ...(input.generatedCreativeId ? { generatedCreativeId: input.generatedCreativeId } : {}),
  });

  if (!result.ok) {
    const rawExcerpt = JSON.stringify(result.rawBody ?? {}).slice(0, 2000);
    return {
      ok: false,
      costUsd: 0,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
      diagnostics: {
        modelId,
        referenceBytes,
        referenceMime: input.referenceImageMimeType,
        geminiStatus: result.status,
        geminiRawBodyExcerpt: rawExcerpt,
        failedAt: 'gemini',
      },
    };
  }

  const usage = result.data.usageMetadata ?? {};
  // Nano Banana Pro billing: $120 per 1M OUTPUT tokens. Image emissions
  // report as output tokens (~1120 tokens for a 1K-2K portrait). Derive
  // per-call cost so the estimator round-trips against actual usage.
  const outputTokens = usage.candidatesTokenCount ?? 0;
  const costUsd = (outputTokens / 1_000_000) * 120;

  const image = extractImage(result.data);
  if (!image) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: 'Nano Banana Pro returned no image part in the response.',
      diagnostics: {
        modelId,
        referenceBytes,
        referenceMime: input.referenceImageMimeType,
        geminiStatus: result.status,
        failedAt: 'no-image-in-response',
      },
    };
  }

  return {
    ok: true,
    imageBase64: image.data,
    imageMimeType: image.mimeType,
    costUsd,
    latencyMs: result.latencyMs,
    diagnostics: {
      modelId,
      referenceBytes,
      referenceMime: input.referenceImageMimeType,
      ...(result.status !== undefined ? { geminiStatus: result.status } : {}),
    },
  };
}

// Re-export the model IDs + prompt composer so the worker's import
// block stays short (one from '@mbb/ai-providers' instead of two).
export {
  NANO_BANANA_PRO_DEFAULT_MODEL_ID,
  NANO_BANANA_STANDARD_MODEL_ID,
  composeNanoBananaCharacterClonePrompt,
  nanoBananaProModel,
  // Polish-28.0.2 Commit 64.2 hotfix.
  flattenPersonaForClonePrompt,
} from './nano-banana-character-clone-prompt';

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
