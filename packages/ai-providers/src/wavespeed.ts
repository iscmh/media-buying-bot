import { callProvider } from './chokepoint';

/**
 * Polish-23 Commit 1: WaveSpeedAI Higgsfield Soul image-to-image
 * client.
 *
 * WaveSpeedAI hosts a paid, no-subscription route to Higgsfield's
 * Soul image-to-image model. Polish-23's pipeline uses it to
 * transform a Nano-Banana seed image into a hyper-photoreal
 * reference PNG. That single reference URL is then handed to every
 * kie.ai Veo 3.1 Lite clip generation as `imageUrls[0]` so the
 * character stays locked across the batch (Polish-19's earlier
 * failure mode was per-clip Claude prompts describing new scenes
 * without locking character invariants — Polish-23 solves that at
 * the reference-image layer + at the per-clip prompt layer with the
 * CHARACTER LOCK prefix in Commit 3).
 *
 * Endpoint contract (verified from wavespeed.ai/docs during
 * Polish-23 pre-Commit-1 investigation):
 *
 *   Submit : POST https://api.wavespeed.ai/api/v3/higgsfield/soul/image-to-image
 *   Auth   : Authorization: Bearer <WAVESPEED_API_KEY>
 *   Body   : { prompt, image, size, seed?, quality, strength?, style? }
 *   Return : { data: { id, status: 'queued' }, ... }
 *   Poll   : GET https://api.wavespeed.ai/api/v3/predictions/{id}/result
 *   Done   : data.status === 'completed'; url at data.outputs[0]
 *
 * Pricing (per WaveSpeedAI's model page):
 *   medium quality : $0.09 / run
 *   high   quality : $0.23 / run  (Polish-23 default — the operator
 *                                  explicitly requested `high` per
 *                                  BCH's "hyper hyper realistic"
 *                                  requirement; the 15c premium buys
 *                                  the locked-character-detail
 *                                  advantage over medium)
 *
 * verifyKey: submit an obviously-malformed body ({}) and read 401/403
 * vs any body-level 4xx to distinguish bad key from bad payload —
 * same pattern the Arcads / Creatify BYOK verify paths use since no
 * cheap "who am I" endpoint is documented.
 */

const WAVESPEED_BASE = 'https://api.wavespeed.ai/api/v3';
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type WavespeedQuality = 'medium' | 'high';

export interface WavespeedSoulSubmitInput {
  userId: string;
  apiKey: string;
  /**
   * Higgsfield Soul prompt text. Polish-23 Commit 3's worker will
   * feed the Polish-21.0.7 Linda-pattern text composed by
   * `composeHiggsfieldSoulReferencePrompt` (see
   * ./higgsfield-soul-prompt.ts).
   */
  prompt: string;
  /**
   * Public URL of the input seed image. Polish-23 seeds with a
   * Nano Banana 2 base image; a fallback path can seed with any
   * public HTTP(S) image URL.
   */
  image: string;
  /**
   * Image dimensions. WaveSpeedAI accepts `WIDTH*HEIGHT` — the
   * Polish-23 default is 1152*2048 (9:16 vertical UGC).
   */
  size?: string;
  /**
   * Polish-23 default: `high`. Medium is 15c cheaper but drops
   * enough detail on hair / clothing / setting that per-clip Veo
   * character drift becomes measurably worse (per BCH's in-market
   * pipeline notes referenced during the Polish-23 pivot).
   */
  quality?: WavespeedQuality;
  /** Transform strength (0-1). Higher = looser transform, further from seed. */
  strength?: number;
  /** Optional style modifier ('Creatures', 'Cinematic', etc.). */
  style?: string;
  /** Deterministic seed. Same seed + same input = same output (batch reproducibility). */
  seed?: number;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface WavespeedSoulSubmitResult {
  ok: boolean;
  /** WaveSpeedAI prediction id — used to poll for the output URL. */
  predictionId?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface WavespeedSubmitResponse {
  code?: number;
  data?: { id?: string; status?: string };
  id?: string;
  status?: string;
}

export interface WavespeedSoulPollInput {
  userId: string;
  apiKey: string;
  predictionId: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export type WavespeedPredictionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WavespeedSoulPollResult {
  ok: boolean;
  status?: WavespeedPredictionStatus;
  /** Public output URL for the transformed image (set only when status === 'completed'). */
  outputUrl?: string;
  errorMessage?: string;
  latencyMs: number;
}

interface WavespeedPredictionResponse {
  data?: {
    id?: string;
    status?: string;
    outputs?: string[];
    error?: string;
    error_message?: string;
  };
  code?: number;
  message?: string;
}

// ---------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------

/**
 * Polish-23 Commit 1: WaveSpeedAI Higgsfield Soul base price per
 * run at each quality tier. Pinned as an exported constant so
 * cost-estimation.ts and the connect card can share one source
 * of truth.
 *
 * Prices verified from wavespeed.ai/models/higgsfield/soul/image-to-image
 * during Polish-23 pre-Commit-1 investigation.
 */
export const WAVESPEED_SOUL_USD_PER_RUN = {
  medium: 0.09,
  high: 0.23,
} as const;

/**
 * Polish-23 default. Ships at `high` so operators land locked
 * character detail out of the box. Cost-estimation reads from
 * this constant so a future tier swap propagates through the
 * estimator without a hunt-and-replace.
 */
export const WAVESPEED_SOUL_DEFAULT_QUALITY: WavespeedQuality = 'high';

export function estimateWavespeedSoulCostUsd(quality: WavespeedQuality): number {
  return WAVESPEED_SOUL_USD_PER_RUN[quality];
}

// ---------------------------------------------------------------------
// Submit — POST /higgsfield/soul/image-to-image
// ---------------------------------------------------------------------

export async function submitWavespeedSoul(
  input: WavespeedSoulSubmitInput,
): Promise<WavespeedSoulSubmitResult> {
  const quality = input.quality ?? WAVESPEED_SOUL_DEFAULT_QUALITY;
  const size = input.size ?? '1152*2048';
  const url = `${WAVESPEED_BASE}/higgsfield/soul/image-to-image`;

  // Wire body — lowercase-with-underscores field names as
  // WaveSpeedAI documents them. Optional fields dropped when the
  // caller doesn't set them so the wire payload stays minimal.
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.image,
    size,
    quality,
  };
  if (typeof input.strength === 'number') body['strength'] = input.strength;
  if (typeof input.style === 'string' && input.style.length > 0) body['style'] = input.style;
  if (typeof input.seed === 'number' && Number.isFinite(input.seed)) body['seed'] = input.seed;

  const result = await callProvider<WavespeedSubmitResponse>({
    userId: input.userId,
    provider: 'wavespeed_ai',
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      prompt_chars: input.prompt.length,
      image: input.image,
      size,
      quality,
      strength: input.strength ?? '(default)',
      style: input.style ?? '(none)',
      seed: input.seed ?? '(none)',
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateWavespeedErrorStatus(result.status, result.errorMessage),
    };
  }

  // WaveSpeedAI wraps its payload under `data.*`, but some model
  // endpoints return the id at the top level. Accept both shapes.
  const predictionId = result.data.data?.id ?? result.data.id;
  if (!predictionId || typeof predictionId !== 'string') {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage:
        'WaveSpeedAI submit response is missing the prediction id (expected data.id or top-level id).',
    };
  }
  return { ok: true, predictionId, latencyMs: result.latencyMs };
}

// ---------------------------------------------------------------------
// Poll — GET /predictions/{id}/result
// ---------------------------------------------------------------------

export async function pollWavespeedSoul(
  input: WavespeedSoulPollInput,
): Promise<WavespeedSoulPollResult> {
  const url = `${WAVESPEED_BASE}/predictions/${encodeURIComponent(input.predictionId)}/result`;
  const result = await callProvider<WavespeedPredictionResponse>({
    userId: input.userId,
    provider: 'wavespeed_ai',
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    timeoutMs: POLL_TIMEOUT_MS,
    requestBodyForLog: { prediction_id: input.predictionId },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateWavespeedErrorStatus(result.status, result.errorMessage),
    };
  }
  const data = result.data.data ?? {};
  const status = normalizeWavespeedStatus(data.status);
  // Polish-23 Commit 3.0.31: loud-log raw + interpreted status on
  // EVERY poll so any future new WaveSpeedAI state surfaces on the
  // FIRST failure rather than after N production runs. Grep-friendly
  // single line for Vercel Runtime Logs.
  console.log(
    `[wavespeed] poll predictionId=${input.predictionId} ` +
      `rawStatus=${JSON.stringify(data.status ?? null)} interpreted=${status ?? 'unknown'}`,
  );
  if (!status) {
    console.error(
      `[wavespeed] UNKNOWN status ${JSON.stringify(data.status)} — add to normalizeWavespeedStatus. ` +
        `predictionId=${input.predictionId} body=${JSON.stringify(result.data).slice(0, 800)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: `WaveSpeedAI poll response missing status (got ${JSON.stringify(
        data.status,
      )}).`,
    };
  }
  if (status === 'failed' || status === 'cancelled') {
    return {
      ok: true,
      status,
      latencyMs: result.latencyMs,
      errorMessage:
        data.error_message ?? data.error ?? `WaveSpeedAI prediction ${status} without a message.`,
    };
  }
  if (status === 'completed') {
    const outputUrl = data.outputs?.[0];
    if (!outputUrl || typeof outputUrl !== 'string') {
      return {
        ok: true,
        status,
        latencyMs: result.latencyMs,
        errorMessage:
          'WaveSpeedAI prediction completed but the response is missing data.outputs[0].',
      };
    }
    return { ok: true, status, outputUrl, latencyMs: result.latencyMs };
  }
  return { ok: true, status, latencyMs: result.latencyMs };
}

/**
 * Normalize the raw WaveSpeedAI status string to the typed enum.
 * Guards against future case-changes or aliases the platform might
 * introduce — an unrecognized value returns undefined so the caller
 * can surface it as a diagnostic rather than silently degrade.
 *
 * Polish-23 Commit 3.0.31: added "created" (+ "starting" /
 * "initializing" / "in_queue" defensive variants) to the queued
 * bucket. Real production failure: WaveSpeedAI returned status
 * "created" on a fresh submit poll, our parser returned undefined,
 * caller threw "missing status (got 'created')" as terminal, Step
 * B failed the whole job on what was really a queue-not-started-yet
 * state. Same class of bug as Commit 3.0.21's kie.ai successFlag=3.
 */
export function normalizeWavespeedStatus(raw: unknown): WavespeedPredictionStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.toLowerCase();
  if (
    lower === 'queued' ||
    lower === 'pending' ||
    lower === 'created' ||
    lower === 'starting' ||
    lower === 'initializing' ||
    lower === 'in_queue'
  ) {
    return 'queued';
  }
  if (lower === 'processing' || lower === 'running' || lower === 'in_progress') return 'processing';
  if (lower === 'completed' || lower === 'complete' || lower === 'succeeded') return 'completed';
  if (lower === 'failed' || lower === 'error' || lower === 'failure') return 'failed';
  if (lower === 'cancelled' || lower === 'canceled') return 'cancelled';
  return undefined;
}

// ---------------------------------------------------------------------
// Key verification — used by the BYOK connect card
// ---------------------------------------------------------------------

export async function verifyWavespeedKey(
  apiKey: string,
): Promise<
  | { ok: true; method: 'api'; statusCode: number }
  | { ok: false; method: 'api'; reason: string; statusCode?: number }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    // WaveSpeedAI doesn't publish a cheap "who am I" auth check, so
    // we POST a deliberately-malformed submit and read the status
    // code. 401/403 = bad key. Any other 2xx / 4xx (except 401/403)
    // means the auth layer accepted the key — body-level rejection
    // on the {} payload is expected and fine. 5xx = upstream error.
    const res = await fetch(`${WAVESPEED_BASE}/higgsfield/soul/image-to-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const status = res.status;
    if (status === 401 || status === 403) {
      return {
        ok: false,
        method: 'api',
        reason: 'WaveSpeedAI rejected the key. Re-paste from https://wavespeed.ai/dashboard.',
        statusCode: status,
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        method: 'api',
        reason: `WaveSpeedAI returned an upstream error (HTTP ${status}). Retry in a few seconds.`,
        statusCode: status,
      };
    }
    return { ok: true, method: 'api', statusCode: status };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const reason = isAbort
      ? `WaveSpeedAI verify timed out after ${VERIFY_TIMEOUT_MS}ms.`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, method: 'api', reason };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------

/**
 * Polish-23 Commit 3.0.29: WaveSpeedAI transient-error keyword list.
 * Mirrors the kie.ai treatment from Commit 3.0.22 — case-insensitive
 * substring match on errorMessage. If a WaveSpeedAI failure carries
 * ANY of these substrings, the caller SHOULD auto-retry rather than
 * fire NonRetriableError. Zombie job 9052426d 502'd on the initial
 * Higgsfield Soul submit and Inngest kept the job stuck 'processing'
 * while it scheduled its function-level retry; the fix is to catch
 * those transients inside Step B and either succeed on retry or
 * throw NonRetriable early.
 *
 * Kept EXPORTED so tests + operator SQL know the exact surface.
 */
export const WAVESPEED_TRANSIENT_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  'upstream error',
  'timeout',
  // "temporar" covers both "temporary" and "temporarily" (as in
  // "Service Temporarily Unavailable") in a single substring match.
  'temporar',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'try again',
  // Polish-23 Commit 3.0.31: unknown-status responses are treated
  // as transient so a future WaveSpeedAI queue state we haven't
  // seen yet ("initialized", "warming_up", etc.) loops until it
  // resolves rather than failing the whole job on first sight.
  // The loud-log in pollWavespeedSoul still surfaces the raw
  // status so the operator can add it to normalizeWavespeedStatus.
  'missing status',
];

export function isWavespeedTransientError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return false;
  const lower = errorMessage.toLowerCase();
  return WAVESPEED_TRANSIENT_ERROR_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

export function translateWavespeedErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `WaveSpeedAI validation failed${fallback ? `: ${fallback}` : ' (check inputs)'}.`;
  if (status === 401 || status === 403)
    return 'WaveSpeedAI authentication failed. Re-paste your key at /connections/ai-provider.';
  if (status === 402)
    return 'Insufficient WaveSpeedAI credits. Top up at https://wavespeed.ai/dashboard.';
  if (status === 404) return `WaveSpeedAI resource not found${fallback ? `: ${fallback}` : ''}.`;
  if (status === 422)
    return `WaveSpeedAI parameter validation failed${fallback ? `: ${fallback}` : ''}.`;
  if (status === 429) return 'WaveSpeedAI rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `WaveSpeedAI upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `WaveSpeedAI request failed${status ? ` (status ${status})` : ''}.`;
}
