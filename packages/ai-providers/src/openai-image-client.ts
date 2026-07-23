/**
 * Polish-25.3 Commit 18b: OpenAI image-generation client.
 *
 * Backs the new "Static ad" pipeline. Two entry points:
 *
 *   - submitOpenaiImageGeneration({...})
 *       If referenceImageBase64 is supplied, POSTs multipart to
 *       /v1/images/edits so the model anchors on the reference image
 *       (this is the flow the static pipeline uses — user uploads a
 *       winning static ad, Claude rewrites the overlay copy, OpenAI
 *       edits the image to match). Without a reference image the
 *       call falls back to /v1/images/generations for pure text-to-
 *       image which nothing in the codebase currently exercises but
 *       is kept plumbed so the client is complete.
 *
 * Model + pricing lives here as top-level exported constants so a
 * model-name drift (e.g. OpenAI renames gpt-image-2 → gpt-image-2.1)
 * or a pricing change is a single-line edit — the worker imports
 * OPENAI_IMAGE_DEFAULT_MODEL and never hardcodes the string.
 *
 * Response shape returned to the worker mirrors the Gemini image
 * client — { ok, imageBase64?, imageMimeType?, costUsd, errorMessage?,
 * statusCode? } — so a future switch between Gemini + OpenAI at the
 * worker level is a drop-in.
 */

/**
 * Default OpenAI image model. Update this constant when OpenAI
 * ships a newer image model — every consumer imports it (no scattered
 * literals to hunt down). Operator confirmed gpt-image-2 as of the
 * shipped version.
 */
export const OPENAI_IMAGE_DEFAULT_MODEL = 'gpt-image-2' as const;

/**
 * Alternate models the operator can swap to via env override at the
 * worker layer. `gpt-image-1` is DEPRECATING (October 23, 2026) per
 * operator brief — do NOT default to it. `gpt-image-1-mini` is the
 * cheapest option for cost-optimized runs.
 */
export const OPENAI_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'] as const;
export type OpenaiImageModel = (typeof OPENAI_IMAGE_MODELS)[number];

/**
 * Per-image cost in USD for gpt-image-2 at 1024x1024. Operator
 * pricing brief — verify against OpenAI's live pricing page before
 * enabling live launches. The rest of the codebase computes
 * per-variant totals against these constants.
 */
export const OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE = 0.2;
export const OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE = 0.05;
export const OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE = 0.02;

/**
 * Sizes exposed to the picker. The static pipeline uses 1024x1024
 * for the initial ship (aspect-ratio variants — 1024x1536, 1536x1024
 * — land in a follow-up so the estimator + storage upload paths
 * don't need to branch on size on day one).
 */
export const OPENAI_IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type OpenaiImageSize = (typeof OPENAI_IMAGE_SIZES)[number];

export const OPENAI_IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export type OpenaiImageQuality = (typeof OPENAI_IMAGE_QUALITIES)[number];

/**
 * Per-quality cost helper. Only 1024x1024 pricing is pinned on
 * initial ship. Larger sizes fall back to the 1024 cost + a small
 * multiplier flag so the estimator doesn't lie about a future
 * higher-res picker — operators asked for cost transparency.
 */
export function estimateOpenaiImageCostUsd(input: {
  quality: OpenaiImageQuality;
  size?: OpenaiImageSize;
}): number {
  const base =
    input.quality === 'high'
      ? OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE
      : input.quality === 'medium'
        ? OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE
        : OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE;
  // Non-square sizes at gpt-image-2 are roughly 1.5x the square
  // cost per OpenAI's public pricing shape. Rough multiplier so the
  // estimator doesn't over-promise; refine when we surface a size
  // picker.
  const sizeMultiplier = input.size && input.size !== '1024x1024' ? 1.5 : 1;
  return round4(base * sizeMultiplier);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// =========================================================================
// Typed errors
// =========================================================================

/**
 * OpenAI returned 429 (rate-limited) or a quota-exhausted 4xx. Worker
 * step.run retry boundary will re-fire — Inngest handles the backoff.
 */
export class OpenaiRateLimitError extends Error {
  readonly kind = 'openai_rate_limit' as const;
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OpenaiRateLimitError';
  }
}

/**
 * OpenAI moderation flagged the prompt or image. Non-retryable — a
 * retry with the same inputs will get the same rejection.
 */
export class OpenaiContentPolicyError extends Error {
  readonly kind = 'openai_content_policy' as const;
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OpenaiContentPolicyError';
  }
}

/**
 * Account has no credits or hit its usage cap. Non-retryable — the
 * fix is BYOK-side, not a retry.
 */
export class OpenaiInsufficientFundsError extends Error {
  readonly kind = 'openai_insufficient_funds' as const;
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OpenaiInsufficientFundsError';
  }
}

/**
 * Reference image failed OpenAI's validation (bad format / too
 * large / unsupported). Non-retryable — the fix is on the concept
 * side, not a retry.
 */
export class OpenaiInvalidImageError extends Error {
  readonly kind = 'openai_invalid_image' as const;
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OpenaiInvalidImageError';
  }
}

// =========================================================================
// Client
// =========================================================================

export interface OpenaiImageInput {
  apiKey: string;
  model?: OpenaiImageModel;
  prompt: string;
  size?: OpenaiImageSize;
  quality?: OpenaiImageQuality;
  /** Base64-encoded reference image bytes (no data-URI prefix). */
  referenceImageBase64?: string;
  /** MIME type for the reference image; required if referenceImageBase64 set. */
  referenceImageMimeType?: string;
  /** Optional user/job id for forensic logs. */
  userId?: string;
  generationJobId?: string;
  /** Override the HTTP timeout. Defaults to 60s — gpt-image-2 is slow. */
  timeoutMs?: number;
}

export interface OpenaiImageResult {
  ok: boolean;
  imageBase64?: string;
  imageMimeType?: string;
  costUsd: number;
  errorMessage?: string;
  statusCode?: number;
  /**
   * OpenAI sometimes rewrites the prompt for moderation compliance —
   * surface it so the worker can persist it into
   * generationMetadata for forensic replay.
   */
  revisedPrompt?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_IMAGES_EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * POST an image-generation request to OpenAI. If
 * referenceImageBase64 + referenceImageMimeType are supplied the
 * call routes to /v1/images/edits with multipart body — this is
 * the reference-image-anchored path the static pipeline uses.
 * Without a reference image it falls back to
 * /v1/images/generations with a JSON body.
 *
 * NEVER throws for transient / classifiable failures — returns
 * `{ ok: false, ... }` with a typed error surfaced via the
 * errorMessage field. The caller decides whether to retry (worker
 * step.run boundary handles that).
 *
 * Auth errors (401/403) and moderation errors (400 with
 * content-policy code) do throw the typed error classes so the
 * worker's catch clause can classify them as NonRetriable.
 */
export async function submitOpenaiImageGeneration(
  input: OpenaiImageInput,
): Promise<OpenaiImageResult> {
  const model = input.model ?? OPENAI_IMAGE_DEFAULT_MODEL;
  const quality = input.quality ?? 'medium';
  const size = input.size ?? '1024x1024';
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobId = input.generationJobId ?? '(no-job-id)';

  const useEdits =
    typeof input.referenceImageBase64 === 'string' && input.referenceImageBase64.length > 0;
  const url = useEdits ? OPENAI_IMAGES_EDITS_URL : OPENAI_IMAGES_GENERATIONS_URL;

  console.log(
    `[openai-image-client] submit job=${jobId} url=${url} model=${model} quality=${quality} size=${size} ref_bytes=${useEdits ? Math.floor((input.referenceImageBase64!.length * 3) / 4) : 0}`,
  );

  let res: Response;
  try {
    if (useEdits) {
      const form = new FormData();
      const refBytes = Buffer.from(input.referenceImageBase64!, 'base64');
      const refBlob = new Blob([refBytes], {
        type: input.referenceImageMimeType ?? 'image/png',
      });
      const refFilename =
        (input.referenceImageMimeType ?? 'image/png') === 'image/jpeg'
          ? 'reference.jpg'
          : 'reference.png';
      form.append('image', refBlob, refFilename);
      form.append('prompt', input.prompt);
      form.append('model', model);
      form.append('n', '1');
      form.append('size', size);
      form.append('quality', quality);
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          n: 1,
          size,
          quality,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[openai-image-client] network job=${jobId} error=${msg}`);
    return {
      ok: false,
      costUsd: 0,
      errorMessage: `OpenAI image call failed to reach the network: ${msg}`,
    };
  }

  const statusCode = res.status;
  const rawBody = await res.text();
  console.log(
    `[openai-image-client] response job=${jobId} status=${statusCode} body_bytes=${rawBody.length}`,
  );

  let parsed: OpenaiImageResponsePayload | null = null;
  try {
    parsed = JSON.parse(rawBody) as OpenaiImageResponsePayload;
  } catch {
    // Non-JSON response (e.g. an HTML error page from a proxy).
    return {
      ok: false,
      statusCode,
      costUsd: 0,
      errorMessage: `OpenAI returned HTTP ${statusCode} with non-JSON body: ${rawBody.slice(0, 200)}`,
    };
  }

  if (!res.ok) {
    return classifyOpenaiError({ statusCode, parsed, rawBody });
  }

  const data = parsed?.data?.[0];
  if (!data?.b64_json) {
    return {
      ok: false,
      statusCode,
      costUsd: 0,
      errorMessage: 'OpenAI response did not include b64_json image data.',
    };
  }

  return {
    ok: true,
    imageBase64: data.b64_json,
    imageMimeType: 'image/png',
    revisedPrompt: data.revised_prompt,
    costUsd: estimateOpenaiImageCostUsd({ quality, size }),
    statusCode,
  };
}

interface OpenaiImageResponsePayload {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Map OpenAI's HTTP status + error envelope to the typed classes.
 * Non-retryable classes throw so the worker's catch can wrap them
 * in Inngest NonRetriableError. Transient classes (429 / 5xx) fall
 * through to `{ ok: false, ... }` so step.run retries hit them.
 */
function classifyOpenaiError(input: {
  statusCode: number;
  parsed: OpenaiImageResponsePayload | null;
  rawBody: string;
}): OpenaiImageResult {
  const { statusCode, parsed, rawBody } = input;
  const errObj = parsed?.error;
  const message = errObj?.message ?? rawBody.slice(0, 200);
  const code = errObj?.code ?? '';
  const type = errObj?.type ?? '';

  // Moderation / content-policy — non-retryable.
  if (
    code === 'content_policy_violation' ||
    code === 'moderation_blocked' ||
    /content policy|safety system|moderation/i.test(message)
  ) {
    throw new OpenaiContentPolicyError(message, statusCode);
  }

  // Billing / quota — non-retryable.
  if (
    code === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached' ||
    /insufficient_quota|billing|hard limit|payment/i.test(message)
  ) {
    throw new OpenaiInsufficientFundsError(message, statusCode);
  }

  // Reference-image validation — non-retryable.
  if (
    code === 'invalid_image' ||
    /invalid image|image format|corrupted|unsupported image/i.test(message)
  ) {
    throw new OpenaiInvalidImageError(message, statusCode);
  }

  // Rate limits — transient, worker retry.
  if (statusCode === 429 || type === 'rate_limit_error') {
    throw new OpenaiRateLimitError(message, statusCode);
  }

  return {
    ok: false,
    statusCode,
    costUsd: 0,
    errorMessage: `OpenAI returned HTTP ${statusCode}${code ? ` (${code})` : ''}: ${message}`,
  };
}

/**
 * Log-safe redaction — never leak the full key into structured
 * logs / audit rows. `sk-…abcd` shape.
 */
export function redactOpenaiApiKey(apiKey: string): string {
  if (!apiKey) return '(empty)';
  if (apiKey.length <= 8) return 'sk-…';
  const tail = apiKey.slice(-4);
  return `sk-…${tail}`;
}

/**
 * Convenience predicate — is this error class transient enough to
 * warrant a worker retry? Inngest's step.run will re-fire on
 * throws regardless; this is for callers that want to gate a
 * manual retry loop on top of step.run.
 */
export function isOpenaiTransientError(err: unknown): boolean {
  if (err instanceof OpenaiRateLimitError) return true;
  if (err instanceof Error && /timeout|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(err.message)) {
    return true;
  }
  return false;
}
