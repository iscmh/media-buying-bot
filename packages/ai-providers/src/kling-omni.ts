import { callProvider } from './chokepoint';

/**
 * Polish-10: Kling 3.0 Omni multi-segment client. Targets
 * kwaivgi/kling-v3-omni-video, which supports:
 *   - Native multi-shot mode (up to 6 connected shots per 15s
 *     generation via the multi_prompt input), so internal
 *     continuity within a segment is native, not stitched.
 *   - reference_images (up to 7) to anchor character identity
 *     across separate segments.
 *   - generate_audio (must be explicit — schema default is false)
 *     for synchronized lip-sync per segment.
 *
 * Used by generate-kling-3-omni-multi-segment.ts to render a 30s
 * UGC ad as 2x 15s segments crossfaded at the single boundary.
 *
 * Schema reference (verified against the Replicate model page):
 *   prompt              string, max 2500 chars
 *   reference_images    file[] (URLs accepted), max 7,
 *                       .jpg/.png, ≥ 300px, aspect 1:2.5 to 2.5:1,
 *                       ≤ 10MB
 *   mode                'standard' | 'pro' (default) | '4k'
 *   aspect_ratio        '16:9' | '9:16' | '1:1' (default '16:9')
 *   duration            3-15 (default 5)
 *   generate_audio      boolean (default FALSE — we set true)
 *   multi_prompt        JSON-stringified array of {prompt,duration},
 *                       max 6 shots, sum of durations === outer duration
 *   negative_prompt     string
 *
 * In multi_prompt shots, `<<<image_N>>>` tokens reference
 * reference_images[N-1] for character/scene grounding.
 */

const REPLICATE_BASE = 'https://api.replicate.com';
const DEFAULT_KLING_OMNI_MODEL = 'kwaivgi/kling-v3-omni-video';
const SUBMIT_TIMEOUT_MS = Number(process.env.REPLICATE_SUBMIT_TIMEOUT_MS) || 30_000;
const CHECK_TIMEOUT_MS = Number(process.env.REPLICATE_CHECK_TIMEOUT_MS) || 15_000;

/**
 * Pricing (verified against Replicate model page Nov 2026):
 *   standard with audio  $0.224/sec   → 15s = $3.36
 *   pro      with audio  $0.28 /sec   → 15s = $4.20
 *
 * We default to pro for production quality; standard is available
 * via the mode param for cheaper iteration. Tuneable via env.
 */
const KLING_OMNI_PRO_USD_PER_SECOND =
  Number(process.env.REPLICATE_KLING_OMNI_PRO_USD_PER_SEC) || 0.28;
const KLING_OMNI_STANDARD_USD_PER_SECOND =
  Number(process.env.REPLICATE_KLING_OMNI_STANDARD_USD_PER_SEC) || 0.224;

export type KlingOmniMode = 'standard' | 'pro' | '4k';

/**
 * Polish-10.1: default mode dropped to 'standard' to match the
 * Polish-10.1 submit default. Iteration cost is what we estimate;
 * pro/4k callers pass `mode` explicitly.
 */
export function estimateKlingOmniSegmentCostUsd(
  durationSeconds: number,
  mode: KlingOmniMode = 'standard',
): number {
  const perSec =
    mode === 'standard' ? KLING_OMNI_STANDARD_USD_PER_SECOND : KLING_OMNI_PRO_USD_PER_SECOND;
  return Math.round(perSec * durationSeconds * 100) / 100;
}

/**
 * Polish-10: aggressive negative prompt — suppresses captions, the
 * "too AI" tells (smooth/airbrushed skin, studio lighting, perfect
 * symmetry), and theatrical pacing cues. Sent on every submit
 * unless the caller overrides.
 */
export const KLING_OMNI_NEGATIVE_PROMPT = [
  // Captions / burned-in text — Kling auto-burns otherwise.
  'captions, subtitles, closed captions, on-screen text, burned-in text, watermarks, logos, text overlays',
  // AI tells — what makes output read as obviously AI.
  'smooth skin, plastic skin, airbrushed, retouched, glossy skin, uncanny valley, perfect skin, flawless skin, doll-like',
  'cinematic, cinematic lighting, studio lighting, professional photography, professional camera, film grain artificial',
  'symmetric face, AI-generated face, over-rendered, hyperreal, over-saturated, vibrant colors',
  // Pacing — Omni defaults to dramatic delivery without this cue.
  'slow motion, dramatic motion, theatrical pacing, dead air, long pauses, silent moments',
].join(', ');

export function getKlingOmniRawModelId(): string {
  return process.env.REPLICATE_KLING_OMNI_MODEL_ID?.trim() || DEFAULT_KLING_OMNI_MODEL;
}

export function isKlingOmniEnabled(): boolean {
  return getKlingOmniRawModelId().length > 0;
}

export type KlingOmniPredictionStatus =
  | 'starting'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/** One entry in the multi_prompt array. */
export interface KlingOmniShot {
  prompt: string;
  /** Per-shot duration in seconds. Sum across shots MUST equal outer duration. */
  duration: number;
}

export interface KlingOmniSubmitInput {
  userId: string;
  apiKey: string;
  /**
   * Outer prompt. For single-shot, this is the whole video direction.
   * For multi-shot (multiPrompt set), this is an overall scene
   * description; per-shot prompts live in multiPrompt.
   * Max 2500 chars per the schema.
   */
  prompt: string;
  /**
   * Reference frames anchoring character + scene identity. Max 7.
   * Referenced from prompts via `<<<image_1>>>`, `<<<image_2>>>`, ...
   */
  referenceImageUrls?: string[];
  /**
   * Multi-shot mode. Up to 6 shots; sum of durations MUST equal
   * `durationSeconds`. We JSON.stringify this on the way to Replicate
   * per the documented input shape.
   */
  multiPrompt?: KlingOmniShot[];
  /** 3-15 (default 15). */
  durationSeconds?: number;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  /**
   * Polish-10.1: default mode is now 'standard' (720p, $0.224/sec) —
   * indistinguishable from 'pro' (1080p, $0.28/sec) on phone viewers
   * for 9:16 UGC ads, and meaningfully cheaper. Set explicitly for
   * higher quality.
   */
  mode?: KlingOmniMode;
  negativePrompt?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KlingOmniSubmitResult {
  ok: boolean;
  predictionId?: string;
  modelId: string;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

/**
 * Submit a Kling 3.0 Omni generation. Parses the model id for an
 * optional `:VERSION_HASH` suffix and dispatches to either the
 * model-named endpoint (officially-exposed models) or the versioned
 * endpoint (community-pinned versions). Same convention as
 * replicate-concat.ts / replicate-audio-trim.ts.
 */
export async function submitKlingOmni(input: KlingOmniSubmitInput): Promise<KlingOmniSubmitResult> {
  const raw = getKlingOmniRawModelId();
  const colonIdx = raw.indexOf(':');
  const modelPath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
  const version = colonIdx === -1 ? '' : raw.slice(colonIdx + 1).trim();

  const durationSeconds = input.durationSeconds ?? 15;
  const klingInput: Record<string, unknown> = {
    prompt: input.prompt,
    duration: durationSeconds,
    aspect_ratio: input.aspectRatio ?? '9:16',
    // Polish-10.1: default mode dropped pro→standard. 720p is
    // indistinguishable from 1080p in 9:16 portrait on phone viewers
    // (Meta UGC's only consumption surface), and standard's
    // $0.224/sec is cheap enough that a $20 Replicate balance covers
    // multiple 2-segment generations. Pro/4k remain available via
    // explicit override.
    mode: input.mode ?? 'standard',
    // Schema default for generate_audio is FALSE — set explicitly.
    generate_audio: true,
    negative_prompt: input.negativePrompt ?? KLING_OMNI_NEGATIVE_PROMPT,
  };
  if (input.referenceImageUrls && input.referenceImageUrls.length > 0) {
    klingInput.reference_images = input.referenceImageUrls.slice(0, 7);
  }
  if (input.multiPrompt && input.multiPrompt.length > 0) {
    // Schema requires multi_prompt as a JSON-stringified array.
    klingInput.multi_prompt = JSON.stringify(input.multiPrompt.slice(0, 6));
  }

  const url = version
    ? `${REPLICATE_BASE}/v1/predictions`
    : `${REPLICATE_BASE}/v1/models/${modelPath}/predictions`;
  const body = version ? { version, input: klingInput } : { input: klingInput };

  const result = await callProvider<{ id?: string; error?: string }>({
    userId: input.userId,
    provider: 'kling',
    url,
    method: 'POST',
    headers: {
      Authorization: `Token ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model_id: modelPath,
      version: version || undefined,
      prompt_chars: input.prompt.length,
      duration: durationSeconds,
      aspect_ratio: klingInput.aspect_ratio,
      mode: klingInput.mode,
      reference_image_count: input.referenceImageUrls?.length ?? 0,
      multi_prompt_shot_count: input.multiPrompt?.length ?? 0,
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });
  if (!result.ok) {
    return {
      ok: false,
      modelId: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  const predictionId = result.data.id;
  if (!predictionId) {
    return {
      ok: false,
      modelId: raw,
      latencyMs: result.latencyMs,
      errorMessage: 'Replicate Omni response missing prediction id',
    };
  }
  return {
    ok: true,
    predictionId,
    modelId: raw,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}

export interface KlingOmniCheckInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  /** Required to attribute cost when status === 'completed'. */
  durationSeconds?: number;
  mode?: KlingOmniMode;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KlingOmniCheckResult {
  status: 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  costUsd: number;
  rawStatus?: KlingOmniPredictionStatus;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
}

export async function checkKlingOmni(input: KlingOmniCheckInput): Promise<KlingOmniCheckResult> {
  const url = `${REPLICATE_BASE}/v1/predictions/${encodeURIComponent(input.predictionId)}`;
  const result = await callProvider<{
    status?: KlingOmniPredictionStatus;
    output?: string | string[];
    error?: string;
  }>({
    userId: input.userId,
    provider: 'kling',
    url,
    method: 'GET',
    headers: { Authorization: `Token ${input.apiKey}` },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { prediction_id: input.predictionId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });
  if (!result.ok) {
    return {
      status: 'failed',
      costUsd: 0,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.errorMessage,
    };
  }
  const raw = result.data.status;
  if (raw === 'succeeded') {
    const out = Array.isArray(result.data.output) ? result.data.output[0] : result.data.output;
    return {
      status: 'completed',
      videoUrl: typeof out === 'string' ? out : undefined,
      costUsd: estimateKlingOmniSegmentCostUsd(input.durationSeconds ?? 15, input.mode ?? 'pro'),
      rawStatus: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
    };
  }
  if (raw === 'failed' || raw === 'canceled') {
    return {
      status: 'failed',
      costUsd: 0,
      rawStatus: raw,
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      errorMessage: result.data.error ?? `Kling Omni prediction ${raw}`,
    };
  }
  return {
    status: 'processing',
    costUsd: 0,
    rawStatus: raw,
    latencyMs: result.latencyMs,
    httpStatus: result.status,
  };
}
