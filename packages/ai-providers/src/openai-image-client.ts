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
 * Per-image cost in USD for gpt-image-2. Verified July 2026 pricing:
 *
 *   Square 1024x1024:
 *     Low    $0.006
 *     Medium $0.053
 *     High   $0.211
 *
 *   Rectangular (1024x1536 or 1536x1024) — actually cheaper than
 *   square per OpenAI's current pricing shape:
 *     Low    $0.005
 *     Medium $0.041
 *     High   $0.165
 *
 * The rest of the codebase computes per-variant totals against
 * these constants. `estimateOpenaiImageCostUsd()` picks the right
 * pair based on the size input; NEVER interpolate — OpenAI's
 * pricing is stepped, not linear.
 *
 * 18b-hotfix drift from 18b:
 *   Old  Low $0.02  Medium $0.05  High $0.20  (rectangular = 1.5×)
 *   New  Low $0.006 Medium $0.053 High $0.211 (rectangular table above)
 * Bugs the drift caused: cost estimate was ~3.3× too high on Low,
 * ~1.5× too high per non-square size (multiplier was upside-down —
 * rectangular is CHEAPER, not more expensive).
 */
export const OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE = 0.211;
export const OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE = 0.053;
export const OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE = 0.006;
export const OPENAI_GPT_IMAGE_2_HIGH_RECT_USD_PER_IMAGE = 0.165;
export const OPENAI_GPT_IMAGE_2_MEDIUM_RECT_USD_PER_IMAGE = 0.041;
export const OPENAI_GPT_IMAGE_2_LOW_RECT_USD_PER_IMAGE = 0.005;

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
 * Per-quality × per-size cost helper. Uses the verified July 2026
 * gpt-image-2 pricing table above — NOT a multiplier, because
 * OpenAI's pricing is stepped and non-square is actually cheaper
 * per image (opposite direction from the pre-hotfix multiplier).
 */
export function estimateOpenaiImageCostUsd(input: {
  quality: OpenaiImageQuality;
  size?: OpenaiImageSize;
}): number {
  const isRect = input.size === '1024x1536' || input.size === '1536x1024';
  if (isRect) {
    return input.quality === 'high'
      ? OPENAI_GPT_IMAGE_2_HIGH_RECT_USD_PER_IMAGE
      : input.quality === 'medium'
        ? OPENAI_GPT_IMAGE_2_MEDIUM_RECT_USD_PER_IMAGE
        : OPENAI_GPT_IMAGE_2_LOW_RECT_USD_PER_IMAGE;
  }
  return input.quality === 'high'
    ? OPENAI_GPT_IMAGE_2_HIGH_USD_PER_IMAGE
    : input.quality === 'medium'
      ? OPENAI_GPT_IMAGE_2_MEDIUM_USD_PER_IMAGE
      : OPENAI_GPT_IMAGE_2_LOW_USD_PER_IMAGE;
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

/**
 * 18b-hotfix: 502 / 503 / 504 from OpenAI's edge — RETRYABLE.
 * gpt-image-2 High takes 15-30s per generation and OpenAI's edge
 * routinely returns 504 during that window when a request lands
 * on a warming node. Worker step.run boundary re-fires so the
 * next attempt hits a healthy node.
 *
 * Distinct from OpenaiRateLimitError (429) because the operator-
 * facing message differs — 429 is "you're going too fast", 5xx
 * is "OpenAI is having a moment". Same retry behavior; different
 * telemetry.
 */
export class OpenaiTransientError extends Error {
  readonly kind = 'openai_transient' as const;
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OpenaiTransientError';
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

/**
 * 18b-hotfix: quality-aware timeouts. Verified July 2026 gpt-image-2
 * generation times:
 *   Low    ~5-10s   → 30s ceiling
 *   Medium ~10-20s  → 60s ceiling
 *   High   ~15-30s  → 120s ceiling
 * A single flat 60s default (18b initial) was too tight for High —
 * operator saw AbortErrors on legitimately-slow-but-successful
 * requests, which then re-tried via step.run and burned budget on
 * the retry rather than just waiting.
 */
function defaultTimeoutForQuality(q: OpenaiImageQuality): number {
  if (q === 'high') return 120_000;
  if (q === 'medium') return 60_000;
  return 30_000;
}
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
  const timeoutMs = input.timeoutMs ?? defaultTimeoutForQuality(quality);
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

  // 18b-hotfix: 5xx edge failures on gpt-image-2 High are common
  // during long generations. Throw a typed transient class so the
  // worker's catch retries (step.run re-fires on throws; returning
  // { ok: false } here would NOT retry).
  if (statusCode >= 500 && statusCode <= 599) {
    throw new OpenaiTransientError(message, statusCode);
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
  if (err instanceof OpenaiTransientError) return true;
  if (err instanceof Error && /timeout|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(err.message)) {
    return true;
  }
  return false;
}
