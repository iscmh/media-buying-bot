import { computeClaudeCost } from '@mbb/shared';
import { callProvider } from './chokepoint';

/**
 * Polish-6 item 1: auto-detect the format of an uploaded winning
 * creative (video or image). Uses Claude vision to classify the
 * creative into one of four format buckets, then extracts structured
 * metadata (demographics, setting, tone, pacing, visual elements,
 * dialogue). The output is persisted on generation_jobs.detected_format
 * and consumed by the pipeline router (item 2).
 *
 * For videos: caller provides pre-extracted frame URLs or base64 data.
 * Frame extraction itself (via ffmpeg) happens in the Inngest worker,
 * not here — this module is pure API logic.
 *
 * For audio transcription: optional Whisper call when the caller
 * provides an audio buffer / URL. Dialogue text is merged into the
 * detection output.
 */

// =========================================================================
// Types
// =========================================================================

export type DetectedFormatClass =
  | 'simple_ai_ugc'
  | 'ai_ugc_with_captions'
  | 'multi_scene_with_edits'
  | 'static_image_ad';

export interface DetectedFormat {
  format: DetectedFormatClass;
  mediaType: 'video' | 'image';
  demographics: {
    ageRange?: string;
    gender?: string;
    ethnicity?: string;
  };
  setting?: string;
  emotionalTone?: string;
  pacing?: string;
  keyVisualElements: string[];
  dialogueScript?: string;
  confidence: number;
}

export interface DetectCreativeFormatInput {
  userId: string;
  claudeApiKey: string;
  /** Pre-extracted frame URLs or base64 strings. For images: single element. */
  frames: Array<{ base64: string; mediaType: string }>;
  /** Optional transcribed dialogue from Whisper. */
  transcript?: string;
  generationJobId?: string;
}

export interface DetectCreativeFormatResult {
  ok: boolean;
  detection?: DetectedFormat;
  costUsd: number;
  latencyMs: number;
  errorMessage?: string;
}

// =========================================================================
// Detection
// =========================================================================

const CLAUDE_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const DETECT_TIMEOUT_MS = 60_000;

const DETECTION_SYSTEM_PROMPT = `You are an expert ad creative analyst. You receive one or more frames from an ad creative (video frames or a static image) plus an optional audio transcript.

Your job: classify the creative into EXACTLY ONE format category and extract structured metadata.

FORMAT CATEGORIES (pick one):
  "simple_ai_ugc"           — Single talking head, no caption/text overlays, one camera angle, one scene
  "ai_ugc_with_captions"    — Talking head with visible caption/text overlays burned into the video
  "multi_scene_with_edits"  — Multiple scene changes, cuts, B-roll footage, edited montage
  "static_image_ad"         — Single still image (not a video frame sequence)

CLASSIFICATION RULES:
  - If only 1 frame provided AND no transcript: classify as static_image_ad
  - If multiple frames all show the same person in the same position with minimal change: simple_ai_ugc or ai_ugc_with_captions (check for text overlays)
  - If multiple frames show different scenes/backgrounds/angles: multi_scene_with_edits
  - If text/captions are visible overlaid on the video frames: ai_ugc_with_captions

Output ONLY valid JSON matching this schema (no markdown, no commentary):
{
  "format": "<one of the four categories>",
  "media_type": "video" | "image",
  "demographics": {
    "age_range": "<e.g. '25-35'>",
    "gender": "<male|female|unknown>",
    "ethnicity": "<e.g. 'caucasian', 'asian', 'unknown'>"
  },
  "setting": "<e.g. 'home office', 'gym', 'kitchen'>",
  "emotional_tone": "<e.g. 'enthusiastic', 'calm', 'urgent'>",
  "pacing": "<e.g. 'fast cuts', 'slow and steady', 'single shot'>",
  "key_visual_elements": ["<element1>", "<element2>"],
  "dialogue_script": "<transcribed or inferred dialogue, or null>",
  "confidence": <0.0-1.0>
}`;

export async function detectCreativeFormat(
  input: DetectCreativeFormatInput,
): Promise<DetectCreativeFormatResult> {
  if (input.frames.length === 0) {
    return {
      ok: false,
      costUsd: 0,
      latencyMs: 0,
      errorMessage: 'No frames provided for detection.',
    };
  }

  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  > = [];

  for (const frame of input.frames) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: frame.mediaType,
        data: frame.base64,
      },
    });
  }

  let userText = `Analyze this creative (${input.frames.length} frame${input.frames.length > 1 ? 's' : ''}).`;
  if (input.transcript) {
    userText += `\n\nAudio transcript:\n${input.transcript}`;
  }
  content.push({ type: 'text', text: userText });

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: DETECTION_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content }],
  };

  const result = await callProvider<{
    content?: Array<{ type: 'text'; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>({
    userId: input.userId,
    provider: 'claude',
    url: `${CLAUDE_BASE}/messages`,
    method: 'POST',
    headers: {
      'x-api-key': input.claudeApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
    timeoutMs: DETECT_TIMEOUT_MS,
    requestBodyForLog: {
      _vision_detection: true,
      frame_count: input.frames.length,
      has_transcript: !!input.transcript,
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

  const text = result.data.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  const costUsd = computeClaudeCost(result.data.usage ?? {});

  if (!text) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: 'Claude returned no text in vision response.',
    };
  }

  const parsed = parseDetectionResponse(text, input.transcript);
  if (!parsed) {
    return {
      ok: false,
      costUsd,
      latencyMs: result.latencyMs,
      errorMessage: `Could not parse detection JSON: ${text.slice(0, 200)}`,
    };
  }

  return {
    ok: true,
    detection: parsed,
    costUsd,
    latencyMs: result.latencyMs,
  };
}

// =========================================================================
// Whisper transcription
// =========================================================================

const OPENAI_BASE = 'https://api.openai.com';
const WHISPER_TIMEOUT_MS = 120_000;

export interface TranscribeAudioInput {
  userId: string;
  openaiApiKey: string;
  /** Raw audio bytes (MP3/M4A/WAV). */
  audioBuffer: Uint8Array;
  audioFilename?: string;
  generationJobId?: string;
}

export interface TranscribeAudioResult {
  ok: boolean;
  transcript?: string;
  latencyMs: number;
  errorMessage?: string;
}

export async function transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
  const t0 = Date.now();
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(input.audioBuffer).buffer], { type: 'audio/mpeg' });
  formData.append('file', blob, input.audioFilename ?? 'audio.mp3');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'text');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENAI_BASE}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.openaiApiKey}` },
      body: formData,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        latencyMs,
        errorMessage: text.slice(0, 512) || `Whisper returned HTTP ${res.status}`,
      };
    }
    return { ok: true, transcript: text.trim(), latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      latencyMs,
      errorMessage: isAbort
        ? `Whisper timed out after ${WHISPER_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================================
// Parser
// =========================================================================

const VALID_FORMATS: ReadonlySet<string> = new Set([
  'simple_ai_ugc',
  'ai_ugc_with_captions',
  'multi_scene_with_edits',
  'static_image_ad',
]);

function parseDetectionResponse(text: string, transcript?: string): DetectedFormat | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const format = String(json.format ?? '');
  if (!VALID_FORMATS.has(format)) return null;

  const demographics = (json.demographics as Record<string, unknown>) ?? {};
  const keyVisuals = Array.isArray(json.key_visual_elements)
    ? (json.key_visual_elements as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  return {
    format: format as DetectedFormatClass,
    mediaType: json.media_type === 'image' ? 'image' : 'video',
    demographics: {
      ageRange: typeof demographics.age_range === 'string' ? demographics.age_range : undefined,
      gender: typeof demographics.gender === 'string' ? demographics.gender : undefined,
      ethnicity: typeof demographics.ethnicity === 'string' ? demographics.ethnicity : undefined,
    },
    setting: typeof json.setting === 'string' ? json.setting : undefined,
    emotionalTone: typeof json.emotional_tone === 'string' ? json.emotional_tone : undefined,
    pacing: typeof json.pacing === 'string' ? json.pacing : undefined,
    keyVisualElements: keyVisuals,
    dialogueScript:
      typeof json.dialogue_script === 'string' ? json.dialogue_script : (transcript ?? undefined),
    confidence: typeof json.confidence === 'number' ? json.confidence : 0.5,
  };
}
