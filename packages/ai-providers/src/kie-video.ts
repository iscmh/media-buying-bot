import { callProvider } from './chokepoint';
import type { ModelProviderConfig } from '@mbb/shared';

/**
 * Polish-20 Commit 2: generic kie.ai video-generation client.
 *
 * Drives Seedance 1.5 Pro, Kling 3.0 Standard, and Seedance 2 (and
 * every future kie.ai video model) from ONE codepath by reading the
 * ModelProviderConfig descriptor's `inputShape` block. The field
 * NAMES vary across models (input_urls / image_urls /
 * reference_image_urls; generate_audio / sound) and the duration
 * WIRE FORMAT varies (Kling wants a STRING enum; Seedance wants a
 * number). The config-driven serializer here folds all of that into
 * one descriptor-lookup.
 *
 * Endpoints (verified against kie.ai docs, Polish-20 investigation):
 *   - POST /api/v1/jobs/createTask           — submit
 *   - GET  /api/v1/jobs/recordInfo?taskId=…  — poll status + resultJson
 *
 * Auth: `Authorization: Bearer <apiKey>` (same header as kie-omni).
 *
 * Polling: kie.ai wraps every response in { code, msg, data }. The
 * poll response's `data.resultJson` is a JSON STRING that must be
 * JSON.parse()d to reach `resultUrls[0]`. Same shape as kie-omni.ts
 * — parseResultJsonOutputUrl() is intentionally identical.
 *
 * Retry: rate-limit responses (HTTP 429 or kie code 429) route
 * through the shared retry-with-backoff pattern from Polish-19.4.3
 * (adapted for kie.ai's response shape). Non-rate-limit failures
 * (validation, auth, model-not-found, upstream 5xx) return
 * immediately.
 *
 * First-live diagnostic: loud-logs the FULL response body on the
 * FIRST call per (model, provider) tuple so first live drift
 * surfaces in Inngest logs without a redeploy.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
const SUBMIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;

// -------------------------------------------------------------------
// Rate-limit retry primitives (Polish-19.4.3 pattern, kie.ai-adapted)
// -------------------------------------------------------------------

export const KIE_VIDEO_DEFAULT_RATE_LIMIT_MAX_RETRIES = 5;

export function computeKieVideoRateLimitBackoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return 10_000;
  const raw = 10_000 * Math.pow(2, attempt);
  return Math.min(60_000, raw);
}

export function getKieVideoRateLimitMaxRetries(): number {
  const raw = process.env.KIE_VIDEO_RATE_LIMIT_MAX_RETRIES?.trim();
  if (!raw) return KIE_VIDEO_DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    console.log(
      `[kie-video] ignoring KIE_VIDEO_RATE_LIMIT_MAX_RETRIES=${JSON.stringify(raw)} — ` +
        `not a non-negative integer; falling back to default (${KIE_VIDEO_DEFAULT_RATE_LIMIT_MAX_RETRIES}).`,
    );
    return KIE_VIDEO_DEFAULT_RATE_LIMIT_MAX_RETRIES;
  }
  return n;
}

/**
 * kie.ai rate-limit surfaces:
 *   - HTTP 429 on the transport
 *   - `{code: 429}` in the wrapped body
 *   - message substrings "rate limit" / "quota exceeded" (defensive)
 */
export function detectKieVideoRateLimit(
  status: number | undefined,
  kieCode: number | undefined,
  errorMessage: string | undefined,
): boolean {
  if (status === 429) return true;
  if (kieCode === 429) return true;
  if (typeof errorMessage === 'string') {
    const lower = errorMessage.toLowerCase();
    if (lower.includes('rate limit')) return true;
    if (lower.includes('quota exceeded')) return true;
    if (lower.includes('too many requests')) return true;
  }
  return false;
}

// Swappable-impl sleep for testable retry loops (Polish-19.4.3 pattern).
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setKieVideoSleepImplForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

export function __restoreKieVideoSleepImplForTests(): void {
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------
// Submit
// -------------------------------------------------------------------

export interface KieVideoSubmitInput {
  userId: string;
  apiKey: string;
  config: ModelProviderConfig;
  /** Self-contained ad prompt (see Polish-19.4.2 engineering). */
  prompt: string;
  /** Clamped to model's per-call min/max by the caller. */
  durationSeconds: number;
  /** Defaults to '9:16' (UGC selfie). */
  aspectRatio?: '16:9' | '9:16' | '1:1';
  /** Enable native audio generation. Defaults to true. */
  audio?: boolean;
  /** Optional reference / first-frame image URLs (0-N per model). */
  imageUrls?: string[];
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieVideoSubmitResult {
  ok: boolean;
  taskId?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface KieResponseShape {
  code?: number;
  msg?: string;
  data?: { taskId?: string; task_id?: string };
}

/**
 * Polish-20 Commit 2: submit a kie.ai video generation. Serializes
 * the input body per config.inputShape, then routes through the
 * shared retry-with-backoff wrapper for rate-limit resilience.
 */
export async function submitKieVideo(input: KieVideoSubmitInput): Promise<KieVideoSubmitResult> {
  return retryKieVideoSubmit('submit', () => submitKieVideoOnce(input));
}

async function submitKieVideoOnce(input: KieVideoSubmitInput): Promise<KieVideoSubmitResult> {
  const { config } = input;
  const shape = config.inputShape;
  const modelParam = getKieVideoModelIdOverride(config.modelParam);

  // Per-config field-name serialization. Kling wants duration as a
  // STRING enum; Seedance wants a number. Audio flag is `sound` on
  // Kling, `generate_audio` on Seedance. Image field name varies too.
  const inputBody: Record<string, unknown> = {};
  inputBody[shape.promptField] = input.prompt;
  inputBody[shape.aspectRatioField] = input.aspectRatio ?? '9:16';
  inputBody[shape.durationField] =
    shape.durationFormat === 'string'
      ? String(Math.round(input.durationSeconds))
      : Math.round(input.durationSeconds);
  inputBody[shape.audioField] = input.audio ?? true;
  if (input.imageUrls && input.imageUrls.length > 0 && shape.imageField) {
    inputBody[shape.imageField] = input.imageUrls;
  }
  if (shape.extras) {
    // Merge hardcoded per-model extras (fixed_lens/mode/multi_shots/
    // resolution). Explicit fields set above still win over extras
    // when they collide.
    for (const [k, v] of Object.entries(shape.extras)) {
      if (!(k in inputBody)) inputBody[k] = v;
    }
  }

  const body = { model: modelParam, input: inputBody };
  logFirstResponseIfFirstCall('submit', config.modelId, body);

  const result = await callProvider<KieResponseShape>({
    userId: input.userId,
    provider: 'kie_ai',
    url: config.endpointUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    requestBodyForLog: {
      model: modelParam,
      model_id: config.modelId,
      provider_id: config.providerId,
      prompt_chars: input.prompt.length,
      duration_wire: inputBody[shape.durationField],
      duration_format: shape.durationFormat,
      aspect_ratio: inputBody[shape.aspectRatioField],
      audio_field: shape.audioField,
      audio_value: inputBody[shape.audioField],
      image_field: shape.imageField ?? '(none)',
      image_count: input.imageUrls?.length ?? 0,
      extras_keys: shape.extras ? Object.keys(shape.extras) : [],
    },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });

  if (!result.ok) {
    console.log(
      `[kie-video] submit transport failure: model=${config.modelId} ` +
        `provider=${config.providerId} status=${result.status} ` +
        `err=${result.errorMessage ?? 'unknown'}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVideoErrorStatus(result.status, result.errorMessage),
    };
  }
  const code = result.data.code;
  if (code !== undefined && code !== 200) {
    console.log(
      `[kie-video] submit soft failure: model=${config.modelId} code=${code} ` +
        `msg=${result.data.msg ?? 'unknown'} body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVideoErrorStatus(code, result.data.msg),
    };
  }
  const taskId = result.data.data?.taskId ?? result.data.data?.task_id;
  if (!taskId) {
    console.log(
      `[kie-video] submit succeeded but missing taskId; body=${JSON.stringify(result.data).slice(0, 1500)}`,
    );
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai createTask response missing taskId',
    };
  }
  return { ok: true, taskId, latencyMs: result.latencyMs };
}

// -------------------------------------------------------------------
// Poll
// -------------------------------------------------------------------

export type KieVideoState = 'waiting' | 'success' | 'fail';

export interface KieVideoPollInput {
  userId: string;
  apiKey: string;
  taskId: string;
  /** Model id for log tagging; not sent to kie.ai (recordInfo takes only taskId). */
  modelId?: string;
  generationJobId?: string;
  generatedCreativeId?: string;
}

export interface KieVideoPollResult {
  ok: boolean;
  state?: KieVideoState;
  outputUrl?: string;
  failCode?: string;
  failMsg?: string;
  costTimeMs?: number;
  latencyMs: number;
  errorMessage?: string;
}

interface KiePollResponseShape {
  code?: number;
  msg?: string;
  data?: {
    taskId?: string;
    state?: KieVideoState;
    resultJson?: string | null;
    failCode?: string | null;
    failMsg?: string | null;
    costTime?: number | null;
  };
}

export async function pollKieVideo(input: KieVideoPollInput): Promise<KieVideoPollResult> {
  const url = `${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(input.taskId)}`;
  const result = await callProvider<KiePollResponseShape>({
    userId: input.userId,
    provider: 'kie_ai',
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    timeoutMs: CHECK_TIMEOUT_MS,
    requestBodyForLog: { taskId: input.taskId, model_id: input.modelId ?? '(unknown)' },
    generationJobId: input.generationJobId,
    generatedCreativeId: input.generatedCreativeId,
  });
  if (!result.ok) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVideoErrorStatus(result.status, result.errorMessage),
    };
  }
  const code = result.data.code;
  if (code !== undefined && code !== 200) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: translateKieVideoErrorStatus(code, result.data.msg),
    };
  }
  const data = result.data.data;
  const state = data?.state;
  if (!state) {
    return {
      ok: false,
      latencyMs: result.latencyMs,
      errorMessage: 'kie.ai recordInfo missing state field',
    };
  }
  if (state === 'fail') {
    return {
      ok: true,
      state,
      failCode: data.failCode ?? undefined,
      failMsg: data.failMsg ?? undefined,
      latencyMs: result.latencyMs,
    };
  }
  if (state === 'success') {
    const outputUrl = parseResultJsonOutputUrl(data.resultJson);
    if (!outputUrl) {
      console.log(
        `[kie-video] poll done but no outputUrl; taskId=${input.taskId} ` +
          `body=${JSON.stringify(result.data).slice(0, 2000)}`,
      );
      return {
        ok: true,
        state,
        latencyMs: result.latencyMs,
        errorMessage: 'kie.ai reported success but resultJson missing / malformed',
      };
    }
    return {
      ok: true,
      state,
      outputUrl,
      costTimeMs: data.costTime ?? undefined,
      latencyMs: result.latencyMs,
    };
  }
  // state === 'waiting'
  return { ok: true, state, latencyMs: result.latencyMs };
}

/**
 * kie.ai's `resultJson` is a JSON STRING. Parse it to reach the first
 * URL. Handles null / malformed input defensively.
 */
export function parseResultJsonOutputUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { resultUrls?: unknown };
    const urls = parsed.resultUrls;
    if (Array.isArray(urls) && typeof urls[0] === 'string' && urls[0].length > 0) {
      return urls[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// -------------------------------------------------------------------
// Error translation + env override
// -------------------------------------------------------------------

export function translateKieVideoErrorStatus(
  status: number | undefined,
  fallback: string | undefined,
): string {
  if (status === 400)
    return `kie.ai validation failed${fallback ? `: ${fallback}` : ' (check prompt + inputs)'}.`;
  if (status === 401)
    return 'kie.ai authentication failed. Re-paste your key at /connections/tools.';
  if (status === 402) return 'Insufficient kie.ai balance. Top up at kie.ai/api-key.';
  if (status === 404) return `kie.ai resource not found${fallback ? `: ${fallback}` : ''}.`;
  if (status === 422)
    return `kie.ai parameter validation failed${fallback ? `: ${fallback}` : ''}.`;
  if (status === 429) return 'kie.ai rate limit hit. Retry in a few seconds.';
  if (typeof status === 'number' && status >= 500)
    return `kie.ai upstream error (HTTP ${status}${fallback ? `: ${fallback}` : ''}).`;
  return fallback ?? `kie.ai request failed${status ? ` (status ${status})` : ''}.`;
}

/**
 * Polish-20: env override for the config's `modelParam` string —
 * mirror of the Polish-19.2.2 VEO_MODEL_ID hatch. If kie.ai revs a
 * model identifier, the operator flips the env without a redeploy.
 * Env var name: KIE_MODEL_ID_OVERRIDE_<UPPER_SNAKE_MODEL_ID>.
 *
 * e.g. KIE_MODEL_ID_OVERRIDE_BYTEDANCE_SEEDANCE_1_5_PRO='bytedance/seedance-pro-v2'
 */
export function getKieVideoModelIdOverride(defaultModelParam: string): string {
  const envKey =
    'KIE_MODEL_ID_OVERRIDE_' + defaultModelParam.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : defaultModelParam;
}

// -------------------------------------------------------------------
// Retry wrapper + first-call diagnostic
// -------------------------------------------------------------------

async function retryKieVideoSubmit<T extends KieVideoSubmitResult>(
  label: 'submit',
  makeCall: () => Promise<T>,
): Promise<T> {
  const maxRetries = getKieVideoRateLimitMaxRetries();
  let last: T | undefined;
  let totalWaitMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await makeCall();
    if (r.ok) return r;
    // The submitOnce translator wraps 429 into "kie.ai rate limit hit"
    // — detect on that substring since we've discarded the raw code
    // by this layer.
    const rateLimited = detectKieVideoRateLimit(undefined, undefined, r.errorMessage);
    if (!rateLimited) return r;
    last = r;
    if (attempt === maxRetries) break;
    const backoffMs = computeKieVideoRateLimitBackoffMs(attempt);
    totalWaitMs += backoffMs;
    console.log(
      `[kie-video-${label}] rate-limit hit on attempt ${attempt + 1}/${maxRetries + 1}, ` +
        `backing off ${Math.round(backoffMs / 1000)}s before retry ` +
        `(err: ${r.errorMessage ?? 'unknown'})`,
    );
    await sleepImpl(backoffMs);
  }
  const totalWaitSec = Math.round(totalWaitMs / 1000);
  const lastMsg = last?.errorMessage ?? 'unknown';
  return {
    ...(last as T),
    ok: false,
    errorMessage:
      `kie.ai rate limit hit after ${maxRetries + 1} attempts over ~${totalWaitSec}s. ` +
      `Last error: ${lastMsg}. Consider raising KIE_VIDEO_RATE_LIMIT_MAX_RETRIES ` +
      `or reducing concurrent variants.`,
  };
}

/**
 * First-call diagnostic. Loud-logs the FULL request body on the
 * first invocation per (call-kind, model) tuple so first live drift
 * (a Kling required field we missed, a Seedance renamed param)
 * surfaces in Inngest logs without a redeploy. Suppressed after the
 * first call to keep the log volume sane.
 */
const _firstCallLogged = new Set<string>();
function logFirstResponseIfFirstCall(
  kind: string,
  modelId: string,
  body: { model: string; input: Record<string, unknown> },
): void {
  const key = `${kind}:${modelId}`;
  if (_firstCallLogged.has(key)) return;
  _firstCallLogged.add(key);
  console.log(
    `[kie-video] first-${kind} for model=${modelId}: full body=${JSON.stringify(body).slice(0, 2000)}`,
  );
}

/** TEST-ONLY: clear the first-call log memoization. */
export function __resetKieVideoFirstCallLogForTests(): void {
  _firstCallLogged.clear();
}
