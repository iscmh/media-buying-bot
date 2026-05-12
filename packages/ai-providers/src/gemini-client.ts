import { computeGeminiImageCost, computeGeminiTextCost } from '@mbb/shared';
import { callProvider, type CallProviderResult } from './chokepoint';

/**
 * Gemini 2.5 Flash + 2.5 Flash Image (a.k.a. nano-banana) clients.
 *
 * Endpoints (verified against Google's public API docs, May 2025):
 *   - Vision/text: POST .../models/gemini-2.5-flash:generateContent
 *   - Image gen:   POST .../models/gemini-2.5-flash-image:generateContent
 *
 * Auth: `x-goog-api-key` header. NEVER pass via query string — leaks to logs.
 *
 * Inline data limits:
 *   - Vision: ~20 MB per request when using inline_data. Larger files
 *     need the Files API (Phase 3.5). Job-submit-time check rejects
 *     UGC concept files >20 MB before this code runs.
 *
 * Phase 3b uses fetch directly per the build constraints — no SDK.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VISION_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image';

const VISION_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 30_000;

interface GeminiContent {
  role?: 'user' | 'model';
  parts: Array<
    | { text: string }
    | { inline_data: { mime_type: string; data: string } }
    | { inlineData: { mimeType: string; data: string } } // some SDK responses use camelCase
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
 * Call Gemini Vision with the UGC Deconstructor system prompt + a video
 * as inline base64. Returns parsed JSON output (the prompt enforces a
 * strict JSON shape).
 */
export async function callGeminiVision(input: GeminiVisionInput): Promise<GeminiVisionResult> {
  const url = `${GEMINI_BASE}/models/${VISION_MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: [
      {
        role: 'user' as const,
        parts: [
          {
            inline_data: {
              mime_type: input.videoMimeType,
              data: input.videoBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      response_mime_type: 'application/json',
    },
  };

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      rawText: text,
      errorMessage: 'Gemini response was not valid JSON',
    };
  }

  return { ok: true, json: parsed, rawText: text, costUsd, latencyMs: result.latencyMs };
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
