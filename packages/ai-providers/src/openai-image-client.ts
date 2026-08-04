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

/**
 * Commit 19: AbortError from AbortSignal.timeout(). Client fetched
 * OpenAI, waited N ms, gave up. RETRYABLE at the worker step.run
 * boundary — a re-fire lands with a fresh timer + often a warmer
 * OpenAI node.
 *
 * Distinct from OpenaiTransientError because:
 *   - Transient = OpenAI's edge returned 5xx (their fault)
 *   - Timeout = we gave up waiting (network fault OR OpenAI slow)
 * The operator-facing signal differs, and forensic replay wants
 * the actual timeout ms so we know whether to raise the ceiling.
 *
 * The prior behavior (Commit 18b through 18b-hotfix-2) caught
 * AbortError in the fetch try/catch and returned `{ ok: false }`
 * with the timeout message — Inngest step.run does NOT retry
 * `{ ok: false }` returns, only throws. Operator's Static-ad run
 * failed every variant with "The operation was aborted due to
 * timeout" and no retry ever ran.
 */
export class OpenaiTimeoutError extends Error {
  readonly kind = 'openai_timeout' as const;
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'OpenaiTimeoutError';
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
 * 18b-hotfix + Commit 19: quality-aware timeouts. Verified July 2026
 * gpt-image-2 latency floor / p50 / p95:
 *   Low    ~5s / ~10s / ~30s   → 60s ceiling (was 30s pre-19)
 *   Medium ~10s / ~20s / ~90s  → 120s ceiling (was 60s pre-19)
 *   High   ~15s / ~30s / ~150s → 180s ceiling (was 120s pre-19)
 *
 * Bumped in Commit 19 after operator hit "The operation was aborted
 * due to timeout" AbortErrors on Medium (60s was p95 tail). Latency
 * spikes past p95 are also common during OpenAI edge congestion.
 * Vercel's serverless ceiling for this route is 300s (set at
 * apps/web/app/api/inngest/route.ts:21) — plenty of headroom for
 * 180s + retry.
 *
 * The timeout is ALSO the ceiling for a single retry — worker
 * step.run re-fires on OpenaiTimeoutError throws (Commit 19), so
 * the effective budget per variant is 2× the ceiling below.
 */
function defaultTimeoutForQuality(q: OpenaiImageQuality): number {
  if (q === 'high') return 180_000;
  if (q === 'medium') return 120_000;
  return 60_000;
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
    `[openai-image-client] submit job=${jobId} url=${url} model=${model} quality=${quality} size=${size} timeout_ms=${timeoutMs} ref_bytes=${useEdits ? Math.floor((input.referenceImageBase64!.length * 3) / 4) : 0}`,
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
    // Commit 19: AbortSignal.timeout() fires a DOMException with
    // name='AbortError' AND / OR name='TimeoutError' depending on
    // the runtime (Node 20+ uses TimeoutError; some polyfills use
    // AbortError). Match either so step.run retries.
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        /aborted due to timeout|operation was aborted/i.test(msg));
    if (isTimeout) {
      console.log(
        `[openai-image-client] timeout job=${jobId} timeout_ms=${timeoutMs} — throwing OpenaiTimeoutError for retry`,
      );
      throw new OpenaiTimeoutError(
        `OpenAI image call exceeded ${timeoutMs}ms timeout (${msg})`,
        timeoutMs,
      );
    }
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
 * Polish-25.9 Commit 58: classify + describe raw OpenAI error text
 * into user-actionable guidance. Complements the existing typed
 * error classes above (OpenaiInsufficientFundsError etc.) - those
 * cover the internal control flow, but their `.message` is still
 * Google/OpenAI's raw string. The worker stashes that raw string
 * into generation_metadata.error + surfaces it on /runs, so the
 * user needs a clickable next step instead of "Billing hard limit
 * has been reached." with no context.
 *
 * Buckets:
 *   billing_limit   - "Billing hard limit has been reached" / hard
 *                     cap set on the OpenAI org. Persistent until
 *                     user raises the limit in Settings.
 *   quota_exceeded  - "insufficient_quota" / "You exceeded your
 *                     current quota". Account is out of paid credit.
 *   invalid_key     - "Invalid API key" / "revoked" / 401 auth. Key
 *                     is broken; needs a new one.
 *   rate_limit      - 429 / "Rate limit reached". Transient; retry
 *                     in a few minutes.
 *   content_policy  - Moderation reject. Different creative needed.
 *   invalid_image   - Reference image rejected (format / size).
 *   timeout         - AbortSignal / socket timeout. Usually a retry
 *                     will land on a healthy edge node.
 *   other           - Pass-through generic hint.
 */
export type OpenaiErrorCategory =
  | 'billing_limit'
  | 'quota_exceeded'
  | 'invalid_key'
  | 'rate_limit'
  | 'content_policy'
  | 'invalid_image'
  | 'timeout'
  | 'other';

export interface OpenaiErrorClassification {
  category: OpenaiErrorCategory;
  actionableHint: string;
}

export function classifyOpenaiErrorMessage(raw: string): OpenaiErrorClassification {
  const s = raw.toLowerCase();

  if (s.includes('billing hard limit') || s.includes('billing_hard_limit')) {
    return {
      category: 'billing_limit',
      actionableHint:
        'Your OpenAI organization hit the billing hard limit. Raise it at ' +
        'https://platform.openai.com/settings/organization/limits then retry. ' +
        'This is a spend cap, not a credit balance issue.',
    };
  }

  if (s.includes('insufficient_quota') || s.includes('exceeded your current quota')) {
    return {
      category: 'quota_exceeded',
      actionableHint:
        'Your OpenAI account is out of paid credit. Add credit at ' +
        'https://platform.openai.com/settings/organization/billing then retry.',
    };
  }

  if (
    s.includes('invalid api key') ||
    s.includes('invalid_api_key') ||
    s.includes('incorrect api key') ||
    s.includes('revoked') ||
    s.includes('401')
  ) {
    return {
      category: 'invalid_key',
      actionableHint:
        'Your OpenAI API key is invalid or revoked. Generate a new one at ' +
        'https://platform.openai.com/api-keys and paste it into Settings -> ' +
        'Connections -> OpenAI.',
    };
  }

  if (
    s.includes('rate limit') ||
    s.includes('rate_limit') ||
    s.includes('too many requests') ||
    s.includes('429')
  ) {
    return {
      category: 'rate_limit',
      actionableHint:
        'OpenAI rate limit reached. Wait a few minutes and retry, or lower the ' +
        'variant count on the next run.',
    };
  }

  if (
    s.includes('content policy') ||
    s.includes('safety system') ||
    s.includes('moderation') ||
    s.includes('content_policy_violation')
  ) {
    return {
      category: 'content_policy',
      actionableHint:
        "OpenAI's safety filter rejected this generation. Try a different source " +
        'ad or soften the overlay copy angle. Regenerating with the same input ' +
        'will fail the same way.',
    };
  }

  if (
    s.includes('invalid image') ||
    s.includes('image format') ||
    s.includes('unsupported image') ||
    s.includes('corrupted')
  ) {
    return {
      category: 'invalid_image',
      actionableHint:
        'OpenAI rejected the reference image. Confirm the source is a PNG or JPEG ' +
        'under 4 MB with no transparency issues.',
    };
  }

  if (s.includes('timeout') || s.includes('aborted') || s.includes('etimedout')) {
    return {
      category: 'timeout',
      actionableHint:
        'OpenAI took too long to respond. Retry - a fresh edge node usually clears ' +
        'the hang. If it repeats on Low quality, contact support.',
    };
  }

  return {
    category: 'other',
    actionableHint:
      'If this recurs, screenshot the exact message and drop it in the beta feedback ' + 'channel.',
  };
}

/**
 * Composite: raw error (kept for greppability) + actionable hint,
 * joined with " - ". Worker writes this to generation_metadata.error
 * so the operator sees both the raw + the fix in the same string.
 */
export function describeOpenaiError(raw: string): string {
  const { actionableHint } = classifyOpenaiErrorMessage(raw);
  return `${raw} - ${actionableHint}`;
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
  if (err instanceof OpenaiTimeoutError) return true;
  if (err instanceof Error && /timeout|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(err.message)) {
    return true;
  }
  return false;
}
